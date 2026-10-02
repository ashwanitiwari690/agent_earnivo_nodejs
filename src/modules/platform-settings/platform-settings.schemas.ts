import { z } from 'zod';

export const updatePaymentConfigSchema = z.object({
  upiId: z.string().trim().max(100).optional(),
  receiverName: z.string().trim().max(150).optional(),
  instructions: z.string().trim().max(2000).optional(),
  isEnabled: z.boolean().optional(),
  minimumAmount: z.coerce.number().min(0).nullable().optional(),
  supportedMethods: z.array(z.string().trim().max(30)).max(10).optional(),
  paymentNotes: z.string().trim().max(1000).optional(),
});
