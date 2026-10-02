import { z } from 'zod';

export const listNotificationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
});

// FCM registration tokens are opaque and have no documented fixed length -
// they have grown over the years - so this validates only that the value is
// a plausible token rather than pinning a length that a future FCM change
// would silently break. The 4096 ceiling is there to stop an arbitrarily
// large string reaching the database, not to describe the format.
export const registerDeviceSchema = z.object({
  token: z.string().min(20).max(4096),
  platform: z.enum(['android', 'ios', 'web']).optional(),
  // The client's own device identifier - the same value it sends to
  // verify-otp - used to clear this device's previous token when FCM
  // rotates it. Optional so a client that can't produce one still registers
  // successfully; it just leaves rotation cleanup to FCM's own UNREGISTERED
  // reporting.
  deviceId: z.string().max(128).optional(),
});

export const unregisterDeviceSchema = z.object({
  token: z.string().min(20).max(4096),
});
