import { randomBytes, createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { parseDurationMs } from './duration.js';

const REFRESH_TOKEN_BYTES = 48;
// Derived from JWT_REFRESH_EXPIRES_IN rather than hardcoded. It used to be a
// literal 30 days with a comment claiming it mirrored the environment, which
// meant changing JWT_REFRESH_EXPIRES_IN moved nothing at all: the stored
// expiresAt - the only thing the refresh endpoint actually checks - stayed
// at 30 days regardless. Computed once at startup because the setting cannot
// change while the process is running.
const REFRESH_TOKEN_TTL_MS = parseDurationMs(env.jwtRefreshExpiresIn, 90 * 24 * 60 * 60 * 1000);

export function generateRefreshToken(): { token: string; tokenHash: string; expiresAt: Date } {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
  return {
    token,
    tokenHash: hashRefreshToken(token),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
