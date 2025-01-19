export function hashObject(obj) {
  let hash = 0
  const str = JSON.stringify(obj)
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash |= 0 // Convert to 32bit integer
  }
  return numberToBase64(hash)
}

function numberToBase64(num) {
  const buffer = new ArrayBuffer(8)
  const view = new DataView(buffer)
  view.setFloat64(0, num)
  const string = String.fromCharCode.apply(null, new Uint8Array(buffer))
  // Encode the string to base64
  return btoa(string)
}
