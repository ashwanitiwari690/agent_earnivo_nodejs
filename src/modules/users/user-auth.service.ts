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
export async function sendOtp(phone: string, referralCode?: string): Promise<void> {
  const normalizedCode = referralCode ? normalizeReferralCode(referralCode) : '';
  if (normalizedCode) {
    const exists = await referralCodeExists(normalizedCode);
    if (!exists) throw Errors.invalidReferralCode();
  }

  const normalizedPhone = otpService.normalizePhone(phone);
  const existing = await prisma.user.findUnique({ where: { phone: normalizedPhone }, select: { role: { select: { code: true } } } });
  if (existing && existing.role.code !== 'USER') {
    throw Errors.validation('This mobile number cannot be used to sign in here.');
  }

  await otpService.requestOtp(phone);
}
export async function verifyOtpAndAuthenticate(phone: string, otp: string, deviceMeta: DeviceMeta, referralCode?: string) {
  await otpService.verifyOtp(phone, otp);
  const normalizedPhone = otpService.normalizePhone(phone);

  const result = await prisma.$transaction(async (tx) => {
    await otpService.consumeVerifiedOtp(tx, phone);

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
      if (referralCode) {
        referralOutcome = await attributeReferral(tx, referralCode, { id: user.id, phone: user.phone }, deviceMeta.deviceId);
      }
    } else {
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

  let referralWarning: string | null = null;
  if (result.referralOutcome?.outcome === 'ATTRIBUTED') {
    await notifyReferrerOfReward(result.referralOutcome.referrerId, result.referralOutcome.referral.rewardAmount);
    await notifyNewUserOfReferralBonus(result.user.id, result.referralOutcome.referredUserRewardAmount);
  } else if (result.referralOutcome?.outcome === 'REJECTED_DUPLICATE_DEVICE') {
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
