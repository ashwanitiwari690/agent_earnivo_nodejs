import { z } from 'zod';

export const createWithdrawalSchema = z
  .object({
    amount: z.coerce.number().positive().finite(),
    method: z.enum(['UPI', 'MOBILE']),
    upiId: z.string().trim().min(3).max(100).optional(),
    mobileNumber: z
      .string()
      .trim()
      .regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number.')
      .optional(),
  })
  .refine((v) => (v.method === 'UPI' ? !!v.upiId : true), { message: 'UPI ID is required.', path: ['upiId'] })
  .refine((v) => (v.method === 'MOBILE' ? !!v.mobileNumber : true), { message: 'Mobile number is required.', path: ['mobileNumber'] });

export const listWithdrawalsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'REJECTED']).optional(),
});

export const processWithdrawalSchema = z.object({
  adminRemark: z.string().trim().max(500).optional(),
});

export const rejectWithdrawalSchema = z.object({
  adminRemark: z.string().trim().min(1, 'A rejection reason is required.').max(500),
});
