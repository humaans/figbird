import { useReducer, useEffect, useCallback, useMemo } from 'react'
import { useFeathers } from './core'
import { useRealtime } from './useRealtime'
import { useCache } from './cache'
import { hashObject, inflight } from './helpers'
import { useEffectEvent } from './useEffectEvent'

const get = inflight((service, id, params, options) => `${service.path}/${options.queryId}`, getter)
const find = inflight((service, params, options) => `${service.path}/${options.queryId}`, finder)

const fetchPolicies = ['swr', 'cache-first', 'network-only']
const realtimeModes = ['merge', 'refetch', 'disabled']

const emptyCachedResult = { data: null }

/**
 * A generic abstraction of both get and find
 */
export function useQuery(serviceName, options = {}, queryHookOptions = {}) {
  const feathers = useFeathers()

  let {
    skip,
    allPages,
    parallel,
    realtime = 'merge',
    fetchPolicy = 'swr',
    matcher,
    ...params
  } = options

  const { method, id, selectData, transformResponse } = queryHookOptions

  realtime = realtime || 'disabled'

  if (realtime !== 'disabled' && realtime !== 'merge' && realtime !== 'refetch') {
    throw new Error(`Bad realtime option, must be one of ${[realtimeModes].join(', ')}`)
  }

  if (!fetchPolicies.includes(fetchPolicy)) {
    throw new Error(`Bad fetchPolicy option, must be one of ${[fetchPolicies].join(', ')}`)
  }

  const queryId = useQueryHash({
    serviceName,
    method,
    id,
    params,
    realtime,
  })

  // eslint-disable-next-line react-hooks/exhaustive-deps
  params = useMemo(() => params, [queryId])

  let [cachedResult, updateCache] = useCache({
    queryId,
    serviceName,
    method,
    params,
    realtime,
    selectData,
    matcher,
  })

  let hasCachedData = !!cachedResult.data
  const fetched = fetchPolicy === 'cache-first' && hasCachedData

  const [state, dispatch] = useReducer(reducer, {
    reloading: false,
    fetched,
    fetchedCount: 0,
    refetchSeq: 0,
    error: null,
  })

  if (fetchPolicy === 'network-only' && state.fetchedCount === 0) {
    cachedResult = emptyCachedResult
    hasCachedData = false
  }

  const handleRealtimeEvent = useCallback(
    payload => {
      if (realtime !== 'refetch') return
      dispatch({ type: 'refetch' })
    },
    [dispatch, realtime],
  )

  useEffect(() => {
    let disposed = false

    if (state.fetched) return
    if (skip) return

    dispatch({ type: 'fetching' })
    const service = feathers.service(serviceName)
    const result =
      method === 'get'
        ? get(service, id, params, { queryId })
        : find(service, params, { queryId, allPages, parallel })

    result
      .then(res => {
        // no res means we've piggy backed on an in flight request
        if (res) {
          updateCache(transformResponse(res))
        }

        if (!disposed) {
          dispatch({ type: 'success', queryId })
        }
      })
      .catch(err => {
        if (!disposed) {
          dispatch({ type: 'error', queryId, payload: err })
        }
      })

    return () => {
      disposed = true
    }
  }, [
    feathers,
    queryId,
    serviceName,
    method,
    id,
    params,
    transformResponse,
    state.fetched,
    state.refetchSeq,
    skip,
    allPages,
    parallel,
    updateCache,
  ])

  // If queryId changed, we should refetch the data
  const reset = useEffectEvent(queryId => {
    dispatch({ type: 'reset', fetched, queryId })
  })
  useEffect(() => reset(queryId), [reset, queryId])

  // realtime hook will make sure we're listening to all of the
  // updates to this service
  useRealtime(serviceName, realtime, handleRealtimeEvent)

  const loading = !skip && !hasCachedData && !state.error
  const status = loading ? 'loading' : state.error ? 'error' : 'success'
  const isFetching = loading || state.reloading

  const refetch = useCallback(() => dispatch({ type: 'refetch' }), [dispatch])

  return useMemo(
    () => ({
      ...(skip ? { data: null } : cachedResult),
      status,
      refetch,
      isFetching,
      error: state.error,
    }),
    [skip, cachedResult, status, state.error, refetch, isFetching],
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
        queryId: action.queryId,
        fetchedCount: state.fetchedCount + 1,
        reloading: false,
      }
    case 'error':
      return {
        ...state,
        reloading: false,
        fetched: true,
        queryId: action.queryId,
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
      if (state.fetched && state.queryId && state.queryId !== action.queryId) {
        return {
          ...state,
          fetched: action.fetched,
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

function finder(service, params, { queryId, allPages, parallel }) {
  if (!allPages) {
    return service.find(params)
  }

  return new Promise((resolve, reject) => {
    let skip = 0
    const result = { data: [], skip: 0 }

    fetchNext()

    function doFind(skip) {
      return service.find({
        ...params,
        query: {
          ...(params.query || {}),
          $skip: skip,
        },
      })
    }

    function resolveOrFetchNext(res) {
      if (res.data.length === 0 || result.data.length >= result.total) {
        resolve(result)
      } else {
        skip = result.data.length
        fetchNext()
      }
    }

    function fetchNextParallel() {
      const requiredFetches = Math.ceil((result.total - result.data.length) / result.limit)

      if (requiredFetches > 0) {
        Promise.all(
          new Array(requiredFetches).fill().map((_, idx) => doFind(skip + idx * result.limit)),
        )
          .then(results => {
            const [lastResult] = results.slice(-1)
            result.limit = lastResult.limit
            result.total = lastResult.total
            result.data = result.data.concat(results.flatMap(r => r.data))

            resolveOrFetchNext(lastResult)
          })
          .catch(reject)
      } else {
        resolve(result)
      }
    }

    function fetchNext() {
      if (
        typeof result.total !== 'undefined' &&
        typeof result.limit !== 'undefined' &&
        parallel === true
      ) {
        fetchNextParallel()
      } else {
        doFind(skip)
          .then(res => {
            result.limit = res.limit
            result.total = res.total
            result.data = result.data.concat(res.data)

            resolveOrFetchNext(res)
          })
          .catch(reject)
      }
    }
  })
}

function useQueryHash({ serviceName, method, id, params, realtime }) {
  return useMemo(() => {
    const hash = hashObject({ serviceName, method, id, params, realtime })
    return `${method}:${hash}`
  }, [serviceName, method, id, params, realtime])
}
