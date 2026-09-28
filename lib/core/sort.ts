/**
 * `$sort` ordering — figbird sorts rows itself for local finds against a
 * materialized service, window maintenance when merging realtime events, and the
 * `figbird/testing` mock server. Every one of those paths builds its row
 * comparator here, from the instance's single value comparator (the `compare`
 * option on `new Figbird`, defaulting to `compareValues`). One comparator means
 * a locally-maintained window never disagrees with itself; it agrees with the
 * server exactly as far as that comparator mirrors the backend's ordering.
 */

/** What a value comparator knows about the values it compares. */
export interface CompareContext {
  serviceName: string
  field: string
}

/**
 * Compares two field values in ascending order (negative, zero, positive);
 * `$sort: -1` negates the result.
 */
export type ValueComparator = (a: unknown, b: unknown, context: CompareContext) => number

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

// Built on first use: constructing a collator loads ICU locale data, which an app
// on the default comparator never needs.
let collator: Intl.Collator | undefined

/**
 * A Postgres-like value comparator: nulls sort greatest (NULLS LAST ascending,
 * NULLS FIRST descending — Postgres's defaults) and strings compare by ICU `en`
 * collation. Use it only when the database collation matches ICU `en` (for
 * example `en-x-icu`): glibc `en_US` collations ignore punctuation and spaces at
 * the first level, so `'a-c'` sorts after `'ab'` there but before it here, and a
 * `COLLATE "C"` database orders by codepoint, which the default `compareValues`
 * mirrors.
 */
export function postgresCompare(a: unknown, b: unknown): number {
  a = comparable(a)
  b = comparable(b)
  if (a === b) return 0
  if (a === undefined || a === null) return b === undefined || b === null ? 0 : 1
  if (b === undefined || b === null) return -1
  if (typeof a === 'string' && typeof b === 'string') {
    collator ??= new Intl.Collator('en')
    return collator.compare(a, b)
  }
  return compareValues(a, b)
}

/**
 * How one service's backend orders values, as declared by the server (see
 * `loadServerOrdering`): `preset` picks the base comparator — `default` for
 * `compareValues`, `postgres` for `postgresCompare` — and `numeric` lists fields
 * the backend sorts as numbers but serializes as strings (Postgres `numeric` and
 * `bigint` columns).
 */
export interface ServiceOrdering {
  preset?: 'default' | 'postgres'
  numeric?: readonly string[]
}

const asNumber = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
    ? Number(value)
    : value

/**
 * Build a value comparator from per-service ordering declarations. Services
 * without a declaration compare with `compareValues`.
 */
export function orderingComparator(ordering: Record<string, ServiceOrdering>): ValueComparator {
  const services = new Map(
    Object.entries(ordering).map(([serviceName, { preset, numeric = [] }]) => [
      serviceName,
      {
        compare: preset === 'postgres' ? postgresCompare : compareValues,
        numeric: new Set(numeric),
      },
    ]),
  )
  return (a, b, { serviceName, field }) => {
    const service = services.get(serviceName)
    if (!service) return compareValues(a, b)
    return service.numeric.has(field)
      ? service.compare(asNumber(a), asNumber(b))
      : service.compare(a, b)
  }
}

/** Build a row comparator from a `$sort` map (`{ field: 1 | -1, ... }`). */
export function buildComparator(
  sort: Record<string, number>,
  { compare, serviceName }: { compare: ValueComparator; serviceName: string },
): (a: unknown, b: unknown) => number {
  const entries = Object.entries(sort).map(([field, direction]) => ({
    direction,
    field,
    context: { serviceName, field },
  }))
  return (a, b) => {
    for (const { direction, field, context } of entries) {
      const cmp = compare(
        (a as Record<string, unknown>)[field],
        (b as Record<string, unknown>)[field],
        context,
      )
      if (cmp !== 0) return direction === -1 ? -cmp : cmp
    }
    return 0
  }
}
