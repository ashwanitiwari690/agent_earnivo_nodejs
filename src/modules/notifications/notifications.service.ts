import { prisma } from '../../db/prisma.js';
import { paginationMeta } from '../../utils/pagination.js';
import { sendPush } from '../../services/push.service.js';
import { getTokensForUsers, pruneInvalidTokens } from './device-tokens.service.js';
import { emitNotificationToRole, emitNotificationToUser } from '../../realtime/socket.service.js';

export interface CreateNotificationInput {
  userId: string;
  type: string;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
}

// Categorizes a Notification.type into the 3 preference toggles the Ionic
// "Notification Settings" page exposes (spec module-completion phase).
// Anything not explicitly listed here defaults to "account" and always
// delivers - fail-open, so a type nobody has categorized yet is never
// silently dropped.
const REWARD_TYPES = new Set([
  'REWARD_CREDITED',
  'REFERRAL_REWARDED',
  'REFERRAL_BONUS',
  'WITHDRAWAL_SUBMITTED',
  'WITHDRAWAL_COMPLETED',
  'WITHDRAWAL_REJECTED',
  'GAME_REWARD_CREDITED',
  'TASK_PROOF_APPROVED',
  'TASK_PROOF_REJECTED',
]);
const CAMPAIGN_TYPES = new Set(['CAMPAIGN_APPROVED', 'CAMPAIGN_REJECTED', 'CAMPAIGN_EXPIRED', 'CAMPAIGN_PENDING_APPROVAL', 'CAMPAIGN_ACTIVE']);
// Security/account-status notifications always bypass the preference check -
// a user must never be able to accidentally silence being told their own
// account was suspended or reactivated, or miss an admin-wide announcement.
const ALWAYS_DELIVER_TYPES = new Set(['ANNOUNCEMENT', 'ACCOUNT_ACTIVATED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_STATUS_CHANGED']);

// --- Push delivery ----------------------------------------------------
//
// Push is a second channel for the notifications this module already
// records, never a parallel system: every call site below writes its
// Notification row first and then hands the same content to FCM. That
// ordering matters - the in-app list is the source of truth, so a user who
// had notifications turned off at the OS level, or whose device was
// offline past FCM's retention window, still sees everything when they
// open the app.

// FCM rejects any data value that isn't a string, so ids and amounts that
// came in as numbers or nested objects are flattened here rather than at
// each call site. Nested values are dropped instead of JSON-stringified:
// the client only ever reads scalar ids out of this to decide which screen
// to open, and a stringified object would just bloat every payload.
function toPushData(type: string, metadata?: Record<string, unknown>, notificationId?: string): Record<string, string> {
  const data: Record<string, string> = { type };
  if (notificationId) data.notificationId = notificationId;
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      data[key] = String(value);
    }
  }
  return data;
}

// Fire-and-forget by design. Every caller of createNotification() is in the
// middle of a request a user is waiting on - approving a withdrawal,
// crediting a reward - and none of them should get slower, or fail, because
// FCM is slow or misconfigured. Errors are logged and swallowed here so no
// call site needs its own try/catch.
function dispatchPush(userIds: string[], input: { type: string; title: string; message: string; metadata?: Record<string, unknown>; notificationId?: string }) {
  void (async () => {
    try {
      const tokens = await getTokensForUsers(userIds);
      if (tokens.length === 0) return;
      const result = await sendPush(tokens, {
        title: input.title,
        body: input.message,
        data: toPushData(input.type, input.metadata, input.notificationId),
      });
      await pruneInvalidTokens(result.invalidTokens);
    } catch (err) {
      console.error('[notifications.service] Push dispatch failed', {
        type: input.type,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

// Internal helper only - no route calls this directly. Every payment/
// withdrawal/subscription state change that should surface to a user calls
// this exactly once at the point the state actually changes, rather than
// each feature re-implementing its own notification-row insert.
export async function createNotification(input: CreateNotificationInput) {
  if (!ALWAYS_DELIVER_TYPES.has(input.type)) {
    const preferenceField = REWARD_TYPES.has(input.type) ? 'notifyRewards' : CAMPAIGN_TYPES.has(input.type) ? 'notifyCampaigns' : 'notifyAccount';
    const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { [preferenceField]: true } });
    if (user && (user as any)[preferenceField] === false) return null;
  }

  const notification = await prisma.notification.create({
    data: {
      userId: input.userId,
      type: input.type,
      title: input.title,
      message: input.message,
      metadata: (input.metadata ?? {}) as any,
    },
  });

  // Placed after the row exists so the push can carry its id - tapping the
  // notification opens the app on that exact item. It also means the
  // preference check above gates both channels from one place: a user who
  // muted rewards returns early and never reaches this line.
  dispatchPush([input.userId], { ...input, notificationId: notification.id });

  // Real-time delivery for the Agent/Admin panel (see realtime/socket.service.ts).
  // A no-op if that recipient is a plain USER or simply isn't connected -
  // the room just has no members and the emit goes nowhere.
  emitNotificationToUser(input.userId, {
    id: notification.id,
    userId: notification.userId,
    type: notification.type,
    title: notification.title,
    message: notification.message,
    metadata: notification.metadata as Record<string, unknown>,
    isRead: notification.isRead,
    createdAt: notification.createdAt.toISOString(),
  });

  return notification;
}

// Fans a single event out to every ADMIN-role user (spec Phase 8 §11: "New
// Agent" / "New Payment" / "New Withdrawal" / "Campaign Pending Approval").
// Admin accounts are few in this platform, so one createMany covers it -
// unlike a "notify every USER of a new campaign" broadcast, which needs
// real batching and lives in pushCampaignLive() below.
export async function notifyAdmins(input: Omit<CreateNotificationInput, 'userId'>) {
  const admins = await prisma.user.findMany({ where: { role: { code: 'ADMIN' } }, select: { id: true } });
  if (admins.length === 0) return;
  await prisma.notification.createMany({
    data: admins.map((a) => ({
      userId: a.id,
      type: input.type,
      title: input.title,
      message: input.message,
      metadata: (input.metadata ?? {}) as any,
    })),
  });

  // createMany can't return the generated ids, so admin pushes carry no
  // notificationId. The client falls back to opening the notification list
  // rather than a specific row, which is the right destination for an admin
  // alert anyway.
  dispatchPush(
    admins.map((a) => a.id),
    input,
  );

  // One event to every connected Admin at once, same reasoning as the push
  // above: no per-recipient id from createMany, so this carries no `id` and
  // the panel re-fetches its own list on receipt instead of guessing one.
  emitNotificationToRole('ADMIN', { ...input, createdAt: new Date().toISOString() });
}

export async function listMyNotifications(userId: string, params: { page: number; pageSize: number }) {
  const where = { userId };
  const [data, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId, isRead: false } }),
  ]);
  return { data, page: params.page, pageSize: params.pageSize, total, unreadCount, pagination: paginationMeta(params.page, params.pageSize, total) };
}

// "A new campaign just went live" (Ionic users), fired from
// campaigns.service.ts's activate(). Push-only, with no Notification rows
// written at all - and that asymmetry with every other function here is
// deliberate.
//
// A row per user per campaign is the one broadcast this schema genuinely
// cannot absorb: with 50k users, ten campaigns a day is half a million
// rows a day, all of them saying the same thing, all of them competing
// with the personal notifications (a reward credited, a withdrawal paid)
// that the list actually exists to show. Campaign availability is already
// discoverable in the app - it IS the Earn feed - so the push is a nudge
// toward a screen that always shows the current truth, not a record that
// needs keeping.
//
// Tokens are streamed in id-ordered pages rather than loaded at once, so
// memory stays flat regardless of how large the user base grows.
const BROADCAST_PAGE_SIZE = 500;

export async function pushCampaignLive(input: { campaignId: string; campaignName: string; rewardHint?: string }) {
  const title = 'New campaign available';
  const message = input.rewardHint
    ? `"${input.campaignName}" is live - earn ${input.rewardHint}.`
    : `"${input.campaignName}" is live. Open Earnivo to start earning.`;

  let cursor: string | undefined;
  let totalSent = 0;

  for (;;) {
    const rows = await prisma.deviceToken.findMany({
      where: {
        // Suspended accounts keep their token rows (they may be reinstated)
        // but must not be advertised to, and notifyCampaigns is the same
        // toggle the in-app Notification Settings page already writes -
        // honoured here so the switch means one thing across both channels.
        user: { status: 'ACTIVE', notifyCampaigns: true, role: { code: 'USER' } },
      },
      select: { id: true, token: true },
      orderBy: { id: 'asc' },
      take: BROADCAST_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;

    const result = await sendPush(
      rows.map((r) => r.token),
      { title, body: message, data: toPushData('CAMPAIGN_LIVE', { campaignId: input.campaignId }) },
    );
    await pruneInvalidTokens(result.invalidTokens);
    totalSent += result.sent;

    if (rows.length < BROADCAST_PAGE_SIZE) break;
    cursor = rows[rows.length - 1]!.id;
  }

  return { sent: totalSent };
}

// Admin-authored system announcements (spec Phase 11 §23) - reuses the same
// Notification table and createNotification path every other event in this
// codebase uses, rather than a parallel "announcements" system. Targeting
// is resolved to a concrete user-id list here so an admin can never send to
// a role they didn't explicitly choose.
export async function broadcastAnnouncement(input: { title: string; message: string; target: 'ALL_USERS' | 'ALL_AGENTS' | 'ALL' }) {
  const roleFilter =
    input.target === 'ALL_USERS' ? { code: 'USER' } : input.target === 'ALL_AGENTS' ? { code: 'AGENT' } : { code: { in: ['USER', 'AGENT'] } };

  const recipients = await prisma.user.findMany({ where: { role: roleFilter }, select: { id: true } });
  if (recipients.length === 0) return { recipientCount: 0 };

  await prisma.notification.createMany({
    data: recipients.map((r) => ({ userId: r.id, type: 'ANNOUNCEMENT', title: input.title, message: input.message, metadata: {} })),
  });

  // Unlike pushCampaignLive() this one does keep a row per recipient: an
  // announcement is hand-written by an admin, happens rarely, and has no
  // screen of its own to fall back on - the notification list is the only
  // place it can ever be re-read.
  dispatchPush(
    recipients.map((r) => r.id),
    { type: 'ANNOUNCEMENT', title: input.title, message: input.message },
  );

  // Recipients above can include plain USERs (target ALL_USERS/ALL), who
  // never hold a socket - only nudge the room(s) that actually correspond to
  // who was targeted. ADMIN is never a recipient of this broadcast at all
  // (see roleFilter above), so there's no role:ADMIN case to handle here.
  if (input.target === 'ALL_AGENTS' || input.target === 'ALL') {
    emitNotificationToRole('AGENT', { type: 'ANNOUNCEMENT', title: input.title, message: input.message, createdAt: new Date().toISOString() });
  }

  return { recipientCount: recipients.length };
}

export async function markNotificationRead(userId: string, id: string) {
  await prisma.notification.updateMany({ where: { id, userId }, data: { isRead: true } });
}

export async function markAllNotificationsRead(userId: string) {
  await prisma.notification.updateMany({ where: { userId, isRead: false }, data: { isRead: true } });
}
