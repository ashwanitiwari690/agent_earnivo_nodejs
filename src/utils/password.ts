import bcrypt from 'bcrypt';
import { env } from '../config/env.js';

// bcrypt is intentionally slow, and it burns that time on libuv's thread
// pool rather than the event loop - which means concurrent logins are
// limited by pool threads (four by default; see server.ts, which raises it),
// not by anything Express does. Each extra round doubles the cost, so 12 ->
// 10 is roughly a 4x reduction in the most expensive work in the request
// path while staying far above the point where offline cracking is cheap.
// Lowering this does not invalidate anything: bcrypt stores the cost factor
// inside each hash, so existing 12-round hashes keep verifying normally and
// only newly written hashes use the new cost.
const SALT_ROUNDS = env.bcryptRounds;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
