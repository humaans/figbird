import sift from 'sift'

interface Query {
  [key: string]: string | number | boolean | null | undefined | Query | Query[]
}

type QueryValue = string | number | boolean | null | undefined | Query | Query[]

interface PrepareQueryOptions {
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

export function matcher<T = any>(
  query: Query | null | undefined,
  options?: PrepareQueryOptions,
): (item: T) => boolean {
  if (!query || Object.keys(query).length === 0) return () => true
  const preparedQuery = prepareQuery(query, options)
  const sifter = sift(preparedQuery as any)
  return (item: T) => sifter(item)
}
