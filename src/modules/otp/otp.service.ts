import { prisma } from '../../db/prisma.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/AppError.js';
import { generateOtp, hashOtp } from '../../utils/otp.js';
import { sendOtpWhatsapp } from '../../services/whatsapp.service.js';

const PHONE_PATTERN = /^[6-9]\d{9}$/;

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  const normalized = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  if (!PHONE_PATTERN.test(normalized)) {
    throw new AppError(422, 'INVALID_PHONE', 'Enter a valid 10-digit mobile number.');
  }
  return normalized;
}

// Three separate steps so a verified OTP can be checked once (verifyOtp) and
// consumed exactly once, transactionally, at the point the caller actually
// finalizes auth (consumeVerifiedOtp) - keeping replay-prevention independent
// of whatever business logic runs between "OTP is correct" and
// "session/account is created".

export async function requestOtp(rawPhone: string): Promise<void> {
  const phone = normalizePhone(rawPhone);

  const latest = await prisma.otpVerification.findFirst({
    where: { phone },
    orderBy: { createdAt: 'desc' },
  });

  if (latest) {
    const cooldownEnds = new Date(latest.createdAt.getTime() + env.otpResendCooldownSeconds * 1000);
    if (cooldownEnds > new Date()) {
      throw new AppError(429, 'OTP_COOLDOWN', 'Please wait before requesting another OTP.');
    }
  }

  const otp = generateOtp();
  const otpHash = hashOtp(otp);
  const expiresAt = new Date(Date.now() + env.otpExpiryMinutes * 60 * 1000);

  await prisma.otpVerification.create({ data: { phone, otpHash, expiresAt } });
  await sendOtpWhatsapp(phone, otp);
}

export async function verifyOtp(rawPhone: string, otp: string) {
  const phone = normalizePhone(rawPhone);

  const record = await prisma.otpVerification.findFirst({
    where: { phone, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  if (!record) throw new AppError(404, 'OTP_NOT_FOUND', 'No OTP request found. Please request a new OTP.');
  if (record.expiresAt < new Date()) throw new AppError(410, 'OTP_EXPIRED', 'OTP has expired. Please request a new OTP.');
  if (record.attempts >= env.otpMaxAttempts) {
    throw new AppError(429, 'OTP_MAX_ATTEMPTS', 'Too many incorrect attempts. Please request a new OTP.');
  }

  if (hashOtp(otp) !== record.otpHash) {
    await prisma.otpVerification.update({ where: { id: record.id }, data: { attempts: { increment: 1 } } });
    throw new AppError(422, 'OTP_INVALID', 'Incorrect OTP. Please try again.');
  }

  return prisma.otpVerification.update({ where: { id: record.id }, data: { verifiedAt: new Date() } });
}

export async function consumeVerifiedOtp(tx: Prisma.TransactionClient, rawPhone: string) {
  const phone = normalizePhone(rawPhone);
  const validAfter = new Date(Date.now() - env.otpVerificationValidityMinutes * 60 * 1000);

  const record = await tx.otpVerification.findFirst({
    where: { phone, consumedAt: null, verifiedAt: { not: null, gte: validAfter } },
    orderBy: { verifiedAt: 'desc' },
  });

  if (!record) {
    throw new AppError(401, 'SESSION_EXPIRED', 'Your OTP verification has expired. Please verify your mobile number again.');
  }

  await tx.otpVerification.update({ where: { id: record.id }, data: { consumedAt: new Date() } });
  return record;
}
