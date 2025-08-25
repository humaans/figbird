import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import type { QueryState, QueryStatus } from '../core/figbird.js'
import { splitConfig, type QueryConfig, type QueryDescriptor } from '../core/figbird.js'
import { findServiceByName } from '../core/schema.js'
import { useFigbird } from './react.js'

export interface QueryResult<T, TMeta extends Record<string, unknown> = Record<string, unknown>> {
  data: T | null
  meta: TMeta
  status: QueryStatus
  isFetching: boolean
  error: Error | null
  refetch: () => void
}

/**
 * Hook for fetching a single item by ID.
 *
 * @template T - The type of the item to fetch. Defaults to `any` for backward compatibility.
 * For better type safety, explicitly provide a type parameter: `useGet<MyItemType>('service', id)`
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useGet<T = any, TMeta extends Record<string, unknown> = Record<string, unknown>>(
  serviceName: string,
  resourceId: string | number,
  params: Record<string, unknown> = {},
): QueryResult<T, TMeta> {
  const figbird = useFigbird<any, TMeta>()
  const service = findServiceByName(figbird.schema, serviceName)
  const actualServiceName = service?.name ?? serviceName
  const { desc, config } = splitConfig({
    serviceName: actualServiceName,
    method: 'get',
    resourceId,
    ...params,
  })
  return useQuery<T, TMeta>(desc, config)
}

/**
 * Hook for fetching multiple items with optional query parameters.
 *
 * @template T - The type of the result array. Defaults to `any[]` for backward compatibility.
 * For better type safety, explicitly provide a type parameter: `useFind<MyItemType[]>('service', params)`
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useFind<T = any[], TMeta extends Record<string, unknown> = Record<string, unknown>>(
  serviceName: string,
  params: Record<string, unknown> = {},
): QueryResult<T, TMeta> {
  const figbird = useFigbird<any, TMeta>()
  const service = findServiceByName(figbird.schema, serviceName)
  const actualServiceName = service?.name ?? serviceName
  const { desc, config } = splitConfig({
    serviceName: actualServiceName,
    method: 'find',
    ...params,
  })
  return useQuery<T, TMeta>(desc, config)
}

let _seq = 0

function getInitialQueryResult<TMeta extends Record<string, unknown>>(): QueryState<any, TMeta> {
  return {
    data: null,
    meta: {} as TMeta,
    status: 'loading' as const,
    isFetching: true,
    error: null,
  }
}

/**

  Usage:

  const { data, status } = useQuery({
    serviceName: 'notes',
    method: 'find'
  })

*/
export function useQuery<T, TMeta extends Record<string, unknown> = Record<string, unknown>>(
  desc: QueryDescriptor,
  config: QueryConfig,
): QueryResult<T, TMeta> {
  const figbird = useFigbird<any, TMeta>()

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
  const subscribe = useCallback((onStoreChange: () => void) => q.subscribe(onStoreChange), [q])

  const getSnapshot = useCallback(() => q.getSnapshot() ?? getInitialQueryResult<TMeta>(), [q])

  // we subscribe to the query state changes, this includes both going from
  // loading -> success state, but also for any realtime data updates
  const queryResult = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return useMemo(() => ({ ...queryResult, refetch }), [queryResult, refetch])
}
