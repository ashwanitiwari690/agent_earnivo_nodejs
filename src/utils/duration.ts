// Shared parser for the human-readable duration strings the environment
// uses ("15m", "7d", "90d"). jsonwebtoken understands these natively, but
// anything that has to store its own expiry as a real timestamp - the
// refresh-token table, for one - needs the same string as milliseconds, and
// having two places invent their own answer is how a token ends up living
// for a different length of time than its configuration says.
const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  y: 31_536_000_000,
};

export function parseDurationMs(value: string | number | undefined, fallbackMs: number): number {
  if (value == null) return fallbackMs;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : fallbackMs;

  const trimmed = value.trim();
  // A bare number means seconds, matching jsonwebtoken's own convention for
  // a numeric expiresIn - not milliseconds, which is the easy mistake here.
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;

  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|y)$/i.exec(trimmed);
  if (!match) return fallbackMs;

  const amount = Number(match[1]);
  const unit = UNIT_MS[match[2]!.toLowerCase()];
  if (!Number.isFinite(amount) || amount <= 0 || !unit) return fallbackMs;

  return Math.round(amount * unit);
}
