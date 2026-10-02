import { z } from 'zod';

export const confirmSchema = z.object({
  apiKey: z.string().trim().min(10).max(100),
  advertisingId: z.string().trim().min(4).max(200),
});
