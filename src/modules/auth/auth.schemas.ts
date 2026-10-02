import { z } from 'zod';

// Phone is required (not optional, unlike the column itself) because it's
// now how a self-registering agent verifies their account: register() sends
// a WhatsApp OTP to it and login() won't succeed until that OTP is verified
// (see auth.service.ts). Same 10-digit Indian mobile pattern the WhatsApp OTP
// pipeline itself validates against (otp.service.ts's normalizePhone).
export const registerSchema = z.object({
  name: z.string().trim().min(2).max(150),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number.'),
  password: z.string().min(8).max(72),
  businessName: z.string().trim().max(200).optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(10),
  newPassword: z.string().min(8).max(72),
});

export const verifyEmailSchema = z.object({
  token: z.string().min(10),
});

export const resendVerificationEmailSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});

// Activation step for a self-registered agent: the WhatsApp OTP sent by
// register() (see auth.service.ts::verifyAgentPhoneOtp).
export const verifyAgentOtpSchema = z.object({
  phone: z.string().trim().min(10).max(13),
  otp: z.string().trim().min(4).max(8),
});

export const resendAgentOtpSchema = z.object({
  phone: z.string().trim().min(10).max(13),
});
