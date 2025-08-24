import sift from 'sift'

interface Query {
  [key: string]: string | number | boolean | null | undefined | Query | Query[]
}

type QueryValue = string | number | boolean | null | undefined | Query | Query[]

export interface PrepareQueryOptions {
  filters?: string[]
  operators?: string[]
}

function cleanQuery(query: QueryValue, operators: string[], filters: string[]): QueryValue {
  if (Array.isArray(query)) {
    return query.map(value => cleanQuery(value, operators, filters)) as QueryValue
  } else if (isObject(query)) {
    const result: Query = {}

    Object.keys(query).forEach(key => {
      const value = query[key]
      if (key[0] === '$') {
        if (filters.includes(key)) {
          return
        }

        if (!operators.includes(key)) {
          throw new Error(`Invalid query parameter ${key}`)
        }
      }

      result[key] = cleanQuery(value, operators, filters)
    })

    return result
  }
  return query
}

export const FILTERS = ['$sort', '$limit', '$skip', '$select']
export const OPERATORS = ['$in', '$nin', '$lt', '$lte', '$gt', '$gte', '$ne', '$or']

// Operators that sift understands
const SIFT_OPERATORS = [
  '$in',
  '$nin',
  '$lt',
  '$lte',
  '$gt',
  '$gte',
  '$ne',
  '$or',
  '$and',
  '$not',
  '$nor',
  '$exists',
  '$regex',
]

// Removes special filters from the `query` parameters
export function prepareQuery(
  query: Query | null | undefined,
  options: PrepareQueryOptions = {},
): Query | null | undefined {
  if (!query) return query
  const { filters: additionalFilters = [], operators: additionalOperators = [] } = options
  return cleanQuery(
    query,
    OPERATORS.concat(additionalOperators),
    FILTERS.concat(additionalFilters),
  ) as Query
}

function isObject(obj: unknown): obj is Query {
  return typeof obj === 'object' && obj !== null && !Array.isArray(obj)
}

// Remove operators that sift doesn't understand
function filterCustomOperators(query: Query): Query {
  const result: Query = {}

  for (const [key, value] of Object.entries(query)) {
    // Keep non-operator keys and sift-compatible operators
    if (!key.startsWith('$') || SIFT_OPERATORS.includes(key)) {
      if (isObject(value)) {
        result[key] = filterCustomOperators(value)
      } else if (Array.isArray(value)) {
        result[key] = value.map(v => (isObject(v) ? filterCustomOperators(v) : v))
      } else {
        result[key] = value
      }
    }
  }

  return result
}

export function matcher<T>(
  query: Query | null | undefined,
  options?: PrepareQueryOptions,
): (item: T) => boolean {
  if (!query || Object.keys(query).length === 0) return () => true
  const preparedQuery = prepareQuery(query, options)
  if (!preparedQuery) return () => true
  // Filter out custom operators that sift doesn't understand
  const siftCompatibleQuery = filterCustomOperators(preparedQuery)
  const sifter = sift(siftCompatibleQuery)
  return (item: T) => sifter(item)
}
