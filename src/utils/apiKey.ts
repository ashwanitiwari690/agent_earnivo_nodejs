import { randomBytes } from 'node:crypto';

// Handed to whoever builds a promoted app so its own confirm-install callback
// (app-verification.service.ts) can be traced back to the campaign that
// issued it - not a code a human ever types, so length/format is optimized
// for entropy, not readability, unlike generateReferralCode().
export function generateApiKey(): string {
  return `ak_${randomBytes(24).toString('hex')}`;
}

// One-time, per-attempt credential handed to a promoted website as a URL
// parameter (see tasks.service.ts's startTask) and posted back to
// POST /website-verification/confirm. Separate from generateApiKey because
// the two live at different trust levels: an API key is a long-lived
// campaign credential the agent configures once, a verification token is
// short-lived, belongs to a single user's single attempt, and travels
// through a URL bar - so it gets its own prefix to make the two impossible
// to confuse in logs or support tickets.
export function generateVerificationToken(): string {
  return `vt_${randomBytes(24).toString('hex')}`;
}
