import { prisma } from '../../db/prisma.js';

export interface RegisterDeviceInput {
  token: string;
  platform?: string;
  deviceId?: string;
}

// Called by the Ionic client every time FCM hands it a registration token -
// at first launch after permission is granted, whenever FCM rotates the
// token, and on each sign-in. It is deliberately idempotent: the client has
// no way to know whether a token is already stored, so re-registering the
// same token on every app start must be a no-op rather than a duplicate.
export async function registerDeviceToken(userId: string, input: RegisterDeviceInput) {
  // FCM rotates a device's token periodically and on app reinstall. Without
  // this, one phone accumulates a new row per rotation and every push to
  // that user fans out to a growing pile of dead tokens - each one a
  // wasted HTTP request that only gets cleaned up when FCM eventually
  // reports it UNREGISTERED. Clearing by deviceId collapses that to one
  // live row per physical device.
  if (input.deviceId) {
    await prisma.deviceToken.deleteMany({ where: { deviceId: input.deviceId, token: { not: input.token } } });
  }

  return prisma.deviceToken.upsert({
    where: { token: input.token },
    create: { userId, token: input.token, platform: input.platform ?? null, deviceId: input.deviceId ?? null },
    // userId is updated, not just touched: a shared or resold handset that
    // signs in as somebody else must re-point its existing token at the new
    // account, otherwise the previous owner keeps receiving that device's
    // notifications.
    update: { userId, platform: input.platform ?? null, deviceId: input.deviceId ?? null, lastSeenAt: new Date() },
  });
}

// Called from the client immediately before logout. Scoped to the caller's
// own userId so one user can never unregister another's device, even with a
// guessed token.
export async function unregisterDeviceToken(userId: string, token: string) {
  await prisma.deviceToken.deleteMany({ where: { userId, token } });
}

export async function getTokensForUsers(userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = await prisma.deviceToken.findMany({
    where: { userId: { in: userIds } },
    select: { token: true },
  });
  return rows.map((r) => r.token);
}

// Deletes the tokens FCM reported as permanently dead. Called after every
// send, so the table self-heals from uninstalls without a scheduled job.
export async function pruneInvalidTokens(tokens: string[]) {
  if (tokens.length === 0) return;
  await prisma.deviceToken.deleteMany({ where: { token: { in: tokens } } });
}
