import sift from 'sift'
import { filterQuery } from './filterQuery'

export function getIn(obj, path) {
  for (const segment of path) {
    if (obj) {
      obj = obj[segment]
    }
  }
  return obj
}

export function setIn(obj, path, value) {
  obj = isObject(obj) ? { ...obj } : {}
  const res = obj

  for (let i = 0; i < path.length; i++) {
    const segment = path[i]
    if (i === path.length - 1) {
      obj[segment] = value
    } else {
      obj[segment] = isObject(obj[segment]) ? { ...obj[segment] } : {}
      obj = obj[segment]
    }
  }

  return res
}

export function unsetIn(obj, path) {
  obj = isObject(obj) ? { ...obj } : {}
  const res = obj

  for (let i = 0; i < path.length; i++) {
    const segment = path[i]
    if (i === path.length - 1) {
      delete obj[segment]
    } else {
      if (isObject(obj[segment])) {
        obj = obj[segment]
      } else {
        break
      }
    }
  }

  return res
}

export function isObject(obj) {
  return typeof obj === 'object' && obj !== null
}

export function matcher(query, options) {
  const filteredQuery = filterQuery(query, options)
  const sifter = sift(filteredQuery)
  return item => sifter(item)
}

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

export function forEachObj(obj, fn) {
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      fn(obj[key], key, obj)
    }
  }
}

export function inflight(makeKey, fn) {
  const flying = {}

  return (...args) => {
    const key = makeKey(...args)

    if (flying[key]) {
      return flying[key]
    }

    const res = fn(...args)
    flying[key] = res
      .then(res => {
        delete flying[key]
        return res
      })
      .catch(err => {
        delete flying[key]
        throw err
      })

    return flying[key]
  }
}
