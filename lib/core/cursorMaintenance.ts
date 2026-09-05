import { isPlainRecord, sameValue } from './valueEquality.js'

/**
 * Prove that an update cannot change a cursor-paginated query's membership or
 * ordering. The proof is deliberately structural: every explicit filter and
 * sort field must exist on both row versions and retain the same value. Unknown
 * query controls and implicit server ordering are not guessable, so they fail
 * closed and force reconciliation.
 */
export function cursorQueryInputsUnchanged(
  query: unknown,
  previousItem: unknown,
  item: unknown,
): boolean {
  const paths = collectCursorQueryInputPaths(query)
  if (!paths) return false

  for (const path of paths) {
    const previous = readItemPath(previousItem, path)
    const next = readItemPath(item, path)
    if (!previous.found || !next.found || !sameValue(previous.value, next.value)) return false
  }
  return true
}

/** Whether the query shape can ever support the stable-update proof. */
export function cursorQueryCanKeepPrefix(query: unknown): boolean {
  return collectCursorQueryInputPaths(query) !== null
}

function collectCursorQueryInputPaths(query: unknown): Set<string> | null {
  if (!isPlainRecord(query)) return null
  const paths = new Set<string>()
  let hasExplicitSort = false

  const visitClause = (clause: Record<string, unknown>, root: boolean): boolean => {
    for (const [key, value] of Object.entries(clause)) {
      if (key === '$sort') {
        if (!root || !isPlainRecord(value) || Object.keys(value).length === 0) return false
        hasExplicitSort = true
        for (const field of Object.keys(value)) paths.add(field)
      } else if (key === '$or') {
        if (!Array.isArray(value)) return false
        for (const branch of value) {
          if (!isPlainRecord(branch) || !visitClause(branch, false)) return false
        }
      } else if (key.startsWith('$')) {
        // Top-level custom/search/projection controls may depend on arbitrary
        // server state. Comparison operators are safe only inside a field value,
        // which this traversal intentionally treats as opaque.
        return false
      } else {
        paths.add(key)
      }
    }
    return true
  }

  if (!visitClause(query, true) || !hasExplicitSort) return null
  return paths
}

function readItemPath(item: unknown, path: string): { found: boolean; value?: unknown } {
  if (!item || typeof item !== 'object') return { found: false }
  const record = item as Record<string, unknown>
  if (Object.hasOwn(record, path)) return { found: true, value: record[path] }

  let value: unknown = item
  for (const part of path.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) {
      return { found: false }
    }
    value = (value as Record<string, unknown>)[part]
  }
  return { found: true, value }
}
