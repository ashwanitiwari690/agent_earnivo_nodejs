import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../../middleware/authenticate.js';
import { validateBody } from '../../middleware/validate.js';
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resendAgentOtpSchema,
  resendVerificationEmailSchema,
  resetPasswordSchema,
  verifyAgentOtpSchema,
  verifyEmailSchema,
} from './auth.schemas.js';
import { sendOtpSchema, verifyOtpSchema } from '../users/user-auth.schemas.js';
import {
  forgotPasswordHandler,
  loginHandler,
  logoutHandler,
  meHandler,
  refreshHandler,
  registerHandler,
  resendAgentOtpHandler,
  resendVerificationEmailHandler,
  resetPasswordHandler,
  verifyAgentOtpHandler,
  verifyEmailHandler,
} from './auth.controller.js';
import { sendOtpHandler, verifyOtpHandler } from '../users/user-auth.controller.js';

export const authRouter = Router();

authRouter.post('/register', validateBody(registerSchema), registerHandler);
authRouter.post('/login', validateBody(loginSchema), loginHandler);
authRouter.post('/refresh', refreshHandler);
authRouter.post('/logout', logoutHandler);
authRouter.post('/forgot-password', validateBody(forgotPasswordSchema), forgotPasswordHandler);
authRouter.post('/reset-password', validateBody(resetPasswordSchema), resetPasswordHandler);
authRouter.post('/verify-email', validateBody(verifyEmailSchema), verifyEmailHandler);
authRouter.post('/resend-verification-email', validateBody(resendVerificationEmailSchema), resendVerificationEmailHandler);
authRouter.get('/me', authenticate, meHandler);

// Mobile OTP auth (Phase 3). WhatsApp sends cost money, so send-otp gets its
// own tighter limiter on top of the router-wide authLimiter.
const sendOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many OTP requests. Try again later.' } },
});

authRouter.post('/send-otp', sendOtpLimiter, validateBody(sendOtpSchema), sendOtpHandler);
authRouter.post('/verify-otp', validateBody(verifyOtpSchema), verifyOtpHandler);

// Agent self-registration activation (WhatsApp OTP - see auth.service.ts's
// register()/verifyAgentPhoneOtp()). Shares the same tighter limiter as
// send-otp above for the same reason: it also triggers a paid WhatsApp send.
authRouter.post('/resend-agent-otp', sendOtpLimiter, validateBody(resendAgentOtpSchema), resendAgentOtpHandler);
authRouter.post('/verify-agent-otp', validateBody(verifyAgentOtpSchema), verifyAgentOtpHandler);

// Google Sign-In (Phase 13 §18/§19) - an alternative to phone+OTP for the
// same USER role; shares this router's authLimiter, not a separate one.
