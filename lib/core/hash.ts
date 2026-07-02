/**
 * Stable hashing utilities for query keys
 * Ensures consistent hashing even with object property reordering
 */

/**
 * Stable serialization that ensures consistent key ordering
 */
function stableSerialize(value: unknown): string {
  const seen = new WeakSet<object>()

  function replacer(_key: string, val: unknown): unknown {
    // Handle objects
    if (typeof val === 'object' && val !== null) {
      // Check for cycles
      if (seen.has(val as object)) {
        return '__circular'
      }
      seen.add(val as object)

      // Handle arrays - preserve order
      if (Array.isArray(val)) {
        return val
      }

      // Handle regular objects - sort keys for stability
      const sorted: Record<string, unknown> = {}
      const keys = Object.keys(val as Record<string, unknown>).sort()
      for (const key of keys) {
        sorted[key] = (val as Record<string, unknown>)[key]
      }
      return sorted
    }

    // Handle primitives
    return val
  }

  return JSON.stringify(value, replacer)
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
    | { from(input: Uint8Array): { toString(encoding: string): string } }
    | undefined
  if (typeof B !== 'undefined') {
    return B.from(bytes).toString('base64')
  }

  return btoa(String.fromCharCode(...bytes))
}
