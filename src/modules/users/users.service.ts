import { prisma } from '../../db/prisma.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { paginationMeta } from '../../utils/pagination.js';
import { Errors } from '../../utils/AppError.js';
import { toMoneyString } from '../../utils/money.js';
import { getAvailableBalance } from '../withdrawals/withdrawals.service.js';

export async function getMe(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return {
    id: user.id,
    phone: user.phone,
    phoneVerified: user.phoneVerified,
    name: user.name,
    role: 'USER',
    status: user.status,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    defaultPayoutMethod: user.defaultPayoutMethod,
    defaultUpiId: user.defaultUpiId,
    defaultMobileNumber: user.defaultMobileNumber,
    notifyRewards: user.notifyRewards,
    notifyCampaigns: user.notifyCampaigns,
    notifyAccount: user.notifyAccount,
  };
}

export async function updateMe(userId: string, input: { name: string }) {
  const user = await prisma.user.update({ where: { id: userId }, data: { name: input.name } });
  return { id: user.id, name: user.name };
}

export async function updateMyPayoutDefaults(
  userId: string,
  input: { defaultPayoutMethod: 'UPI' | 'MOBILE'; defaultUpiId?: string; defaultMobileNumber?: string },
) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      defaultPayoutMethod: input.defaultPayoutMethod,
      defaultUpiId: input.defaultPayoutMethod === 'UPI' ? input.defaultUpiId : null,
      defaultMobileNumber: input.defaultPayoutMethod === 'MOBILE' ? input.defaultMobileNumber : null,
    },
  });
  return { defaultPayoutMethod: user.defaultPayoutMethod, defaultUpiId: user.defaultUpiId, defaultMobileNumber: user.defaultMobileNumber };
}

export async function updateMyNotificationPreferences(
  userId: string,
  input: { notifyRewards?: boolean; notifyCampaigns?: boolean; notifyAccount?: boolean },
) {
  const user = await prisma.user.update({ where: { id: userId }, data: input });
  return { notifyRewards: user.notifyRewards, notifyCampaigns: user.notifyCampaigns, notifyAccount: user.notifyAccount };
}

// Ionic "Manage Devices" page (spec module-completion phase) - lists this
// user's non-revoked, non-expired sessions from the same RefreshToken table
// login/refresh/logout already write to, rather than a parallel "session"
// model.
export async function listMySessions(userId: string) {
  const sessions = await prisma.refreshToken.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, deviceId: true, platform: true, appVersion: true, createdAt: true, expiresAt: true },
  });
  return sessions;
}

// Ownership-scoped (userId in the where clause) so a user can only ever
// revoke their own session, never guess another user's session id.
export async function revokeMySession(userId: string, sessionId: string) {
  const result = await prisma.refreshToken.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (result.count === 0) throw Errors.notFound('Session');
}

export async function getMyWallet(userId: string) {
  const [wallet, earnedAgg, withdrawnAgg, activeTasks, sourceBreakdown, withdrawable] = await Promise.all([
    prisma.userWallet.findUnique({ where: { userId } }),
    // Lifetime earned, not just the current balance - the two diverge once
    // withdrawals/debits exist, so this is a real aggregate, not a re-read
    // of balance (spec Phase 6 §13: "Total Earned" alongside "Available
    // Balance").
    prisma.walletTransaction.aggregate({ where: { userId, type: 'EARN' }, _sum: { amount: true } }),
    // Lifetime completed withdrawals (spec Phase 8 §4) - WITHDRAWAL
    // transactions are stored with a negative amount (spec Phase 7 §13/§14),
    // so this sum comes back negative and is flipped for display.
    prisma.walletTransaction.aggregate({ where: { userId, type: 'WITHDRAWAL' }, _sum: { amount: true } }),
    prisma.userTaskCompletion.count({ where: { userId, status: 'STARTED' } }),
    // Reward-source breakdown (Master Direction spec §5/§7) - groups the
    // same EARN transactions above by referenceType rather than a parallel
    // per-source ledger, so "Game Rewards" / "Campaign Rewards" / "Referral
    // Rewards" can never drift out of sync with totalEarned.
    prisma.walletTransaction.groupBy({ by: ['referenceType'], where: { userId, type: 'EARN' }, _sum: { amount: true } }),
    // Reuses withdrawals.service.ts's existing balance-minus-in-flight-
    // withdrawals calculation rather than re-deriving it (spec §7's
    // "Withdrawable Balance" is exactly that same number).
    getAvailableBalance(userId),
  ]);
  if (!wallet) throw Errors.notFound('Wallet');

  const bySource = new Map<string, Prisma.Decimal>();
  for (const row of sourceBreakdown) bySource.set(row.referenceType ?? 'OTHER', new Prisma.Decimal(row._sum.amount ?? 0));
  const zero = new Prisma.Decimal(0);
  const gameRewards = bySource.get('GAME_CONVERSION') ?? zero;
  const campaignRewards = bySource.get('TASK_COMPLETION') ?? zero;
  // Covers both sides of a referral: REFERRAL_REWARD (the referrer's cut)
  // and REFERRAL_BONUS (the referred/joining user's own bonus) - the same
  // user could in principle appear on either side over their lifetime.
  const referralRewards = (bySource.get('REFERRAL_REWARD') ?? zero).plus(bySource.get('REFERRAL_BONUS') ?? zero);
  const totalEarned = new Prisma.Decimal(earnedAgg._sum.amount ?? 0);
  const otherRewards = totalEarned.minus(gameRewards).minus(campaignRewards).minus(referralRewards);

  return {
    ...wallet,
    balance: toMoneyString(wallet.balance),
    totalEarned: toMoneyString(totalEarned),
    totalWithdrawn: toMoneyString(withdrawnAgg._sum.amount?.negated() ?? 0),
    activeTasks,
    rewardsBySource: {
      gameRewards: toMoneyString(gameRewards),
      campaignRewards: toMoneyString(campaignRewards),
      referralRewards: toMoneyString(referralRewards),
      otherRewards: toMoneyString(otherRewards),
    },
    withdrawableBalance: withdrawable.available,
  };
}

export async function getMyWalletTransactions(userId: string, params: { page: number; pageSize: number }) {
  const where = { userId };
  const [rows, total] = await Promise.all([
    prisma.walletTransaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.walletTransaction.count({ where }),
  ]);
  const data = rows.map((t) => ({ ...t, amount: toMoneyString(t.amount) }));
  return { data, page: params.page, pageSize: params.pageSize, total, pagination: paginationMeta(params.page, params.pageSize, total) };
}

// Doubles as both "My Tasks" (task history, spec Phase 6 §15) and "Reward
// History" (§14) - the same underlying record (a completion attempt) is
// what both views are showing, just with different framing, so one
// endpoint serves both rather than building two near-duplicate ones.
export async function getMyCampaignHistory(userId: string, params: { page: number; pageSize: number; status?: string }) {
  const where = { userId, ...(params.status ? { status: params.status as any } : {}) };
  const [rows, total] = await Promise.all([
    prisma.userTaskCompletion.findMany({
      where,
      include: {
        task: { select: { title: true } },
        campaign: { select: { campaignName: true, campaignType: { select: { code: true, name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.userTaskCompletion.count({ where }),
  ]);

  const data = rows.map((r) => ({
    id: r.id,
    campaignName: r.campaign.campaignName,
    campaignType: r.campaign.campaignType,
    taskTitle: r.task.title,
    rewardAmount: r.rewardAmount != null ? toMoneyString(r.rewardAmount) : null,
    status: r.status,
    date: r.completedAt ?? r.submittedAt ?? r.startedAt,
  }));

  return { data, page: params.page, pageSize: params.pageSize, total, pagination: paginationMeta(params.page, params.pageSize, total) };
}

export async function getMyEarnings(userId: string, params: { page: number; pageSize: number }) {
  const where = { userId, type: 'EARN' as const };
  const [rows, total] = await Promise.all([
    prisma.walletTransaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.walletTransaction.count({ where }),
  ]);
  const data = rows.map((t) => ({ ...t, amount: toMoneyString(t.amount) }));
  return { data, page: params.page, pageSize: params.pageSize, total, pagination: paginationMeta(params.page, params.pageSize, total) };
}

// Permanently deletes the authenticated user's account and every piece of
// data they own. The Prisma schema's onDelete: Cascade handles most related
// rows automatically when the User row is deleted; OtpVerification is keyed
// by phone (no userId FK) so it's cleaned up explicitly first.
// AuditLog / AdEvent use onDelete: SetNull, so the audit trail survives the
// deletion (userId becomes null on those rows - useful for admin forensics).
// The audit log entry itself is written before deletion so the userId is
// captured; Postgres then nulls it when the user row disappears.
export async function deleteMyAccount(userId: string): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, phone: true, role: { select: { code: true } } },
  });

  // Write the audit entry first - it captures userId before the cascade
  // nulls it out, giving admins a permanent record of who deleted what.
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: 'ACCOUNT_DELETED',
      entityType: 'users',
      entityId: user.id,
      metadata: { selfDeleted: true },
    },
  });

  // OtpVerification rows are keyed by phone, not userId - clean them up
  // before deleting the user so no orphaned OTP records remain.
  if (user.phone) {
    await prisma.otpVerification.deleteMany({ where: { phone: user.phone } });
  }

  // Deleting the User row triggers Prisma/Postgres cascade deletes on:
  //   RefreshToken, UserWallet, WalletTransaction, UserTaskCompletion,
  //   YouTubeTaskVerification (via completion cascade), Withdrawal,
  //   Notification, DeviceToken, GameCoinConversion, Referral (both sides),
  //   SupportTicket (raised by user), GoogleAccountConnection,
  //   YouTubeConnection (via GoogleAccountConnection cascade).
  // AuditLog and AdEvent are SetNull, so they're preserved for admin forensics.
  await prisma.user.delete({ where: { id: userId } });
}

