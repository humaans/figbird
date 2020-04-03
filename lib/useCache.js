import { useRef } from 'react'
import { useFigbird } from './core'
import { namespace } from './namespace'
import { getIn } from './helpers'

export function useCache(resourceDescriptor) {
  const {
    serviceName,
    queryId,
    method,
    id,
    params,
    realtime,
    selectData,
    transformResponse,
    additionalFilters,
    additionalOperators,
  } = resourceDescriptor

  const { actions, useSelector } = useFigbird()

  // we'll use a cheeky ref to store the previous mapped data array
  // because if the underlying list of data didn't change we don't
  // want consumers of useFind to have to worry about changing reference
  const dataRef = useRef([])

  const cachedData = useSelector(
    state => {
      const query = getIn(state, [namespace, 'queries', serviceName, queryId])
      if (query) {
        let { data, meta } = query
        const entities = query.entities || getIn(state, [namespace, 'entities', serviceName])
        data = data.map(id => entities[id])
        if (same(data, dataRef.current)) {
          data = dataRef.current
        } else {
          dataRef.current = data
        }
        data = selectData(data)
        return { ...meta, data }
      } else {
        return { data: null }
      }
    },
    { deps: [serviceName, queryId, selectData] }
  )

  const onFetched = data =>
    actions.feathersFetched({
      serviceName,
      queryId,
      method,
      params,
      data: {
        ...transformResponse(data),
        ...(id ? { id } : {}),
      },
      realtime,
      additionalFilters,
      additionalOperators,
    })

  return [cachedData, onFetched]
}

function same(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
