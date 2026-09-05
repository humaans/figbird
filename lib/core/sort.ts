/**
 * The canonical `$sort` comparator — the one ordering figbird uses everywhere it
 * sorts rows itself: local finds against a materialized service, window
 * maintenance when merging realtime events, and the `figbird/testing` mock
 * server. One comparator means a locally-maintained window can never disagree
 * with the order the "server" returned.
 *
 * Semantics: null/undefined sort first, numbers numerically, everything else by
 * codepoint string comparison (deliberately not locale collation — stable across
 * environments and cheap).
 */
export function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === undefined || a === null) return -1
  if (b === undefined || b === null) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

/** Build a row comparator from a `$sort` map (`{ field: 1 | -1, ... }`). */
export function buildComparator(sort: Record<string, number>): (a: unknown, b: unknown) => number {
  const entries = Object.entries(sort)
  return (a, b) => {
    for (const [field, direction] of entries) {
      const cmp = compareValues(
        (a as Record<string, unknown>)[field],
        (b as Record<string, unknown>)[field],
      )
      if (cmp !== 0) return direction === -1 ? -cmp : cmp
    }
    return 0
  }
}
