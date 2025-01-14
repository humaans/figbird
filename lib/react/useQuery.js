import { useEffect, useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useFigbird } from './react'

export function useGet(serviceName, id, options = {}) {
  return useWatchQuery(serviceName, options, { method: 'get', id })
}

export function useFind(serviceName, options = {}) {
  return useWatchQuery(serviceName, options, { method: 'find' })
}

let _seq = 0

function useWatchQuery(serviceName, options = {}, queryHookOptions = {}) {
  const [seq] = useState(() => _seq++)
  const { queryManager } = useFigbird()

  // TODO - fix skip option
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

  const q = queryManager.createQuery({
    service: serviceName,
    method,
    id,
    params,
    allPages,
    parallel,
    parallelLimit,
    realtime,
    fetchPolicy,
    matcher,
    ...(fetchPolicy === 'network-only' ? { seq } : {}),
  })

  let queryResult = useCache(q.queryId)

  const refetch = useCallback(() => {
    queryManager.refetch(q)
  }, [queryManager, q])

  useEffect(() => {
    return queryManager.watchQuery(q)
  }, [q.queryId])

  return useMemo(() => ({ ...queryResult, refetch }), [queryResult, refetch])
}

export function useCache(queryId) {
  const { queryManager } = useFigbird()
  const subscribe = useCallback(fn => queryManager.subscribe(fn), [queryManager])
  const getSnapshot = useCallback(() => queryManager.getQuery(queryId), [queryId])
  return useSyncExternalStore(subscribe, getSnapshot)
}
