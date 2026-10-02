import { z } from 'zod';

export const submitTaskSchema = z.object({
  data: z.record(z.string(), z.unknown()).default({}),
});

// APP_DOWNLOAD-strategy tasks only (App Promotion) - this device's OS
// Advertising ID, read client-side before opening the store URL. Optional:
// a device that can't produce one (ATT declined on iOS, plugin failure)
// still starts the task normally, it just can't be auto-verified later.
export const startTaskSchema = z.object({
  advertisingId: z.string().trim().min(4).max(200).optional(),
});
