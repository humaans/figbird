import { useCallback } from 'react'
import { createContext } from 'kinfolk'
import { useFigbird } from './context'
import { matcher as defaultMatcher } from '../core/filterQuery'
import { getIn, setIn, unsetIn, forEachObj } from '../core/helpers'

export const { Provider, atom, selector, useSelector, useReducer, useSetter } = createContext()

export const cache = atom({}, { label: 'figbird' })

export function useDispatch() {
  return useSetter(cache)
}

const dataSelector = selector(
  queryId => {
    const { queries, entities, lookups } = cache()
    const serviceName = getIn(lookups, ['serviceNamesByQueryId', queryId])
    console.log('LOOKSIES', queryId, queries, lookups)
    const query = getIn(queries, [serviceName, queryId])
    if (query) {
      const items = query.entities || entities[serviceName]
      console.log('SELECING!?')
      return query.selectData(query.data.map(id => items[id]))
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
    return data ? { ...meta, data } : null
  },
  { label: 'figbird:query', persist: false },
)

export function useCache(resourceDescriptor) {
  const { queryId, serviceName, method, params, realtime, selectData, matcher } = resourceDescriptor
  // const dispatch = useDispatch()
  const cachedResult = useSelector(() => querySelector(queryId), [queryId], {
    label: 'figbird:cache',
  })
  // const updateCache = useCallback(
  //   data =>
  //     dispatch({
  //       event: 'fetched',
  //       queryId,
  //       serviceName,
  //       method,
  //       params,
  //       realtime,
  //       selectData,
  //       matcher,
  //       data,
  //     }),
  //   [dispatch, queryId, serviceName, method, params, realtime, selectData, matcher],
  // )

  return cachedResult
}
