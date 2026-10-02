import { z } from 'zod';

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
});

export const listReferralsAdminQuerySchema = listQuerySchema.extend({
  status: z.enum(['OTP_VERIFIED', 'QUALIFIED', 'REWARDED', 'REJECTED']).optional(),
});

export const updateReferralConfigSchema = z.object({
  rewardAmount: z.coerce.number().nonnegative().finite().optional(),
  referredUserRewardAmount: z.coerce.number().nonnegative().finite().optional(),
  qualificationRule: z.enum(['OTP_VERIFIED']).optional(),
  isActive: z.boolean().optional(),
});
