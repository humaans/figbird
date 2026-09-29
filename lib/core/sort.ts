/**
 * `$sort` ordering — figbird sorts rows itself for local finds against a
 * materialized service, window maintenance when merging realtime events, and the
 * `figbird/testing` mock server. Every one of those paths builds its row
 * comparator here, from the instance's single value comparator (the `compare`
 * option on `new Figbird`, defaulting to `compareValues`). One comparator means
 * a locally-maintained window never disagrees with itself; it agrees with the
 * server exactly as far as that comparator mirrors the backend's ordering.
 */

/**
 * Compares two field values in ascending order (negative, zero, positive);
 * `$sort: -1` negates the result.
 */
export type ValueComparator = (a: unknown, b: unknown) => number

/** Dates compare as their JSON form, so they order by time and match ISO strings. */
const comparable = (value: unknown): unknown => (value instanceof Date ? value.toJSON() : value)

/**
 * The default value comparator: null/undefined sort first, numbers numerically,
 * everything else by codepoint string comparison (deliberately not locale
 * collation — stable across environments and cheap).
 */
export function compareValues(a: unknown, b: unknown): number {
  a = comparable(a)
  b = comparable(b)
  if (a === b) return 0
  if (a === undefined || a === null) return b === undefined || b === null ? 0 : -1
  if (b === undefined || b === null) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

/** Build a row comparator from a `$sort` map (`{ field: 1 | -1, ... }`). */
export function buildComparator(
  sort: Record<string, number>,
  compare: ValueComparator,
): (a: unknown, b: unknown) => number {
  const entries = Object.entries(sort)
  return (a, b) => {
    for (const [field, direction] of entries) {
      const cmp = compare(
        (a as Record<string, unknown>)[field],
        (b as Record<string, unknown>)[field],
      )
      if (cmp !== 0) return direction === -1 ? -cmp : cmp
    }
    return 0
  }
}
