import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';
import { imageUpload } from '../../middleware/upload.js';
import { approvePaymentSchema, listPaymentsQuerySchema, rejectPaymentSchema, submitPaymentSchema } from './payments.schemas.js';
import {
  approvePaymentHandler,
  listMyPaymentsHandler,
  listPaymentsAdminHandler,
  rejectPaymentHandler,
  submitPaymentHandler,
} from './payments.controller.js';

const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many payment submissions. Try again later.' } },
});

export const paymentsRouter = Router();

paymentsRouter.use(authenticate);

// Agent self-service
paymentsRouter.post(
  '/',
  requireRole('AGENT'),
  submitLimiter,
  imageUpload('payment-proofs').single('proof'),
  validateBody(submitPaymentSchema),
  submitPaymentHandler,
);
paymentsRouter.get('/me', requireRole('AGENT'), validateQuery(listPaymentsQuerySchema), listMyPaymentsHandler);

// Admin verification
paymentsRouter.get('/', requireRole('ADMIN'), validateQuery(listPaymentsQuerySchema), listPaymentsAdminHandler);
paymentsRouter.post('/:id/approve', requireRole('ADMIN'), validateBody(approvePaymentSchema), approvePaymentHandler);
paymentsRouter.post('/:id/reject', requireRole('ADMIN'), validateBody(rejectPaymentSchema), rejectPaymentHandler);
