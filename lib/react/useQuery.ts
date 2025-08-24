import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import { splitConfig, type QueryConfig, type QueryDescriptor } from '../core/figbird.js'
import type { QueryStatus } from '../core/internal-types.js'
import { findServiceByName } from '../schema/types.js'
import { useFigbird } from './react.js'

export interface QueryResult<T> {
  data: T | null
  meta: Record<string, unknown>
  status: QueryStatus
  isFetching: boolean
  error: Error | null
  refetch: () => void
}

export function useGet<N extends string>(
  serviceName: N,
  resourceId: string | number,
  params: Record<string, unknown> = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): QueryResult<any> {
  const figbird = useFigbird()
  const service = findServiceByName(figbird.schema, serviceName)
  const actualServiceName = service?.name ?? serviceName
  const { desc, config } = splitConfig({
    serviceName: actualServiceName,
    method: 'get',
    resourceId,
    ...params,
  })
  return useQuery(desc, config)
}

export function useFind<N extends string>(
  serviceName: N,
  params: Record<string, unknown> = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): QueryResult<any[]> {
  const figbird = useFigbird()
  const service = findServiceByName(figbird.schema, serviceName)
  const actualServiceName = service?.name ?? serviceName
  const { desc, config } = splitConfig({
    serviceName: actualServiceName,
    method: 'find',
    ...params,
  })
  return useQuery(desc, config)
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
  const _q = figbird.query<T>(desc, {
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
