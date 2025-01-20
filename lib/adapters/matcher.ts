import sift from 'sift'

interface QueryOptions {
  filters?: string[]
  operators?: string[]
}

type QueryValue = any
type Query = { [key: string]: QueryValue } | QueryValue[]

function cleanQuery(query: Query, operators: string[], filters: string[]): Query {
  if (Array.isArray(query)) {
    return query.map(value => cleanQuery(value, operators, filters))
  } else if (isObject(query)) {
    const result: { [key: string]: QueryValue } = {}

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
export function prepareQuery(query: Query, options: QueryOptions = {}): Query {
  if (!query) return query
  const { filters: additionalFilters = [], operators: additionalOperators = [] } = options
  return cleanQuery(query, OPERATORS.concat(additionalOperators), FILTERS.concat(additionalFilters))
}

function isObject(obj: any): boolean {
  return typeof obj === 'object' && obj !== null
}

export function matcher(query: Query, options: QueryOptions) {
  if (!query || Object.keys(query).length === 0) return () => true
  const preparedQuery = prepareQuery(query, options)
  const sifter = sift(preparedQuery)
  return (item: any) => sifter(item)
}
