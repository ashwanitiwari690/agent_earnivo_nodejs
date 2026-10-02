import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';
import { listQuerySchema, listReferralsAdminQuerySchema, updateReferralConfigSchema } from './referrals.schemas.js';
import {
  getAnalyticsAdminHandler,
  getConfigHandler,
  getMyHistoryHandler,
  getMySummaryHandler,
  listReferralsAdminHandler,
  updateConfigHandler,
  validateReferralCodeHandler,
} from './referrals.controller.js';

// Public code-validation is what the anonymous landing page hits - capped
// well above normal traffic but low enough to blunt code-enumeration
// scraping (spec §12: prevent "manipulated referral codes").
const validateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } },
});

export const referralsRouter = Router();

referralsRouter.get('/validate/:code', validateLimiter, validateReferralCodeHandler);

referralsRouter.get('/me', authenticate, requireRole('USER'), getMySummaryHandler);
referralsRouter.get('/me/history', authenticate, requireRole('USER'), validateQuery(listQuerySchema), getMyHistoryHandler);

referralsRouter.get('/admin', authenticate, requireRole('ADMIN'), validateQuery(listReferralsAdminQuerySchema), listReferralsAdminHandler);
referralsRouter.get('/admin/analytics', authenticate, requireRole('ADMIN'), getAnalyticsAdminHandler);
referralsRouter.get('/admin/config', authenticate, requireRole('ADMIN'), getConfigHandler);
referralsRouter.put('/admin/config', authenticate, requireRole('ADMIN'), validateBody(updateReferralConfigSchema), updateConfigHandler);
