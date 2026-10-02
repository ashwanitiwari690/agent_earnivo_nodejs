import { z } from 'zod';

// Fields arrive as multipart/form-data alongside the screenshot file, so
// every value is a string on the wire - z.coerce handles the numeric/date
// fields. No `amount` here on purpose - it's server-computed from
// planId + billingCycle (payments.service.ts's submitPayment, via
// plan-pricing.ts) so an agent can never submit a payment proof for a
// different amount than what the plan+cycle actually costs.
export const submitPaymentSchema = z.object({
  planId: z.string().uuid(),
  billingCycle: z.enum(['WEEKLY', 'MONTHLY', 'YEARLY']),
  paymentMethod: z.enum(['UPI', 'BANK_TRANSFER', 'OTHER']),
  transactionReference: z.string().trim().min(3, 'Enter the UTR/transaction ID.').max(100),
  paymentDate: z.coerce.date(),
});

export const listPaymentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
});

export const approvePaymentSchema = z.object({
  adminRemark: z.string().trim().max(500).optional(),
});

export const rejectPaymentSchema = z.object({
  adminRemark: z.string().trim().min(1, 'A rejection reason is required.').max(500),
});
