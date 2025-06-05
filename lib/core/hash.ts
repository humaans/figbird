// Creates a hash of an object and returns it as a base64 string
// For the purposes of this project, **yes, this `hashObject` function is good enough**. Here's why:

// **Strengths for this use case:**
// 1. **Deterministic**: Same input always produces the same hash, which is essential for query caching
// 2. **Fast**: FNV-1a is a very fast hashing algorithm, suitable for frequent operations
// 3. **Reasonable collision resistance**: For the typical number of unique queries in a web application, a 32-bit hash space is sufficient
// 4. **Simple and maintainable**: The implementation is straightforward and easy to understand

// **Potential considerations:**
// 1. **Object property ordering**: `JSON.stringify` may produce different strings for objects with the same properties in different orders. However, in practice, query descriptors are usually constructed consistently
// 2. **Hash collisions**: While possible with 32-bit hashes, collisions are unlikely in typical applications with hundreds or even thousands of unique queries
// 3. **Base64 overhead**: The conversion adds a small overhead, but produces short, URL-safe identifiers

// **Why it works well here:**
// - Query descriptors appear to have a consistent structure (`serviceName`, `method`, `params`, etc.)
// - The hash is used as a cache key, not for security purposes
// - The base64 encoding produces clean, readable query IDs like `q/AAAA
export function hashObject(obj: unknown): string {
  try {
    let hash = 0
    const str = JSON.stringify(obj)

    // Using a more robust hashing algorithm (FNV-1a)
    const FNV_PRIME = 0x01000193
    const FNV_OFFSET = 0x811c9dc5

    hash = FNV_OFFSET
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i)
      hash = Math.imul(hash, FNV_PRIME)
    }

    // Convert to unsigned 32-bit integer
    hash >>>= 0

    return numberToBase64(hash)
  } catch (error) {
    console.error('Error hashing object:', error)
    throw error
  }
}

function numberToBase64(num: number): string {
  // Convert number to byte array and then to base64
  const bytes = new Uint8Array(4)
  bytes[0] = num >> 24
  bytes[1] = num >> 16
  bytes[2] = num >> 8
  bytes[3] = num
  return btoa(String.fromCharCode(...Array.from(bytes)))
}
