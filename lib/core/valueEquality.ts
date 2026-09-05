export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function sameValue(
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
