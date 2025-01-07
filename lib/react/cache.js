import { createContext } from 'kinfolk'
import { getIn } from '../core/helpers'

export { createStore } from 'kinfolk'

export const { Provider, atom, selector, useSelector, useReducer, useSetter } = createContext()

export const cache = atom({}, { label: 'figbird' })

export function useDispatch() {
  return useSetter(cache)
}

export function useCache({ queryId }) {
  return useSelector(
    () => {
      const { queries, lookups } = cache()
      const serviceName = getIn(lookups, ['serviceNamesByQueryId', queryId])
      const query = getIn(queries, [serviceName, queryId])

      if (!query)
        return {
          data: null,
          error: null,
          status: 'loading',
          isFetching: true,
        }

      const data = query.method === 'get' ? query.data[0] : query.data

      // TODO - bonkers, don't re-flash blank data if refetching
      // keep the cached one, but on mount - don't use it
      // does that mean it's per component!? let's try to avoid that I think
      // if (query.fetchPolicy === 'network-only' && query.fetching) {
      //   return {
      //     ...query.meta,
      //     data: null,
      //     error: null,
      //     status: 'loading',
      //     isFetching: query.fetching,
      //   }
      // }

      return {
        ...query.meta,
        data: query.error ? null : data,
        error: query.error || null,
        status: query.status,
        isFetching: query.fetching,
      }
    },
    [queryId],
    {
      label: 'figbird:cache',
    },
  )
}
