import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import { splitConfig, type QueryDescriptor, type QueryConfig } from '../core/figbird.js'
import { useFigbird } from './react.js'
import type { FigbirdFindMeta, FigbirdError } from '../types.js'

interface QueryResult<T> {
  data: T | null
  meta: FigbirdFindMeta
  status: 'idle' | 'loading' | 'success' | 'error'
  isFetching: boolean
  error: FigbirdError
  refetch: () => void
}

export function useGet<T>(
  serviceName: string,
  resourceId: string | number,
  params: Record<string, unknown> = {},
): QueryResult<T> {
  const { desc, config } = splitConfig({ serviceName, method: 'get', resourceId, ...params })
  return useQuery<T>(desc, config)
}

export function useFind<T>(
  serviceName: string,
  params: Record<string, unknown> = {},
): QueryResult<T[]> {
  const { desc, config } = splitConfig({ serviceName, method: 'find', ...params })
  return useQuery<T[]>(desc, config)
}

let _seq = 0

/**

  Usage:

  const { data, status } = useQuery({
    serviceName: 'notes',
    method: 'find'
  })

*/
export function useQuery<T>(desc: QueryDescriptor, config: QueryConfig): QueryResult<T> {
  const figbird = useFigbird()

  // a slightly hacky workaround for network-only queries where we want to keep
  // the query.hash() stable between re-renders for this component, but unique
  // to each component - network-only queries are not shared between components
  // - they could be, and we might change that in the future
  const seqRef = useRef<number | undefined>(undefined)
  if (seqRef.current === undefined && config.fetchPolicy === 'network-only') {
    seqRef.current = _seq++
  }

  // we create a new query on each render! but we'll throw it away via useMemo
  // if the q.hash() is the same as the previous query, this allows us to keep
  // the q.subscribe and q.getSnapshot stable and avoid unsubbing and resubbing
  // you don't need to do this outside React where you can more easily create a
  // stable reference to a query and use it for as long as you want
  const _q = figbird.query(desc, {
    ...config,
    ...(config.fetchPolicy === 'network-only' ? { seq: seqRef.current } : {}),
  })

  // a bit of React foo to create stable fn references
  const q = useMemo(() => _q, [_q.hash()])
  const refetch = useCallback(() => q.refetch(), [q])
  const subscribe = useCallback((fn: (state: unknown) => void) => q.subscribe(fn), [q])
  const getSnapshot = useCallback(() => q.getSnapshot(), [q])

  // we subscribe to the query state changes, this includes both going from
  // loading -> success state, but also for any realtime data updates
  const queryResult = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return useMemo(() => ({ ...queryResult, refetch }) as QueryResult<T>, [queryResult, refetch])
}
