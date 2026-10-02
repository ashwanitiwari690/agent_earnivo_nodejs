import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validateBody } from '../../middleware/validate.js';
import { confirmSchema } from './app-verification.schemas.js';
import { confirmHandler } from './app-verification.controller.js';

// Called by a third-party app with no Earnivo user session at all - there is
// deliberately no `authenticate` here (see referrals.routes.ts's public
// /validate/:code for the same shape of exception). Tighter window than that
// endpoint since a successful call here credits real money, not just a
// landing-page check.
const confirmLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } },
});

export const appVerificationRouter = Router();
appVerificationRouter.post('/confirm', confirmLimiter, validateBody(confirmSchema), confirmHandler);
