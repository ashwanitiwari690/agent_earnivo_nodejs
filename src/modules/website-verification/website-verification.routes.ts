import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validateBody } from '../../middleware/validate.js';
import { websiteVerificationSchema } from './website-verification.schemas.js';
import { confirmHandler, sessionHandler } from './website-verification.controller.js';

// Called from the promoted website's own frontend, by a visitor's browser
// that has no Earnivo session at all - so, exactly like
// app-verification.routes.ts, there is deliberately no `authenticate` here.
// The (apiKey, token) pair in the body is the credential.
//
// Two limiters rather than one: /session is hit once per page load and only
// reads, while /confirm is the call that moves real money and deserves the
// tighter window.
const sessionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } },
});

const confirmLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } },
});

export const websiteVerificationRouter = Router();
websiteVerificationRouter.post('/session', sessionLimiter, validateBody(websiteVerificationSchema), sessionHandler);
websiteVerificationRouter.post('/confirm', confirmLimiter, validateBody(websiteVerificationSchema), confirmHandler);
