import sift from 'sift'
import filterQuery from '@feathersjs/adapter-commons/lib/filter-query'

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

export function isObject(obj) {
  return typeof obj === 'object' && obj !== null
}

export function matcher(query) {
  const { query: filteredQuery } = filterQuery(query)
  const sifter = sift(filteredQuery)
  return item => sifter(item)
}

export function hashObject(obj) {
  let hash = 0
  const str = JSON.stringify(obj)

  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash // Convert to 32bit integer
  }

  return hash
}

export function forEachObj(obj, fn) {
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      fn(obj[key], key, obj)
    }
  }
}
