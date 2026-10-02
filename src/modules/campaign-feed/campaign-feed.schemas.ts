import { z } from 'zod';

export const listFeedQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(10),
  type: z.string().optional(),
  sort: z.enum(['newest', 'reward_desc', 'duration_asc']).default('newest'),
  q: z.string().trim().max(200).optional(),
});
