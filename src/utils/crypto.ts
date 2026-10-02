import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

// Symmetric encryption for the Google OAuth tokens held in
// google_account_connections. These are not hashes: unlike a password, the
// backend has to be able to hand the original token back to Google, so this
// is genuinely reversible - which is exactly why the key lives in the
// environment and never in the database beside the ciphertext it protects.
//
// AES-256-GCM rather than plain CBC because GCM authenticates as well as
// encrypts: a row someone edited in the database fails to decrypt instead of
// quietly producing garbage that then gets sent to Google as a bearer token.

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits - the size GCM is specified for.
const VERSION = 'v1';

// SHA-256 of whatever the operator configured, so TOKEN_ENCRYPTION_KEY can be
// any human-typed string rather than exactly 32 raw bytes. Falls back to the
// JWT access secret (already required, already secret, already stable) so a
// half-configured environment still encrypts rather than silently storing
// plaintext tokens - the one failure mode that would be worse than a missing
// variable.
function key(): Buffer {
  const material = env.tokenEncryptionKey || env.jwtAccessSecret;
  return createHash('sha256').update(material).digest();
}

// Format: v1:<iv-b64>:<authTag-b64>:<ciphertext-b64>. The version prefix is
// what makes a future key rotation or algorithm change a migration rather
// than a break - old rows stay identifiable and can be re-encrypted.
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
}

// Returns null rather than throwing for anything it cannot decrypt - a
// rotated key, a truncated column, a row written before this format existed.
// Callers treat that exactly like a revoked grant (reconnect required), which
// is the honest outcome: the credential is unusable either way, and a 500 in
// the middle of a verification attempt would be a worse way to say so.
export function decryptToken(payload: string | null | undefined): string | null {
  if (!payload) return null;
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;

  try {
    const [, ivB64, tagB64, dataB64] = parts;
    const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
