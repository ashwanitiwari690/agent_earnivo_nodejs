import { prisma } from '../../db/prisma.js';
import { paginationMeta } from '../../utils/pagination.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { toMoneyString } from '../../utils/money.js';
import { generateReferralCode } from '../../utils/referralCode.js';
import { env } from '../../config/env.js';
import { createNotification } from '../notifications/notifications.service.js';
import { writeAuditLog } from '../audit/audit.service.js';

function referralLink(code: string): string {
  return `${env.publicWebUrl}/referral/${code}`;
}

// Codes are always generated uppercase-only (utils/referralCode.ts), but a
// referral code is manually typed by a human, so it must be normalized the
// same way at every single lookup site - send-otp validation, landing-page
// validation, and attribution at registration - or a code that validates in
// one place (e.g. typed lowercase) could silently fail to match in another.
export function normalizeReferralCode(raw: string): string {
  return raw.trim().toUpperCase();
}

// Never expose a referred user's phone/email/name in bulk-visible views
// (spec §10/§16: "Do not expose private information of referred users") -
// this is the one place that decides what "masked" means.
function maskIdentifier(user: { name: string | null; phone: string | null; email: string | null }): string {
  if (user.name) return user.name;
  if (user.phone) return `${user.phone.slice(0, 2)}${'*'.repeat(Math.max(user.phone.length - 4, 0))}${user.phone.slice(-2)}`;
  if (user.email) {
    const [local, domain] = user.email.split('@');
    return `${local.slice(0, 2)}***@${domain}`;
  }
  return 'A user';
}

export async function getOrCreateReferralCode(userId: string): Promise<string> {
  const existing = await prisma.user.findUnique({ where: { id: userId }, select: { referralCode: true } });
  if (existing?.referralCode) return existing.referralCode;

  // Astronomically unlikely to collide (32^7 combinations), but retry
  // rather than assume - a unique-constraint violation is the only way this
  // loop could otherwise fail.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateReferralCode();
    try {
      const updated = await prisma.user.update({ where: { id: userId }, data: { referralCode: code } });
      return updated.referralCode!;
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err;
    }
  }
  throw new Error('Unable to generate a unique referral code.');
}

// Public - called by the lightweight referral landing page (no auth) to
// decide what to render, and doubles as the click signal (spec §12/§17):
// one counter increment, not a stored row, keeps this endpoint cheap enough
// to be hit by anonymous traffic without any real storage-growth concern.
export async function validateReferralCode(code: string): Promise<{ valid: boolean }> {
  const user = await prisma.user.findUnique({ where: { referralCode: normalizeReferralCode(code) }, select: { id: true } });
  if (!user) return { valid: false };
  await prisma.user.update({ where: { id: user.id }, data: { referralClickCount: { increment: 1 } } });
  return { valid: true };
}

// Existence check only - no click-count side effect (that counter means
// "landing page visited", not "code typed before requesting an OTP"). Used
// by send-otp's pre-registration validation gate: an invalid code must never
// let an OTP go out (spec: "Invalid Referral Code -> No OTP").
export async function referralCodeExists(code: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { referralCode: normalizeReferralCode(code) }, select: { id: true } });
  return !!user;
}

async function getOrCreateReferralConfig() {
  const existing = await prisma.referralConfig.findFirst();
  if (existing) return existing;
  return prisma.referralConfig.create({ data: {} });
}

export async function getReferralConfig() {
  return getOrCreateReferralConfig();
}

export interface UpdateReferralConfigInput {
  rewardAmount?: number;
  referredUserRewardAmount?: number;
  qualificationRule?: string;
  isActive?: boolean;
}

export async function updateReferralConfig(adminUserId: string, input: UpdateReferralConfigInput) {
  const current = await getOrCreateReferralConfig();
  const updated = await prisma.referralConfig.update({ where: { id: current.id }, data: { ...input, updatedBy: adminUserId } });

  await writeAuditLog({
    userId: adminUserId,
    action: 'REFERRAL_CONFIG_UPDATED',
    entityType: 'referral_config',
    entityId: updated.id,
    metadata: {
      rewardAmount: updated.rewardAmount.toString(),
      referredUserRewardAmount: updated.referredUserRewardAmount.toString(),
      isActive: updated.isActive,
    },
  });

  return updated;
}

// Fraud-detection signal only (never an auth identity) - a device that has
// already appeared on any prior Referral row (rewarded or rejected) has used
// up its one referral slot. A missing deviceId is never treated as "already
// used" - it just skips this check entirely, so older/untracked clients keep
// working exactly as before.
//
// Two concurrent registrations on the SAME brand-new device would otherwise
// both pass a plain findFirst check before either commits (classic
// check-then-act race). A transaction-scoped Postgres advisory lock keyed by
// deviceId closes that window: the second caller blocks here until the
// first's transaction commits or rolls back, then sees its row under Read
// Committed and correctly takes the rejection path itself - so this never
// depends on catching a unique-constraint error from inside the same
// transaction (Postgres aborts the whole transaction on any failed
// statement, which would otherwise take the entire registration down with
// it, not just the referral attribution).
async function isDeviceAlreadyUsedForReferral(tx: Prisma.TransactionClient, deviceId: string): Promise<boolean> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${deviceId})::bigint)`;
  const priorUse = await tx.referral.findFirst({ where: { deviceId }, select: { id: true } });
  return !!priorUse;
}

export type AttributeReferralResult =
  | { outcome: 'ATTRIBUTED'; referral: { id: string; status: string; rewardAmount: string | null }; referrerId: string; referredUserRewardAmount: string | null }
  | { outcome: 'REJECTED_DUPLICATE_DEVICE'; deviceId: string; referralCode: string; referrerId: string }
  | null;

// Called from inside user-auth.service.ts's registration transaction, only
// when isNewUser is true (spec §8/§23: referral relationships are only ever
// created at a real, backend-verified registration event - never from a
// link click or landing-page visit alone). Returns null silently on any
// invalid/self/stale code rather than throwing, because a bad referral code
// must never block the registration itself.
export async function attributeReferral(
  tx: Prisma.TransactionClient,
  rawCode: string,
  newUser: { id: string; phone: string | null },
  deviceId?: string,
): Promise<AttributeReferralResult> {
  const code = normalizeReferralCode(rawCode);
  const referrer = await tx.user.findUnique({ where: { referralCode: code }, select: { id: true, phone: true } });
  if (!referrer) return null;
  if (referrer.id === newUser.id) return null; // structurally unreachable (newUser is brand new) - defensive only
  if (referrer.phone && referrer.phone === newUser.phone) return null; // defensive - phone is already unique on User

  // Device fraud check (spec: "one physical device -> one rewarded
  // referral"): this must reject the REWARD, not the registration - the new
  // user still goes on to register normally below, just with no referral
  // relationship recorded and no code consumed. The audit log for this is
  // written by the caller AFTER the transaction commits (writeAuditLog uses
  // the top-level prisma client, not `tx` - calling it in here, before
  // newUser exists outside this transaction, would violate the audit log's
  // user FK).
  if (deviceId && (await isDeviceAlreadyUsedForReferral(tx, deviceId))) {
    return { outcome: 'REJECTED_DUPLICATE_DEVICE', deviceId, referralCode: code, referrerId: referrer.id };
  }

  const config = await getOrCreateReferralConfig();

  // The advisory lock taken in isDeviceAlreadyUsedForReferral() above already
  // serializes concurrent attempts for this deviceId, so by the time we get
  // here this insert cannot collide with another in-flight registration on
  // the same device - Referral.deviceId's unique constraint exists purely as
  // a schema-level guarantee, not as a condition this code expects to hit.
  let referral = await tx.referral.create({
    data: {
      referrerId: referrer.id,
      referredUserId: newUser.id,
      referralCode: code,
      status: 'OTP_VERIFIED',
      deviceId,
    },
  });

  // The only currently-implemented qualification rule (spec §8): OTP
  // verification IS the qualifying event, so qualification and reward
  // happen inline in the same transaction as registration rather than a
  // separate async step. A future rule (e.g. first task completion) would
  // leave the referral at OTP_VERIFIED here and qualify it later from
  // wherever that event is handled instead.
  let referredUserRewardAmount: string | null = null;

  if (config.qualificationRule === 'OTP_VERIFIED') {
    referral = await tx.referral.update({
      where: { id: referral.id },
      data: { status: 'QUALIFIED', qualifiedAt: new Date() },
    });

    if (config.isActive && Number(config.rewardAmount) > 0) {
      // Same unique(referenceType, referenceId) idempotency backstop reward
      // crediting already relies on elsewhere (reward.service.ts) - a
      // second attribution attempt for the same referral can never insert a
      // second WalletTransaction, even under a bug or a retried request.
      await tx.walletTransaction.create({
        data: {
          userId: referrer.id,
          type: 'EARN',
          amount: config.rewardAmount,
          referenceType: 'REFERRAL_REWARD',
          referenceId: referral.id,
          description: 'Referral reward',
        },
      });
      await tx.userWallet.update({ where: { userId: referrer.id }, data: { balance: { increment: config.rewardAmount } } });
      referral = await tx.referral.update({
        where: { id: referral.id },
        data: { status: 'REWARDED', rewardedAt: new Date(), rewardAmount: config.rewardAmount },
      });
    }

    // The new (referred) user's own joining bonus - a distinct amount and a
    // distinct referenceType from the referrer's REFERRAL_REWARD above, so
    // both can share the same referral.id as their referenceId without
    // colliding on WalletTransaction's unique(referenceType, referenceId)
    // constraint, while each one is still independently idempotent.
    if (config.isActive && Number(config.referredUserRewardAmount) > 0) {
      await tx.walletTransaction.create({
        data: {
          userId: newUser.id,
          type: 'EARN',
          amount: config.referredUserRewardAmount,
          referenceType: 'REFERRAL_BONUS',
          referenceId: referral.id,
          description: 'Referral joining bonus',
        },
      });
      await tx.userWallet.update({ where: { userId: newUser.id }, data: { balance: { increment: config.referredUserRewardAmount } } });
      referredUserRewardAmount = toMoneyString(config.referredUserRewardAmount);
      referral = await tx.referral.update({
        where: { id: referral.id },
        data: { referredUserRewardAmount: config.referredUserRewardAmount },
      });
    }
  }

  return {
    outcome: 'ATTRIBUTED',
    referral: { id: referral.id, status: referral.status, rewardAmount: referral.rewardAmount ? toMoneyString(referral.rewardAmount) : null },
    referrerId: referrer.id,
    referredUserRewardAmount,
  };
}

// Fires the referrer's notification - called after the registration
// transaction commits (never from inside it, matching every other
// notification call site in this codebase).
export async function notifyReferrerOfReward(referrerId: string, rewardAmount: string | null) {
  if (!rewardAmount) return;
  await createNotification({
    userId: referrerId,
    type: 'REFERRAL_REWARDED',
    title: 'Referral reward earned',
    message: `You earned ₹${rewardAmount} for a successful referral.`,
    metadata: {},
  });
}

// The referred (joining) user's own notification - separate from the
// referrer's above since it's a different recipient and a different
// amount, but otherwise the exact same fire-after-commit pattern.
export async function notifyNewUserOfReferralBonus(newUserId: string, bonusAmount: string | null) {
  if (!bonusAmount) return;
  await createNotification({
    userId: newUserId,
    type: 'REFERRAL_BONUS',
    title: 'Referral bonus credited',
    message: `You received ₹${bonusAmount} for joining with a referral code.`,
    metadata: {},
  });
}

export async function getMyReferralSummary(userId: string) {
  const [code, config, statusCounts, rewardAgg] = await Promise.all([
    getOrCreateReferralCode(userId),
    getOrCreateReferralConfig(),
    prisma.referral.groupBy({ by: ['status'], where: { referrerId: userId }, _count: { _all: true } }),
    prisma.referral.aggregate({ where: { referrerId: userId, status: 'REWARDED' }, _sum: { rewardAmount: true } }),
  ]);

  const byStatus: Record<string, number> = {};
  for (const row of statusCounts) byStatus[row.status] = row._count._all;
  const totalInvited = statusCounts.reduce((sum, row) => sum + row._count._all, 0);

  return {
    referralCode: code,
    referralLink: referralLink(code),
    totalInvited,
    registered: totalInvited, // OTP_VERIFIED/QUALIFIED/REWARDED/REJECTED all imply a completed registration
    verified: totalInvited, // registration and OTP verification are the same event in this app (see schema note)
    qualified: (byStatus['QUALIFIED'] ?? 0) + (byStatus['REWARDED'] ?? 0),
    rewarded: byStatus['REWARDED'] ?? 0,
    referralEarnings: toMoneyString(rewardAgg._sum.rewardAmount ?? 0),
    // The two live, admin-configured amounts (spec §21: "Do not hardcode
    // values ... Backend remains the source of truth") - what a share
    // screen shows as "you get ₹X, they get ₹Y" comes from here, not a
    // frontend constant.
    referrerRewardAmount: toMoneyString(config.rewardAmount),
    newUserRewardAmount: toMoneyString(config.referredUserRewardAmount),
  };
}

export async function getMyReferralHistory(userId: string, params: { page: number; pageSize: number }) {
  const where = { referrerId: userId };
  const [rows, total] = await Promise.all([
    prisma.referral.findMany({
      where,
      include: { referredUser: { select: { name: true, phone: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.referral.count({ where }),
  ]);

  const data = rows.map((r) => ({
    id: r.id,
    maskedIdentifier: maskIdentifier(r.referredUser),
    status: r.status,
    rewardAmount: r.rewardAmount ? toMoneyString(r.rewardAmount) : null,
    date: r.createdAt,
  }));

  return { data, page: params.page, pageSize: params.pageSize, total, pagination: paginationMeta(params.page, params.pageSize, total) };
}

export async function listReferralsAdmin(params: { page: number; pageSize: number; status?: string }) {
  const where = params.status ? { status: params.status as any } : {};
  const [rows, total] = await Promise.all([
    prisma.referral.findMany({
      where,
      include: {
        referrer: { select: { name: true, phone: true, email: true } },
        referredUser: { select: { name: true, phone: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.referral.count({ where }),
  ]);

  const data = rows.map((r) => ({
    id: r.id,
    referrer: maskIdentifier(r.referrer),
    referredUser: maskIdentifier(r.referredUser),
    referralCode: r.referralCode,
    status: r.status,
    // Referrer's reward - unchanged field/name from before the new-user
    // side existed.
    rewardAmount: r.rewardAmount ? toMoneyString(r.rewardAmount) : null,
    // New: the referred user's own joining bonus, so Admin sees both sides
    // of the same referral on one row (spec §23).
    referredUserRewardAmount: r.referredUserRewardAmount ? toMoneyString(r.referredUserRewardAmount) : null,
    transactionReference: r.status === 'REWARDED' ? r.id : null,
    createdAt: r.createdAt,
  }));

  return { data, page: params.page, pageSize: params.pageSize, total, pagination: paginationMeta(params.page, params.pageSize, total) };
}

export async function getReferralAnalyticsAdmin() {
  const [clicksAgg, statusCounts, earningsAgg] = await Promise.all([
    prisma.user.aggregate({ _sum: { referralClickCount: true } }),
    prisma.referral.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.referral.aggregate({ where: { status: 'REWARDED' }, _sum: { rewardAmount: true } }),
  ]);

  const byStatus: Record<string, number> = {};
  for (const row of statusCounts) byStatus[row.status] = row._count._all;
  const totalRegistrations = statusCounts.reduce((sum, row) => sum + row._count._all, 0);
  const totalClicks = clicksAgg._sum.referralClickCount ?? 0;
  const rewarded = byStatus['REWARDED'] ?? 0;

  return {
    totalClicks,
    totalRegistrations,
    otpVerified: totalRegistrations,
    qualified: (byStatus['QUALIFIED'] ?? 0) + rewarded,
    rewarded,
    rejected: byStatus['REJECTED'] ?? 0,
    conversionRate: totalClicks > 0 ? Number(((totalRegistrations / totalClicks) * 100).toFixed(1)) : 0,
    totalReferralEarnings: toMoneyString(earningsAgg._sum.rewardAmount ?? 0),
  };
}
