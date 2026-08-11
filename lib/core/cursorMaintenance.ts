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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
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

function sameValue(
  left: unknown,
  right: unknown,
  seen: WeakMap<object, object> = new WeakMap(),
): boolean {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime()
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    if (seen.get(left) === right) return true
    seen.set(left, right)
    return left.every((value, index) => sameValue(value, right[index], seen))
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false
  if (seen.get(left) === right) return true
  seen.set(left, right)
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key], seen))
  )
}
