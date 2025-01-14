import { useEffect, useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useFigbird } from './react'

export function useGet(serviceName, id, options = {}) {
  return useWatchQuery(serviceName, options, { method: 'get', id })
}

export function useFind(serviceName, options = {}) {
  return useWatchQuery(serviceName, options, { method: 'find' })
}

let seq = 0

function useWatchQuery(serviceName, options = {}, queryHookOptions = {}) {
  const [seq] = useState(() => seq++)
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

  // return useSelector(
  //   () => {
  //     const { queries, lookups } = cache()
  //     const serviceName = getIn(lookups, ['serviceNamesByQueryId', queryId])
  //     const query = getIn(queries, [serviceName, queryId])

  //     if (!query) {
  //       return {
  //         data: null,
  //         error: null,
  //         status: 'loading',
  //         isFetching: true,
  //       }
  //     } else if (query.error) {
  //       return {
  //         data: null,
  //         error: query.error,
  //         status: 'error',
  //         status: query.status,
  //         isFetching: query.fetching,
  //       }
  //     } else {
  //       const data = query.method === 'get' ? query.data?.[0] : query.data
  //       return {
  //         ...query.meta,
  //         data,
  //         error: null,
  //         status: query.status,
  //         isFetching: query.fetching,
  //       }
  //     }
  //   },
  //   [queryId],
  //   { label: 'figbird:cache' },
  // )
}
