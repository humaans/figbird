import { useCallback, useId, useMemo, useRef, useSyncExternalStore } from 'react'
import type { QueryState, QueryStatus } from '../core/figbird.js'
import { splitConfig, type QueryConfig, type QueryDescriptor } from '../core/figbird.js'
import { findServiceByName } from '../core/schema.js'
import { useFigbird } from './react.js'

/**
 * Combined params type that includes both Figbird's QueryConfig and adapter params
 */
type CombinedParams<TParams, TItem = unknown> = TParams & Partial<QueryConfig<TItem>>

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
export function useGet<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T = any,
  TParams = Record<string, unknown>,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
>(
  serviceName: string,
  resourceId: string | number,
  params: CombinedParams<TParams, T> = {} as CombinedParams<TParams, T>,
): QueryResult<T, TMeta> {
  const figbird = useFigbird()
  const service = findServiceByName(figbird.schema, serviceName)
  const actualServiceName = service?.name ?? serviceName
  const { desc, config } = splitConfig<T>({
    serviceName: actualServiceName,
    method: 'get' as const,
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
export function useFind<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T = any[],
  TParams = Record<string, unknown>,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
>(
  serviceName: string,
  params: CombinedParams<TParams, T> = {} as CombinedParams<TParams, T>,
): QueryResult<T, TMeta> {
  const figbird = useFigbird()
  const service = findServiceByName(figbird.schema, serviceName)
  const actualServiceName = service?.name ?? serviceName
  const { desc, config } = splitConfig<T>({
    serviceName: actualServiceName,
    method: 'find' as const,
    ...params,
  })
  return useQuery<T, TMeta>(desc, config)
}

function getInitialQueryResult<T, TMeta extends Record<string, unknown>>(
  emptyMeta: TMeta,
): QueryState<T, TMeta> {
  return {
    status: 'loading' as const,
    data: null,
    meta: emptyMeta,
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
  config: QueryConfig<T>,
): QueryResult<T, TMeta> {
  const figbird = useFigbird()

  // For network-only queries, we need a unique ID for each hook instance
  // to ensure that queries are not shared between components.
  // useId provides a stable, unique ID for the lifetime of the component.
  const uniqueId = useId()

  // we create a new query on each render! but we'll throw it away via useMemo
  // if the q.hash() is the same as the previous query, this allows us to keep
  // the q.subscribe and q.getSnapshot stable and avoid unsubbing and resubbing
  // you don't need to do this outside React where you can more easily create a
  // stable reference to a query and use it for as long as you want
  const _q = figbird.query<T>(desc, {
    ...config,
    ...(config.fetchPolicy === 'network-only' ? { uid: uniqueId } : {}),
  })

  // a bit of React foo to create stable fn references
  const q = useMemo(() => _q, [_q.hash()])
  const refetch = useCallback(() => q.refetch(), [q])
  const subscribe = useCallback((onStoreChange: () => void) => q.subscribe(onStoreChange), [q])

  // Cache empty meta to avoid creating it repeatedly
  const emptyMetaRef = useRef<TMeta | null>(null)
  if (emptyMetaRef.current == null) {
    emptyMetaRef.current = figbird.adapter.emptyMeta() as TMeta
  }

  const getSnapshot = useCallback(
    (): QueryState<T, TMeta> =>
      (q.getSnapshot() as QueryState<T, TMeta> | undefined) ??
      getInitialQueryResult<T, TMeta>(emptyMetaRef.current!),
    [q],
  )

  // we subscribe to the query state changes, this includes both going from
  // loading -> success state, but also for any realtime data updates
  const queryResult = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return useMemo(
    () => ({ ...queryResult, refetch }) as QueryResult<T, TMeta>,
    [queryResult, refetch],
  )
}
