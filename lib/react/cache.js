import { createContext } from 'kinfolk'
import { getIn } from '../core/helpers'

export { createStore } from 'kinfolk'

export const { Provider, atom, selector, useSelector, useReducer, useSetter } = createContext()

export const cache = atom({}, { label: 'figbird' })

export function useDispatch() {
  return useSetter(cache)
}

export function useCache(queryId) {
  return useSelector(
    () => {
      const { queries, lookups } = cache()
      const serviceName = getIn(lookups, ['serviceNamesByQueryId', queryId])
      const query = getIn(queries, [serviceName, queryId])

      if (!query) {
        return {
          data: null,
          error: null,
          status: 'loading',
          isFetching: true,
        }
      } else if (query.error) {
        return {
          data: null,
          error: query.error,
          status: 'error',
          status: query.status,
          isFetching: query.fetching,
        }
      } else {
        const data = query.method === 'get' ? query.data?.[0] : query.data
        return {
          ...query.meta,
          data,
          error: null,
          status: query.status,
          isFetching: query.fetching,
        }
      }
    },
    [queryId],
    { label: 'figbird:cache' },
  )
}
