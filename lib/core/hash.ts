// Creates a hash of an object and returns it as a base64 string
export function hashObject(obj: any): string {
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
  return btoa(String.fromCharCode(...bytes))
}
