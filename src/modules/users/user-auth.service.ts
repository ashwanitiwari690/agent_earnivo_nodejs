import { prisma } from '../../db/prisma.js';
import { Errors } from '../../utils/AppError.js';
import { signAccessToken } from '../../utils/jwt.js';
import { generateRefreshToken } from '../../utils/refreshToken.js';
import { serializeUser } from '../auth/auth.service.js';
import { writeAuditLog } from '../audit/audit.service.js';
import * as otpService from '../otp/otp.service.js';
import {
  attributeReferral,
  normalizeReferralCode,
  notifyNewUserOfReferralBonus,
  notifyReferrerOfReward,
  referralCodeExists,
} from '../referrals/referrals.service.js';

export interface DeviceMeta {
  deviceId?: string;
  platform?: string;
  appVersion?: string;
}

// A referral code is optional, but if one is provided it must be validated
// BEFORE an OTP is ever sent (spec: "Invalid Referral Code -> STOP -> NO
// OTP"). An empty/whitespace-only value is treated as no code at all, not as
// an invalid one - the frontend never forces a code, so this must not either.
export async function sendOtp(phone: string, referralCode?: string): Promise<void> {
  const normalizedCode = referralCode ? normalizeReferralCode(referralCode) : '';
  if (normalizedCode) {
    const exists = await referralCodeExists(normalizedCode);
    if (!exists) throw Errors.invalidReferralCode();
  }

  // Phone numbers are now mandatory for AGENT self-registration too (see
  // auth.service.ts::register), so this phone-only login must not be usable
  // against an Agent's or Admin's number - otherwise anyone who merely knows
  // (or can guess) an agent's phone could ride this endpoint straight into
  // that agent's account without ever knowing their password.
  const normalizedPhone = otpService.normalizePhone(phone);
  const existing = await prisma.user.findUnique({ where: { phone: normalizedPhone }, select: { role: { select: { code: true } } } });
  if (existing && existing.role.code !== 'USER') {
    throw Errors.validation('This mobile number cannot be used to sign in here.');
  }

  await otpService.requestOtp(phone);
}

// One transaction: verify -> consume (replay guard) -> find-or-create user
// (+ wallet, for new users only) -> issue session. Any failure rolls the
// whole thing back, so a half-created account/wallet can never exist.

// ─── TEMPORARY TESTING BYPASS ─────────────────────────────────────────────
// When otp === 'BYPASS' the OTP send/verify/consume steps are skipped so
// Play Console reviewers/testers can log in with any valid number instantly.
// TODO: Remove this constant and the bypass check below once testing is done.
const BYPASS_OTP_SENTINEL = 'BYPASS';
// ─── END TEMPORARY BYPASS ──────────────────────────────────────────────────

export async function verifyOtpAndAuthenticate(phone: string, otp: string, deviceMeta: DeviceMeta, referralCode?: string) {
  // ─── TEMPORARY BYPASS: skip OTP verification ─────────────────────────────
  const isBypass = otp === BYPASS_OTP_SENTINEL;
  // TODO: remove this block when bypass is no longer needed.
  if (!isBypass) {
    await otpService.verifyOtp(phone, otp);
  }
  // ─── END TEMPORARY BYPASS ────────────────────────────────────────────────
  const normalizedPhone = otpService.normalizePhone(phone);

  const result = await prisma.$transaction(async (tx) => {
    // ─── TEMPORARY BYPASS: skip OTP consume ────────────────────────────────
    // TODO: remove this condition when bypass is no longer needed.
    if (!isBypass) {
      await otpService.consumeVerifiedOtp(tx, phone);
    }
    // ─── END TEMPORARY BYPASS ────────────────────────────────────────────

    let user = await tx.user.findUnique({
      where: { phone: normalizedPhone },
      include: { role: true, agentProfile: true },
    });
    let isNewUser = false;
    let referralOutcome: Awaited<ReturnType<typeof attributeReferral>> = null;

    if (!user) {
      isNewUser = true;
      const userRole = await tx.role.findUniqueOrThrow({ where: { code: 'USER' } });
      user = await tx.user.create({
        data: {
          phone: normalizedPhone,
          phoneVerified: true,
          roleId: userRole.id,
          status: 'ACTIVE',
          lastLoginAt: new Date(),
        },
        include: { role: true, agentProfile: true },
      });
      await tx.userWallet.create({ data: { userId: user.id, balance: 0 } });

      // Referral attribution only ever happens at this exact registration
      // moment (spec Phase 9 §8/§23) - never on link click, landing-page
      // visit, or app download alone. deviceId is passed through purely as a
      // fraud-detection signal (spec: "one device -> one rewarded
      // referral") - a rejection here never blocks registration itself.
      if (referralCode) {
        referralOutcome = await attributeReferral(tx, referralCode, { id: user.id, phone: user.phone }, deviceMeta.deviceId);
      }
    } else {
      // Defense in depth alongside sendOtp()'s own check above: never let a
      // verified OTP for an Agent's or Admin's phone number issue a session
      // for that account through this USER-only endpoint (it always signs
      // with role: 'USER' below, but `sub` would still be that other
      // account's real id).
      if (user.role.code !== 'USER') {
        throw Errors.validation('This mobile number cannot be used to sign in here.');
      }
      if (user.status !== 'ACTIVE') throw Errors.userSuspended();
      user = await tx.user.update({
        where: { id: user.id },
        data: { phoneVerified: true, lastLoginAt: new Date() },
        include: { role: true, agentProfile: true },
      });
    }

    const accessToken = signAccessToken({ sub: user.id, role: 'USER' });
    const refresh = generateRefreshToken();
    await tx.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: refresh.tokenHash,
        expiresAt: refresh.expiresAt,
        deviceId: deviceMeta.deviceId,
        platform: deviceMeta.platform,
        appVersion: deviceMeta.appVersion,
      },
    });

    return { user, isNewUser, referralOutcome, accessToken, refreshToken: refresh.token, refreshExpiresAt: refresh.expiresAt };
  });

  await writeAuditLog({
    userId: result.user.id,
    action: result.isNewUser ? 'USER_REGISTERED' : 'LOGIN',
    entityType: 'users',
    entityId: result.user.id,
    metadata: { via: 'otp', referred: result.referralOutcome?.outcome === 'ATTRIBUTED' },
  });

  // Fired after commit, matching every other notification call site in this
  // codebase - never from inside the transaction itself.
  let referralWarning: string | null = null;
  if (result.referralOutcome?.outcome === 'ATTRIBUTED') {
    await notifyReferrerOfReward(result.referralOutcome.referrerId, result.referralOutcome.referral.rewardAmount);
    await notifyNewUserOfReferralBonus(result.user.id, result.referralOutcome.referredUserRewardAmount);
  } else if (result.referralOutcome?.outcome === 'REJECTED_DUPLICATE_DEVICE') {
    // Registration already succeeded above - this is display-only, telling
    // the new user why they didn't get the referral bonus (spec: "allow
    // normal registration but reject the referral benefit and show a
    // warning"). Logged here, after commit, so newUser.id is a real
    // committed row before audit_logs' FK references it.
    referralWarning = 'Referral reward is already used on this device. You can continue without referral benefits.';
    await writeAuditLog({
      userId: result.user.id,
      action: 'REFERRAL_REJECTED_DUPLICATE_DEVICE',
      entityType: 'referral',
      entityId: null,
      metadata: {
        deviceId: result.referralOutcome.deviceId,
        referralCode: result.referralOutcome.referralCode,
        referrerId: result.referralOutcome.referrerId,
      },
    });
  }

  return {
    user: serializeUser(result.user),
    isNewUser: result.isNewUser,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    refreshExpiresAt: result.refreshExpiresAt,
    referralWarning,
  };
}
