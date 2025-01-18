import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { splitConfig } from '../core/figbird'
import { useFigbird } from './react'

export function useGet(serviceName, resourceId, params = {}) {
  const { desc, config } = splitConfig({ serviceName, method: 'get', resourceId, ...params })
  return useQuery(desc, config)
}

export function useFind(serviceName, params = {}) {
  const { desc, config } = splitConfig({ serviceName, method: 'find', ...params })
  return useQuery(desc, config)
}

let _seq = 0

/**

  Usage:

  const { data, status } = useQuery({
    serviceName: 'notes',
    method: 'find',
    allPages: true
  })

*/
export function useQuery(desc, config) {
  const figbird = useFigbird()

  // a slightly hacky workaround for network-only queries where we want to keep
  // the query.hash() stable between re-renders for this component, but unique
  // to each component - network-only queries are not shared between components
  // - they could be, and we might change that in the future
  const [seq] = useState(() => _seq++)

  // we create a new query on each render! but we'll throw it away via useMemo
  // if the q.hash() is the same as the previous query, this allows us to keep
  // the q.subscribe and q.getSnapshot stable and avoid unsubbing and resubbing
  // you don't need to do this outside React where you can more easily create a
  // stable reference to a query and use it for as long as you want
  const _q = figbird.query(desc, {
    ...config,
    ...(config.fetchPolicy === 'network-only' ? { seq } : {}),
  })

  // a bit of React foo to create stable fn references
  const q = useMemo(() => _q, [_q.hash()])
  const refetch = useCallback(() => q.refetch(), [q])
  const subscribe = useCallback(fn => q.subscribe(fn), [q])
  const getSnapshot = useCallback(() => q.getSnapshot(), [q])

  // we subscribe to the query state changes, this includes both going from
  // loading -> success state, but also for any realtime data updates
  const queryResult = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return useMemo(() => ({ ...queryResult, refetch }), [queryResult, refetch])
}
