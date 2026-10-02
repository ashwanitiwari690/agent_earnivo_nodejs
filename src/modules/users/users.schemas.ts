import { z } from 'zod';

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  status: z.string().optional(),
});

export const updateMeSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
});

export const updatePayoutDefaultsSchema = z
  .object({
    defaultPayoutMethod: z.enum(['UPI', 'MOBILE']),
    defaultUpiId: z.string().trim().min(3).max(100).optional(),
    defaultMobileNumber: z
      .string()
      .trim()
      .regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number.')
      .optional(),
  })
  .refine((v) => (v.defaultPayoutMethod === 'UPI' ? !!v.defaultUpiId : true), { message: 'UPI ID is required.', path: ['defaultUpiId'] })
  .refine((v) => (v.defaultPayoutMethod === 'MOBILE' ? !!v.defaultMobileNumber : true), {
    message: 'Mobile number is required.',
    path: ['defaultMobileNumber'],
  });

export const updateNotificationPreferencesSchema = z.object({
  notifyRewards: z.boolean().optional(),
  notifyCampaigns: z.boolean().optional(),
  notifyAccount: z.boolean().optional(),
});
