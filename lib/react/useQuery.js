import { useEffect, useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useFigbird } from './react'

export function useGet(serviceName, resourceId, options = {}) {
  return useWatchQuery(serviceName, options, { method: 'get', resourceId })
}

export function useFind(serviceName, options = {}) {
  return useWatchQuery(serviceName, options, { method: 'find' })
}

let _seq = 0

function useWatchQuery(serviceName, options = {}, queryHookOptions = {}) {
  const [seq] = useState(() => _seq++)
  const figbird = useFigbird()

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

  const { method, resourceId } = queryHookOptions

  const q = figbird.createQuery({
    serviceName,
    method,
    resourceId,
    params,
    allPages,
    parallel,
    parallelLimit,
    realtime,
    fetchPolicy,
    matcher,
    ...(fetchPolicy === 'network-only' ? { seq } : {}),
  })

  let queryResult = useQueryState(q.queryId)

  const refetch = useCallback(() => {
    figbird.refetch(q)
  }, [figbird, q])

  useEffect(() => {
    return figbird.watchQuery(q)
  }, [q.queryId])

  return useMemo(() => ({ ...queryResult, refetch }), [queryResult, refetch])
}

export function useQueryState(queryId) {
  const figbird = useFigbird()
  const subscribe = useCallback(fn => figbird.subscribe(fn), [figbird])
  const getSnapshot = useCallback(() => figbird.getQueryState(queryId), [queryId])
  return useSyncExternalStore(subscribe, getSnapshot)
}
