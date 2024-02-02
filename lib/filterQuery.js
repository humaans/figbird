function cleanQuery(query, operators, filters) {
  if (Array.isArray(query)) {
    return query.map(value => cleanQuery(value, operators, filters))
  } else if (isObject(query)) {
    const result = {}

    Object.keys(query).forEach(key => {
      const value = query[key]
      if (key[0] === '$') {
        if (filters.includes(key)) {
          return
        }

        if (!operators.includes(key)) {
          throw new Error(`Invalid query parameter ${key}`, query)
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
export function filterQuery(query, options = {}) {
  if (!query) return query
  const { filters: additionalFilters = [], operators: additionalOperators = [] } = options
  return cleanQuery(query, OPERATORS.concat(additionalOperators), FILTERS.concat(additionalFilters))
}

function isObject(obj) {
  return typeof obj === 'object' && obj !== null
}
