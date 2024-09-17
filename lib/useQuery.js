import { useReducer, useEffect, useCallback, useMemo, useRef } from 'react'
import { flushSync } from 'react-dom'
import { useFigbird } from './core'
import { useRealtime } from './useRealtime'
import { useCache } from './cache'
import { fetch } from './fetch'
import { hashObject } from './helpers'

const fetchPolicies = ['swr', 'cache-first', 'network-only']
const realtimeModes = ['merge', 'refetch', 'disabled']

function reducer(state, action) {
  switch (action.type) {
    case 'success':
      return { ...state, status: 'success' }
    case 'error':
      return { ...state, status: 'error', error: action.error }
    case 'reset':
      return { ...state, status: 'pending', error: null }
  }
}

/**
 * A generic abstraction of both get and find
 */
export function useQuery(serviceName, options = {}, queryHookOptions = {}) {
  const { config, feathers } = useFigbird()

  let {
    skip,
    allPages,
    parallel,
    parallelLimit,
    optimisticParallelLimit,
    realtime = 'merge',
    fetchPolicy = 'swr',
    matcher,
    ...params
  } = options

  const { method, id, selectData, transformResponse } = queryHookOptions

  if (!realtimeModes.includes(realtime)) {
    throw new Error(`Bad realtime option, must be one of ${[realtimeModes].join(', ')}`)
  }

  if (!fetchPolicies.includes(fetchPolicy)) {
    throw new Error(`Bad fetchPolicy option, must be one of ${[fetchPolicies].join(', ')}`)
  }

  if (
    config.defaultPageSizeWhenFetchingAll &&
    allPages &&
    (!params.query || !params.query.$limit)
  ) {
    params = { ...params }
    params.query = params.query || {}
    params.query.$limit = config.defaultPageSizeWhenFetchingAll
  } else if (config.defaultPageSize && (!params.query || !params.query.$limit)) {
    params = { ...params }
    params.query = params.query || {}
    params.query.$limit = config.defaultPageSize
  }

  const queryId = useQueryHash({
    serviceName,
    method,
    id,
    params,
    allPages,
    realtime,
  })

  // eslint-disable-next-line react-hooks/exhaustive-deps
  params = useMemo(() => params, [queryId])

  const [cachedResult, updateCache] = useCache({
    queryId,
    serviceName,
    method,
    params,
    realtime,
    selectData,
    matcher,
  })

  const isCacheSufficient = fetchPolicy === 'cache-first' && !!cachedResult

  const [state, dispatch] = useReducer(reducer, {
    status: isCacheSufficient ? 'success' : 'pending',
    error: null,
  })

  const isPending = state.status === 'pending'

  const requestRef = useRef(0)

  useEffect(() => {
    if (skip) return
    if (!isPending) return
    if (isCacheSufficient) return

    // increment the request ref so we can ignore old requests
    const reqRef = (requestRef.current = requestRef.current + 1)

    fetch(feathers, serviceName, method, id, params, {
      queryId,
      allPages,
      parallel,
      parallelLimit,
      optimisticParallelLimit,
      transformResponse,
    })
      .then(res => {
        if (reqRef === requestRef.current) {
          flushSync(() => {
            updateCache(res)
            dispatch({ type: 'success' })
          })
        }
      })
      .catch(error => {
        if (reqRef === requestRef.current) {
          dispatch({ type: 'error', error })
        }
      })
  }, [
    feathers,
    queryId,
    serviceName,
    method,
    id,
    params,
    transformResponse,
    skip,
    allPages,
    parallel,
    parallelLimit,
    optimisticParallelLimit,
    updateCache,
    isPending,
    isCacheSufficient,
  ])

  const refetch = useCallback(() => dispatch({ type: 'reset' }), [dispatch])

  // refetch if the query changes
  useEffect(() => {
    if (!isCacheSufficient) {
      refetch()
    }
  }, [refetch, queryId, isCacheSufficient])

  // realtime hook subscribes to realtime updates to this service
  useRealtime(serviceName, realtime, refetch)

  let status
  let isFetching
  let result = useMemo(() => ({ data: null }), [])
  const error = state.error

  if (skip) {
    status = 'success'
    isFetching = false
  } else if (state.status === 'error') {
    status = 'error'
    isFetching = false
  } else if (fetchPolicy === 'swr') {
    status = cachedResult ? 'success' : 'loading'
    isFetching = isPending || status === 'loading'
    result = cachedResult || result
  } else if (fetchPolicy === 'cache-first') {
    status = cachedResult ? 'success' : 'loading'
    isFetching = isPending || status === 'loading'
    result = cachedResult || result
  } else if (fetchPolicy === 'network-only') {
    status = isPending || !cachedResult ? 'loading' : 'success'
    isFetching = isPending || status === 'loading'
    result = isFetching ? result : cachedResult
  }

  return useMemo(
    () => ({ ...result, status, refetch, isFetching, error }),
    [result, status, error, refetch, isFetching],
  )
}

function useQueryHash({ serviceName, method, id, params, allPages, realtime }) {
  return useMemo(() => {
    const hash = hashObject({ serviceName, method, id, params, allPages, realtime })
    return `${method}:${hash}`
  }, [serviceName, method, id, params, allPages, realtime])
}
