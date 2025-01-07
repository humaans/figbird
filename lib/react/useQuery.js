import { useEffect, useCallback, useMemo } from 'react'
import { useFigbird } from './react'
import { useCache } from './cache'

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

export function useGet(serviceName, id, options = {}) {
  return useWatchQuery(serviceName, options, { method: 'get', id })
}

export function useFind(serviceName, options = {}) {
  return useWatchQuery(serviceName, options, { method: 'find' })
}

function useWatchQuery(serviceName, options = {}, queryHookOptions = {}) {
  const { queryManager } = useFigbird()

  let {
    skip,
    allPages,
    parallel,
    parallelLimit,
    realtime = 'merge',
    fetchPolicy = 'swr',
    matcher,
    ...params
  } = options

  const { method, id } = queryHookOptions

  const q = useMemo(
    () =>
      queryManager.createQuery({
        service: serviceName,
        method,
        id,
        params,
        realtime,
        matcher,
        fetchPolicy,
        allPages,
        parallel,
        parallelLimit,
      }),
    [serviceName, method, id, params],
  )

  const refetch = useCallback(() => queryManager.refetch(q), [queryManager, q])
  const queryResult = useCache({ queryId: q.queryId })
  useEffect(() => queryManager.addQuery(q), [q.queryId])

  return useMemo(() => ({ ...queryResult, refetch }), [queryResult, refetch])
  // let status
  // let isFetching
  // let result = useMemo(() => ({ data: null }), [])
  // const error = state.error

  // if (skip) {
  //   status = 'success'
  //   isFetching = false
  // } else if (state.status === 'error' || error) {
  //   status = 'error'
  //   isFetching = false
  // } else if (fetchPolicy === 'swr') {
  //   status = cachedResult ? 'success' : 'loading'
  //   isFetching = isPending || status === 'loading'
  //   result = cachedResult || result
  // } else if (fetchPolicy === 'cache-first') {
  //   status = cachedResult ? 'success' : 'loading'
  //   isFetching = isPending || status === 'loading'
  //   result = cachedResult || result
  // } else if (fetchPolicy === 'network-only') {
  //   status = isPending || !cachedResult ? 'loading' : 'success'
  //   isFetching = isPending || status === 'loading'
  //   result = isFetching ? result : cachedResult
  // }

  // return useMemo(
  //   () => ({ ...result, status, refetch, isFetching, error }),
  //   [result, status, error, refetch, isFetching],
  // )
}
