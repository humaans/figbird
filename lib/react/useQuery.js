import { useEffect, useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useFigbird } from './react'

export function useGet(serviceName, resourceId, options = {}) {
  return useQuery({ serviceName, method: 'get', resourceId }, options)
}

export function useFind(serviceName, options = {}) {
  return useQuery({ serviceName, method: 'find' }, options)
}

let _seq = 0

export function useQuery({ serviceName, method, resourceId }, options = {}) {
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

  const subscribe = useCallback(fn => figbird.subscribe(fn), [figbird])
  const getSnapshot = useCallback(() => figbird.getQueryState(q.queryId), [q.queryId])
  const queryResult = useSyncExternalStore(subscribe, getSnapshot)

  const refetch = useCallback(() => {
    figbird.refetch(q)
  }, [figbird, q])

  useEffect(() => {
    return figbird.watchQuery(q)
  }, [q.queryId])

  return useMemo(() => ({ ...queryResult, refetch }), [queryResult, refetch])
}
