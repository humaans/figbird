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

  try {
    return JSON.stringify(value, replacer)
  } catch (error) {
    // Fallback for any edge cases
    console.error('Serialization error in hash:', error)
    return JSON.stringify({ error: 'serialization_failed', type: typeof value })
  }
}

/**
 * Creates a hash of an object using FNV-1a algorithm
 * Returns a base64 string suitable for use as a cache key
 *
 * Features:
 * - Deterministic: Same input always produces same hash
 * - Stable: Object key order doesn't affect hash
 * - Fast: FNV-1a is efficient for frequent operations
 * - Collision-resistant: Sufficient for typical query caching needs
 */
export function hashObject(obj: unknown): string {
  try {
    // Get stable serialization
    const str = stableSerialize(obj)

    // FNV-1a hash algorithm
    const FNV_PRIME = 0x01000193
    const FNV_OFFSET = 0x811c9dc5

    let hash = FNV_OFFSET
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i)
      hash = Math.imul(hash, FNV_PRIME)
    }

    // Convert to unsigned 32-bit integer
    hash >>>= 0

    return numberToBase64(hash)
  } catch (error) {
    console.error('Error hashing object:', error)
    // Return a fallback hash based on error and timestamp
    // This ensures we don't break but also don't accidentally share cache
    return numberToBase64(Date.now() & 0xffffffff)
  }
}

/**
 * Converts a 32-bit number to base64
 */
function numberToBase64(num: number): string {
  // Convert number to byte array
  const bytes = new Uint8Array(4)
  bytes[0] = (num >> 24) & 0xff
  bytes[1] = (num >> 16) & 0xff
  bytes[2] = (num >> 8) & 0xff
  bytes[3] = num & 0xff
  return bytesToBase64(bytes)
}

/**
 * Converts bytes to base64 string
 * Handles both Node.js and browser environments
 */
function bytesToBase64(bytes: Uint8Array): string {
  // Use Buffer in Node.js for better performance
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }

  // Browser fallback - handle large arrays safely
  if (bytes.length > 1024) {
    // For large arrays, process in chunks to avoid stack overflow
    let result = ''
    for (let i = 0; i < bytes.length; i += 1024) {
      const chunk = bytes.slice(i, Math.min(i + 1024, bytes.length))
      result += String.fromCharCode(...chunk)
    }
    return btoa(result)
  }

  // Small arrays can be processed directly
  return btoa(String.fromCharCode(...bytes))
}
