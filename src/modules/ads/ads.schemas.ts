import { z } from 'zod';

export const trackAdEventSchema = z.object({
  trackingId: z.string().trim().min(1).max(100),
  type: z.enum(['IMPRESSION', 'CLICK']),
  campaignId: z.string().uuid().optional(),
  placement: z.string().trim().min(1).max(50),
  provider: z.enum(['INTERNAL', 'MOCK', 'GOOGLE', 'META']),
});
