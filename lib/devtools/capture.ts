const MAX_DEPTH = 6
const MAX_VALUES = 1_000
const MAX_STRING_LENGTH = 10_000

interface CaptureState {
  chars: number
  seen: WeakSet<object>
  values: number
}

/**
 * Converts an arbitrary application value into a bounded, detached preview.
 * It deliberately avoids toJSON(), getters, and retaining the original object.
 */
export function captureInspectableValue(
  value: unknown,
  transform?: (value: unknown) => unknown,
): unknown {
  let transformed = value
  if (transform) {
    try {
      transformed = transform(value)
    } catch {
      return '[capture failed]'
    }
  }
  try {
    return capture(transformed, { chars: 0, seen: new WeakSet(), values: 0 }, 0)
  } catch {
    return `[uninspectable ${objectNameForUnknown(transformed)}]`
  }
}

function capture(value: unknown, state: CaptureState, depth: number): unknown {
  state.values++
  if (state.values > MAX_VALUES) return '[truncated]'

  if (value === null || value === undefined || typeof value === 'boolean') return value
  if (typeof value === 'string') return captureString(value, state)
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'symbol')
    return value.description ? `Symbol(${value.description})` : 'Symbol()'
  if (typeof value === 'function') return `[Function${value.name ? ` ${value.name}` : ''}]`
  if (typeof value !== 'object') return String(value)

  if (state.seen.has(value)) return '[circular]'
  state.seen.add(value)

  if (value instanceof Date)
    return Number.isNaN(value.valueOf()) ? 'Invalid Date' : value.toISOString()
  if (value instanceof RegExp) return String(value)
  if (value instanceof Error) {
    return {
      name: captureString(value.name, state),
      message: captureString(value.message, state),
    }
  }
  if (ArrayBuffer.isView(value)) {
    return `[${objectName(value)} ${value.byteLength} bytes]`
  }
  if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    const name =
      typeof File !== 'undefined' && value instanceof File && value.name ? ` ${value.name}` : ''
    return `[${objectName(value)}${name} ${value.size} bytes]`
  }
  if (depth >= MAX_DEPTH) return `[${objectName(value)}]`

  if (Array.isArray(value)) {
    const result: unknown[] = []
    for (const item of value) {
      if (state.values >= MAX_VALUES) {
        result.push('[truncated]')
        break
      }
      result.push(capture(item, state, depth + 1))
    }
    return result
  }

  if (value instanceof Map) {
    const entries: unknown[] = []
    for (const [key, item] of value) {
      if (state.values >= MAX_VALUES) {
        entries.push('[truncated]')
        break
      }
      entries.push([capture(key, state, depth + 1), capture(item, state, depth + 1)])
    }
    return { type: 'Map', entries }
  }

  if (value instanceof Set) {
    const values: unknown[] = []
    for (const item of value) {
      if (state.values >= MAX_VALUES) {
        values.push('[truncated]')
        break
      }
      values.push(capture(item, state, depth + 1))
    }
    return { type: 'Set', values }
  }

  let descriptors: PropertyDescriptorMap
  try {
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    return `[uninspectable ${objectName(value)}]`
  }

  const result: Record<string, unknown> = {}
  for (const [rawKey, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable) continue
    if (state.values >= MAX_VALUES) {
      result['[truncated]'] = true
      break
    }
    const key = rawKey.length > 200 ? `${rawKey.slice(0, 200)}...` : rawKey
    result[key] =
      'value' in descriptor
        ? capture(descriptor.value, state, depth + 1)
        : descriptor.get
          ? '[Getter]'
          : '[Accessor]'
  }
  return result
}

function captureString(value: string, state: CaptureState): string {
  const remaining = MAX_STRING_LENGTH - state.chars
  if (remaining <= 0) return '[truncated]'
  if (value.length <= remaining) {
    state.chars += value.length
    return value
  }
  state.chars = MAX_STRING_LENGTH
  return `${value.slice(0, Math.max(0, remaining))}...`
}

function objectName(value: object): string {
  try {
    return Object.prototype.toString.call(value).slice(8, -1) || 'Object'
  } catch {
    return 'Object'
  }
}

function objectNameForUnknown(value: unknown): string {
  return typeof value === 'object' && value !== null ? objectName(value) : typeof value
}
