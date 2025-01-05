import { createContext } from 'kinfolk'
import { getIn } from '../core/helpers'

export const { Provider, atom, selector, useSelector, useReducer, useSetter } = createContext()

export const cache = atom({}, { label: 'figbird' })

export function useDispatch() {
  return useSetter(cache)
}

const dataSelector = selector(
  queryId => {
    const { queries, entities, lookups } = cache()
    const serviceName = getIn(lookups, ['serviceNamesByQueryId', queryId])
    const query = getIn(queries, [serviceName, queryId])
    if (query) {
      if (query.error) {
        return { data: null, error: query.error }
      }

      const items = query.entities || entities[serviceName]
      const cachedResult =
        query.method === 'get' ? items[query.data[0]] : query.data.map(id => items[id])

      if (query.error) {
        cachedResult.error = query.error
      }

      return cachedResult
    } else {
      return null
    }
  },
  { label: 'figbird:data', persist: false },
)

const metaSelector = selector(
  queryId => {
    const { queries, lookups } = cache()
    const serviceName = getIn(lookups, ['serviceNamesByQueryId', queryId])
    const query = getIn(queries, [serviceName, queryId])
    if (query) {
      return query.meta
    } else {
      return null
    }
  },
  { label: 'figbird:meta', persist: false },
)

export const querySelector = selector(
  queryId => {
    const data = dataSelector(queryId)
    const meta = metaSelector(queryId)

    // TODO - unpack shit
    if (data?.error) {
      return { ...meta, ...data }
    }

    return data ? { ...meta, data } : null
  },
  { label: 'figbird:query', persist: false },
)

export function useCache(resourceDescriptor) {
  const { queryId } = resourceDescriptor
  const cachedResult = useSelector(() => querySelector(queryId), [queryId], {
    label: 'figbird:cache',
  })
  return cachedResult
}
