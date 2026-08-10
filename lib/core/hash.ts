/**
 * Stable hashing utilities for query keys
 * Ensures consistent hashing even with object property reordering
 */

/**
 * Stable serialization that ensures consistent key ordering.
 *
 * Matches `JSON.stringify` semantics (toJSON honored, undefined/function values
 * dropped from objects and nulled in arrays, NaN/Infinity → null, BigInt throws)
 * with two deliberate differences: object keys are sorted, and true cycles encode
 * as a `"__circular"` marker instead of throwing. The cycle guard tracks only the
 * *current path* of ancestors — a shared (DAG) reference appearing twice as a
 * sibling serializes normally both times, so two structurally identical queries
 * hash identically regardless of object aliasing.
 */
function stableSerialize(value: unknown): string {
  const out = serialize(value, new Set<object>())
  // A top-level value with no JSON form (undefined, function, symbol) has no
  // stable identity — fail loudly rather than hash an empty string.
  if (out === undefined) {
    throw new TypeError('hashObject: value has no serializable form')
  }
  return out
}

function serialize(value: unknown, path: Set<object>): string | undefined {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') {
    return JSON.stringify(value) // JSON escaping; NaN/Infinity → 'null'
  }
  if (t === 'bigint') {
    throw new TypeError('Do not know how to serialize a BigInt')
  }
  if (t !== 'object') return undefined // undefined, function, symbol

  const obj = value as object

  // toJSON runs first, exactly as in JSON.stringify (this is what turns Dates
  // inside query filters into ISO strings).
  const toJSON = (obj as { toJSON?: () => unknown }).toJSON
  if (typeof toJSON === 'function') {
    return serialize(toJSON.call(obj), path)
  }

  if (path.has(obj)) return '"__circular"'
  path.add(obj)
  try {
    if (Array.isArray(obj)) {
      let out = '['
      for (let i = 0; i < obj.length; i++) {
        if (i > 0) out += ','
        out += serialize(obj[i], path) ?? 'null'
      }
      return out + ']'
    }
    const record = obj as Record<string, unknown>
    let out = '{'
    let first = true
    for (const key of Object.keys(record).sort()) {
      const child = serialize(record[key], path)
      if (child === undefined) continue
      if (!first) out += ','
      first = false
      out += JSON.stringify(key) + ':' + child
    }
    return out + '}'
  } finally {
    path.delete(obj)
  }
}

// FNV-1a 32-bit parameters. Two independent accumulators with different offset
// bases give us 64 bits of key space — a single 32-bit hash starts colliding at
// realistic query-count scales (birthday bound: ~1% at 10k distinct keys), and a
// collision here silently serves one query's data to another. 64 bits pushes the
// same odds past 10^-11.
const FNV_PRIME = 0x01000193
const FNV_OFFSET_A = 0x811c9dc5
// Low 32 bits of the FNV-1a 64-bit offset basis — an arbitrary but fixed second seed.
const FNV_OFFSET_B = 0xcbf29ce4

/**
 * Creates a 64-bit hash of an object (two FNV-1a passes with independent seeds)
 * and returns it as a base64 string suitable for use as a cache key.
 *
 * Features:
 * - Deterministic: Same input always produces same hash
 * - Stable: Object key order doesn't affect hash
 * - Fast: FNV-1a is efficient for frequent operations
 *
 * Inputs must be JSON-serializable (cycles are tolerated and encoded as a
 * marker; function-valued properties are dropped by JSON semantics). A value
 * JSON.stringify cannot encode (e.g. BigInt) throws — a loud failure at query
 * creation is strictly better than a silent fallback key that could collide
 * with (or fail to match) another query's cache entry.
 */
export function hashObject(obj: unknown): string {
  const str = stableSerialize(obj)

  let hashA = FNV_OFFSET_A
  let hashB = FNV_OFFSET_B
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    hashA ^= c
    hashA = Math.imul(hashA, FNV_PRIME)
    hashB ^= c
    hashB = Math.imul(hashB, FNV_PRIME)
  }

  // Convert to unsigned 32-bit integers
  hashA >>>= 0
  hashB >>>= 0

  return numbersToBase64(hashA, hashB)
}

/**
 * Converts two 32-bit numbers to base64 (8 bytes → 12 chars)
 */
function numbersToBase64(a: number, b: number): string {
  const bytes = new Uint8Array(8)
  bytes[0] = (a >> 24) & 0xff
  bytes[1] = (a >> 16) & 0xff
  bytes[2] = (a >> 8) & 0xff
  bytes[3] = a & 0xff
  bytes[4] = (b >> 24) & 0xff
  bytes[5] = (b >> 16) & 0xff
  bytes[6] = (b >> 8) & 0xff
  bytes[7] = b & 0xff
  return bytesToBase64(bytes)
}

/**
 * Converts bytes to base64 string
 * Handles both Node.js and browser environments
 */
function bytesToBase64(bytes: Uint8Array): string {
  // Use Buffer in Node.js for better performance
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime check for Node.js Buffer
  const B = (globalThis as any).Buffer as
    { from(input: Uint8Array): { toString(encoding: string): string } } | undefined
  if (typeof B !== 'undefined') {
    return B.from(bytes).toString('base64')
  }

  return btoa(String.fromCharCode(...bytes))
}
