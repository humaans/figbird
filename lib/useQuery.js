import { useReducer, useEffect, useRef, useCallback } from 'react'
import { useFigbird } from './core'
import { useRealtime } from './useRealtime'
import { useCache } from './useCache'
import { hashObject, inflight } from './helpers'

const get = inflight((service, id, params, options) => `${service.path}/${options.queryId}`, getter)
const find = inflight((service, params, options) => `${service.path}/${options.queryId}`, finder)

/**
 * A generic abstraction of both get and find
 */
export function useQuery(serviceName, options = {}, queryHookOptions = {}) {
  const { method, id, selectData, transformResponse } = queryHookOptions

  const { feathers } = useFigbird()
  const disposed = useRef(false)

  let {
    skip,
    allPages,
    realtime = 'merge',
    // TODO - replace with matcher function
    additionalFilters,
    additionalOperators,
    ...params
  } = options

  realtime = realtime || 'disabled'
  if (realtime !== 'disabled' && realtime !== 'merge' && realtime !== 'refetch') {
    throw new Error('Bad realtime option, must be be merge, refetch or falsy')
  }

  const queryId = `${method.substr(0, 1)}:${hashObject({
    serviceName,
    method,
    id,
    params,
    realtime,
  })}`

  const [cachedData, updateCache] = useCache({
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
  })

  const hasCachedData = !!cachedData.data

  const [state, dispatch] = useReducer(reducer, {
    reloading: false,
    fetched: false,
    refetchSeq: 0,
    error: null,
  })

  const handleRealtimeEvent = useCallback(
    payload => {
      if (disposed.current) return
      if (realtime !== 'refetch') return
      dispatch({ type: 'refetch' })
    },
    [dispatch, realtime, disposed]
  )

  useEffect(() => {
    return () => {
      disposed.current = true
    }
  }, [])

  useEffect(() => {
    let disposed = false

    if (state.fetched) return
    if (skip) return

    dispatch({ type: 'fetching' })
    const service = feathers.service(serviceName)
    const result =
      method === 'get'
        ? get(service, id, params, { queryId })
        : find(service, params, { queryId, allPages })

    result
      .then(res => {
        // no res means we've piggy backed on an in flight request
        if (res) {
          // TODO - always update, or else we don't create queries?
          // or is the idea that if we're piggy backing, it also means
          // this query is shared, I think so. Separate from counting
          // component refs. But now with local entities for realtime: refetch|disabled
          // we need an ability to pass res to every caller (?). Also not true,
          // because same queryId = same cache.
          updateCache(res)
        }

        if (!disposed) {
          dispatch({ type: 'success' })
        }
      })
      .catch(err => {
        if (!disposed) {
          dispatch({ type: 'error', payload: err })
        }
      })

    return () => {
      disposed = true
    }
  }, [serviceName, queryId, state.fetched, state.refetchSeq, skip, allPages])

  // If serviceName or queryId changed, we should refetch the data
  useEffect(() => {
    dispatch({ type: 'reset' })
  }, [serviceName, queryId])

  // once the data is placed into cache and we've received it at this end
  // mark the local state as success and also note down the cache status
  useEffect(() => {
    dispatch({ type: 'updateHasCachedData', hasCachedData })
  }, [hasCachedData])

  // realtime hook will make sure we're listening to all of the
  // updates to this service
  useRealtime(serviceName, realtime, handleRealtimeEvent)

  // derive the loading/reloading state from other substates
  const loading = !skip && !hasCachedData && !state.error
  const reloading = loading || state.reloading

  return {
    ...cachedData,
    refetch: () => dispatch({ type: 'refetch' }),
    loading,
    reloading,
    error: state.error,
  }
}

function reducer(state, action) {
  switch (action.type) {
    case 'fetching':
      return {
        ...state,
        reloading: true,
        error: null,
      }
    case 'success':
      return { ...state, fetched: true, reloading: false }
    case 'error':
      return {
        ...state,
        reloading: false,
        fetched: true,
        error: action.payload,
      }
    case 'refetch':
      return {
        ...state,
        fetched: false,
        refetchSeq: state.refetchSeq + 1,
      }
    case 'reset':
      if (!state.fetched) {
        return state
      } else {
        return {
          ...state,
          fetched: false,
        }
      }
    case 'updateHasCachedData':
      if (state.hasCachedData === action.hasCachedData) {
        return state
      } else {
        return {
          ...state,
          hasCachedData: action.hasCachedData,
        }
      }
  }
}

function getter(service, id, params) {
  return service.get(id, params)
}

function finder(service, params, { queryId, allPages }) {
  if (!allPages) {
    return service.find(params)
  }

  return new Promise((resolve, reject) => {
    let skip = 0
    const result = { data: [], skip: 0 }

    fetchNext()

    function fetchNext() {
      service
        .find({
          ...params,
          query: {
            ...(params.query || {}),
            $skip: skip,
          },
        })
        .then(res => {
          result.limit = res.limit
          result.total = res.total
          result.data = result.data.concat(res.data)

          if (res.data.length === 0 || result.data.length >= result.total) {
            resolve(result)
          } else {
            skip = res.skip + res.limit
            fetchNext()
          }
        })
        .catch(reject)
    }
  })
}
