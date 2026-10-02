import { z } from 'zod';

export const sendOtpSchema = z.object({
  phone: z.string().trim().min(10).max(13),
  // Validated before the OTP is generated (see user-auth.service.ts::sendOtp)
  // - an invalid code here must block the OTP entirely, not just the later
  // reward attribution.
  referralCode: z.string().trim().max(20).optional(),
});

export const verifyOtpSchema = z.object({
  phone: z.string().trim().min(10).max(13),
  otp: z.string().trim().min(4).max(8),
  deviceId: z.string().trim().max(200).optional(),
  platform: z.string().trim().max(50).optional(),
  appVersion: z.string().trim().max(50).optional(),
  // Only ever consumed when this call creates a brand-new user (spec Phase
  // 9 §8) - harmless to send on every verify-otp call for an existing user.
  referralCode: z.string().trim().max(20).optional(),
});
