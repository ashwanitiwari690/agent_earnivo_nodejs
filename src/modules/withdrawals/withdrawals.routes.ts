import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';
import {
  createWithdrawalSchema,
  listWithdrawalsQuerySchema,
  processWithdrawalSchema,
  rejectWithdrawalSchema,
} from './withdrawals.schemas.js';
import {
  completeWithdrawalHandler,
  createWithdrawalHandler,
  getAvailableBalanceHandler,
  listMyWithdrawalsHandler,
  listWithdrawalsAdminHandler,
  markProcessingHandler,
  rejectWithdrawalHandler,
} from './withdrawals.controller.js';

const withdrawLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many withdrawal requests. Try again later.' } },
});

export const withdrawalsRouter = Router();

withdrawalsRouter.use(authenticate);

// User self-service
withdrawalsRouter.get('/me/balance', requireRole('USER'), getAvailableBalanceHandler);
withdrawalsRouter.post('/', requireRole('USER'), withdrawLimiter, validateBody(createWithdrawalSchema), createWithdrawalHandler);
withdrawalsRouter.get('/me', requireRole('USER'), validateQuery(listWithdrawalsQuerySchema), listMyWithdrawalsHandler);

// Admin management
withdrawalsRouter.get('/', requireRole('ADMIN'), validateQuery(listWithdrawalsQuerySchema), listWithdrawalsAdminHandler);
withdrawalsRouter.post('/:id/processing', requireRole('ADMIN'), validateBody(processWithdrawalSchema), markProcessingHandler);
withdrawalsRouter.post('/:id/complete', requireRole('ADMIN'), validateBody(processWithdrawalSchema), completeWithdrawalHandler);
withdrawalsRouter.post('/:id/reject', requireRole('ADMIN'), validateBody(rejectWithdrawalSchema), rejectWithdrawalHandler);
