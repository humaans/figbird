import { useReducer, useEffect, useCallback, useMemo, useRef } from 'react'
import { flushSync } from 'react-dom'
import { useFigbird } from './context'
import { useRealtime } from './useRealtime'
import { useCache } from './cache'
import { fetch } from '../core/fetch'
import { hashObject } from '../core/helpers'

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

export function useQuery(serviceName, options = {}, queryHookOptions = {}) {
  const { config, queryManager } = useFigbird()

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

  // const isCacheSufficient = false
  // const isPending = false
  // const [state, dispatch] = useReducer(reducer, {
  //   status: isCacheSufficient ? 'success' : 'pending',
  //   error: null,
  // })

  const q = useMemo(
    () =>
      queryManager.createQuery({
        service: serviceName,
        method,
        id,
        params,
        realtime,
        fetchPolicy,
        allPages,
        parallel,
        parallelLimit,
      }),
    [serviceName, method, id, params],
  )

  const refetch = useCallback(() => queryManager.refetch(q), [queryManager, q])

  const queryResult = useCache({
    queryId: q.queryId,
  })

  useEffect(() => {
    return queryManager.addQuery(q)
  }, [q.queryId])

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
