import { isPlainRecord } from './valueEquality.js'

/**
 * Replace Date values in plain objects and arrays with their JSON form: the ISO
 * string they take on the wire and in the rows the server sends (null for an
 * invalid Date, as JSON.stringify does). Values without a Date keep their identity.
 */
export function datesToIso(value: unknown): unknown {
  if (value instanceof Date) return value.toJSON()
  if (Array.isArray(value)) {
    const next = value.map(datesToIso)
    return next.some((item, index) => item !== value[index]) ? next : value
  }
  if (isPlainRecord(value)) {
    const entries = Object.entries(value)
    const next = entries.map(([key, item]) => [key, datesToIso(item)] as const)
    return next.some(([, item], index) => item !== entries[index]![1])
      ? Object.fromEntries(next)
      : value
  }
  return value
}

/**
 * Drop undefined values from plain objects at every depth, and turn them into null
 * inside arrays: what JSON does to a query on its way to the server, and what the
 * cache key does when hashing it.
 */
export function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => (item === undefined ? null : withoutUndefined(item)))
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, withoutUndefined(item)]),
    )
  }
  return value
}
