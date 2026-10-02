// Whitelists sortBy against a fixed set of real column names before it ever
// reaches a Prisma `orderBy` (spec Phase 10 §"SORTING": "Never directly
// inject user-provided SQL column names"). An unrecognized field silently
// falls back to `fallback` rather than erroring - a stale/mismatched client
// value should never turn into a 500.
export function resolveSortField<T extends string>(requested: string | undefined, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(requested ?? '') ? (requested as T) : fallback;
}

export function resolveSortOrder(requested: string | undefined): 'asc' | 'desc' {
  return requested === 'asc' ? 'asc' : 'desc';
}
