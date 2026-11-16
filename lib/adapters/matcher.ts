import sift from 'sift'
import {
  LOCAL_QUERY_OPERATORS,
  PROJECTION_QUERY_FILTERS,
  SERVER_WINDOW_QUERY_FILTERS,
} from '../core/queryClassification.js'

export interface Query {
  [key: string]: string | number | boolean | null | undefined | Query | Query[]
}

type QueryValue = string | number | boolean | null | undefined | Query | Query[]

export interface PrepareQueryOptions {
  filters?: string[]
  operators?: string[]
}

function cleanQuery(query: QueryValue, operators: string[], filters: string[]): QueryValue {
  // Rows arrive over the wire with dates as ISO strings, so compare against that
  // form (toJSON, as the wire does: an invalid Date becomes null) — a Date operand
  // never matches a string, and would otherwise be rebuilt below as an empty object.
  if ((query as unknown) instanceof Date) {
    return (query as unknown as Date).toJSON()
  } else if (Array.isArray(query)) {
    // JSON turns undefined inside an array into null, and so does the cache key.
    return query.map(value =>
      value === undefined ? null : cleanQuery(value, operators, filters),
    ) as QueryValue
  } else if (isObject(query)) {
    const result: Query = {}

    Object.keys(query).forEach(key => {
      const value = query[key]
      // An undefined value is not part of the query: JSON and query strings drop
      // the key, so the server never filters on it, and the cache key ignores it.
      // Matching it here as "field is null" would evict rows the server returned.
      if (value === undefined) return

      if (key[0] === '$') {
        if (filters.includes(key)) {
          return
        }

        if (!operators.includes(key)) {
          throw new Error(`Invalid query parameter ${key}`)
        }
      }

      const cleaned = cleanQuery(value, operators, filters)
      // A filter UI with nothing selected builds `$or: []`. sift throws on it; it
      // constrains nothing, which is also what a query string sends.
      if ((key === '$or' || key === '$and') && Array.isArray(cleaned) && cleaned.length === 0) {
        return
      }

      result[key] = cleaned
    })

    return result
  }
  return query
}

// Feathers control fields that are stripped from queries before matching, and the
// operators preserved for matching — derived from classification's canonical sets
// so "what the matcher evaluates" and "what classifies as local" cannot drift.
export const FILTERS = [...SERVER_WINDOW_QUERY_FILTERS, ...PROJECTION_QUERY_FILTERS]
export const OPERATORS = [...LOCAL_QUERY_OPERATORS]

// Removes special filters from the `query` parameters
export function prepareQuery(
  query: Query | undefined,
  options: PrepareQueryOptions = {},
): Query | undefined {
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

export function matcher<T>(
  query: Query | undefined,
  options?: PrepareQueryOptions,
): (item: T) => boolean {
  if (!query || Object.keys(query).length === 0) return () => true
  const preparedQuery = prepareQuery(query, options)
  if (!preparedQuery) return () => true
  const sifter = sift(preparedQuery)
  return (item: T) => sifter(item)
}
