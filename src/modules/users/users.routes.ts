import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';
import { listQuerySchema, updateMeSchema, updateNotificationPreferencesSchema, updatePayoutDefaultsSchema } from './users.schemas.js';
import {
  deleteMyAccountHandler,
  getMeHandler,
  getMyCampaignHistoryHandler,
  getMyEarningsHandler,
  getMyGameEarningsHandler,
  getMyWalletHandler,
  getMyWalletTransactionsHandler,
  listMySessionsHandler,
  revokeMySessionHandler,
  updateMeHandler,
  updateMyNotificationPreferencesHandler,
  updateMyPayoutDefaultsHandler,
} from './users.controller.js';

export const usersRouter = Router();

// Tight rate limiter for the irreversible account-deletion endpoint -
// 3 attempts per hour per IP to prevent abuse while still allowing a
// genuine retry after an accidental misfire.
const deleteAccountLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many account deletion requests. Please try again later.' } },
});

usersRouter.use(authenticate, requireRole('USER'));
usersRouter.get('/me', getMeHandler);
usersRouter.patch('/me', validateBody(updateMeSchema), updateMeHandler);
usersRouter.patch('/me/payout-defaults', validateBody(updatePayoutDefaultsSchema), updateMyPayoutDefaultsHandler);
usersRouter.patch('/me/notification-preferences', validateBody(updateNotificationPreferencesSchema), updateMyNotificationPreferencesHandler);
usersRouter.get('/me/sessions', listMySessionsHandler);
usersRouter.delete('/me/sessions/:id', revokeMySessionHandler);
usersRouter.get('/me/wallet', getMyWalletHandler);
usersRouter.get('/me/wallet/transactions', validateQuery(listQuerySchema), getMyWalletTransactionsHandler);
usersRouter.get('/me/campaign-history', validateQuery(listQuerySchema), getMyCampaignHistoryHandler);
usersRouter.get('/me/earnings', validateQuery(listQuerySchema), getMyEarningsHandler);
usersRouter.get('/me/game-earnings', validateQuery(listQuerySchema), getMyGameEarningsHandler);
usersRouter.delete('/me', deleteAccountLimiter, deleteMyAccountHandler);

