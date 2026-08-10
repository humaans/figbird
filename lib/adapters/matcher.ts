import sift from 'sift'
import {
  LOCAL_QUERY_OPERATORS,
  SERVER_ONLY_QUERY_FILTERS,
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

// Feathers control fields that are stripped from queries before matching, and the
// operators preserved for matching — derived from classification's canonical sets
// so "what the matcher evaluates" and "what classifies as local" cannot drift.
export const FILTERS = [...SERVER_WINDOW_QUERY_FILTERS, ...SERVER_ONLY_QUERY_FILTERS]
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
