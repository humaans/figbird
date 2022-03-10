import { useReducer, useEffect, useRef, useCallback, useMemo } from 'react'
import { useFigbird } from './core'
import { useRealtime } from './useRealtime'
import { useCache } from './useCache'
import { hashObject, inflight } from './helpers'

const get = inflight((service, id, params, options) => `${service.path}/${options.queryId}`, getter)
const find = inflight((service, params, options) => `${service.path}/${options.queryId}`, finder)

const fetchPolicies = ['swr', 'cache-first', 'network-only']
const realtimeModes = ['merge', 'refetch', 'disabled']

/**
 * A generic abstraction of both get and find
 */
export function useQuery(serviceName, options = {}, queryHookOptions = {}) {
  const { method, id, selectData, transformResponse } = queryHookOptions

  const { feathers } = useFigbird()
  const disposed = useRef(false)
  const isInitialMount = useRef(true)

  let { skip, allPages, realtime = 'merge', fetchPolicy = 'swr', matcher, ...params } = options

  realtime = realtime || 'disabled'
  if (realtime !== 'disabled' && realtime !== 'merge' && realtime !== 'refetch') {
    throw new Error(`Bad realtime option, must be one of ${[realtimeModes].join(', ')}`)
  }

  if (!fetchPolicies.includes(fetchPolicy)) {
    throw new Error(`Bad fetchPolicy option, must be one of ${[fetchPolicies].join(', ')}`)
  }

  const queryId = `${method.substr(0, 1)}:${hashObject({
    serviceName,
    method,
    id,
    params,
    realtime,
  })}`

  let [cachedData, updateCache] = useCache({
    serviceName,
    queryId,
    method,
    id,
    params,
    realtime,
    selectData,
    transformResponse,
    matcher,
  })

  let hasCachedData = !!cachedData.data
  const fetched = fetchPolicy === 'cache-first' && hasCachedData

  const [state, dispatch] = useReducer(reducer, {
    reloading: false,
    fetched,
    fetchedCount: 0,
    refetchSeq: 0,
    error: null,
  })

  if (fetchPolicy === 'network-only' && state.fetchedCount === 0) {
    cachedData = { data: null }
    hasCachedData = false
  }

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
    if (!isInitialMount.current) {
      dispatch({ type: 'reset' })
    }
  }, [serviceName, queryId])

  // realtime hook will make sure we're listening to all of the
  // updates to this service
  useRealtime(serviceName, realtime, handleRealtimeEvent)

  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false
    }
  }, [])

  // derive the loading/reloading state from other substates
  const loading = !skip && !hasCachedData && !state.error
  const reloading = loading || state.reloading

  const refetch = useCallback(() => dispatch({ type: 'refetch' }), [dispatch])

  return useMemo(
    () => ({
      ...(skip ? { data: null } : cachedData),
      status: loading ? 'loading' : state.error ? 'error' : 'success',
      refetch,
      isFetching: reloading,
      error: state.error,

      loading, // deprecated, use status and isFetching instead
      reloading, // deprecated, use isFetching instead
    }),
    [
      skip,
      cachedData.data,
      loading,
      state.error,
      refetch,
      reloading,
      state.error,
      loading,
      reloading,
    ]
  )
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
      return {
        ...state,
        fetched: true,
        fetchedCount: state.fetchedCount + 1,
        reloading: false,
      }
    case 'error':
      return {
        ...state,
        reloading: false,
        fetched: true,
        fetchedCount: state.fetchedCount + 1,
        error: action.payload,
      }
    case 'refetch':
      return {
        ...state,
        fetched: false,
        refetchSeq: state.refetchSeq + 1,
      }
    case 'reset':
      if (state.fetched) {
        return {
          ...state,
          fetched: false,
          fetchedCount: 0,
        }
      } else {
        return state
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
