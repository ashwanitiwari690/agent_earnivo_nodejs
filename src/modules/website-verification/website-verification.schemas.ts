import { z } from 'zod';

// Shared by both endpoints: the campaign credential the agent configured on
// their site, plus the one-time token that site read out of the visitor's
// URL. Length bounds match what generateApiKey/generateVerificationToken
// actually produce, with room to spare.
export const websiteVerificationSchema = z.object({
  apiKey: z.string().trim().min(10).max(100),
  token: z.string().trim().min(10).max(200),
});
