import { useCallback, useId, useMemo, useRef, useSyncExternalStore } from 'react'
import type { QueryState } from '../core/figbird.js'
import { splitConfig, type QueryConfig, type QueryDescriptor } from '../core/figbird.js'
import {
  isEphemeralQuery,
  queryIdentityKey,
  type QueryIdentityConfig,
} from '../core/queryIdentity.js'
import { useFigbird } from './context.js'

type BaseQueryResult = {
  refetch: () => void
}

// Public untyped hooks intentionally return `any` for backwards compatibility.
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
type UntypedData = any

export type QueryResult<T, TMeta = undefined> = BaseQueryResult &
  (TMeta extends undefined
    ?
        | { status: 'loading'; data: null; isFetching: boolean; error: null }
        | { status: 'success'; data: T; isFetching: boolean; error: null }
        | { status: 'error'; data: null; isFetching: boolean; error: Error }
    :
        | { status: 'loading'; data: null; meta: TMeta; isFetching: boolean; error: null }
        | { status: 'success'; data: T; meta: TMeta; isFetching: boolean; error: null }
        | { status: 'error'; data: null; meta: TMeta; isFetching: boolean; error: Error })

/**
 * Hook for fetching a single item by ID.
 * Returns untyped data. For type-safe queries, use createHooks(schema).
 *
 * @deprecated Legacy descriptor-based hook. Prefer `useQuery(q.service.get(id))` from
 * the builder API — this stays functional but new code should not use it.
 */
export function useGet(
  serviceName: string,
  resourceId: string | number,
  params: Record<string, UntypedData> = {},
): QueryResult<UntypedData> {
  return useGetImpl<UntypedData, Record<string, unknown>, Record<string, unknown>>(
    useFigbird(),
    serviceName,
    resourceId,
    params,
  ) as QueryResult<UntypedData>
}

/**
 * Hook for fetching multiple items with optional query parameters.
 * Returns untyped data. For type-safe queries, use createHooks(schema).
 *
 * @deprecated Legacy descriptor-based hook. Prefer `useQuery(q.service.where(...))` from
 * the builder API — this stays functional but new code should not use it.
 */
export function useFind(
  serviceName: string,
  params: Record<string, UntypedData> = {},
): QueryResult<UntypedData[], Record<string, unknown>> {
  return useFindImpl<UntypedData[], Record<string, unknown>, Record<string, unknown>>(
    useFigbird(),
    serviceName,
    params,
  )
}

/**
 * The single spot the legacy get call shape (`serviceName, id, params+config`) is
 * assembled into a transport-path descriptor. @internal
 */
export function useGetImpl<T, TMeta extends Record<string, unknown>, TQuery>(
  figbird: DescFigbirdLike,
  serviceName: string,
  resourceId: string | number,
  params: Record<string, unknown> = {},
): QueryResult<T, TMeta> {
  const { desc, config } = splitConfig<T, TQuery>({
    serviceName,
    method: 'get' as const,
    resourceId,
    ...params,
  })
  return useQueryByDescImpl<T, TMeta, TQuery>(figbird, desc, config)
}

/** Find twin of `useGetImpl`. @internal */
export function useFindImpl<T, TMeta extends Record<string, unknown>, TQuery>(
  figbird: DescFigbirdLike,
  serviceName: string,
  params: Record<string, unknown> = {},
): QueryResult<T, TMeta> {
  const { desc, config } = splitConfig<T, TQuery>({
    serviceName,
    method: 'find' as const,
    ...params,
  })
  return useQueryByDescImpl<T, TMeta, TQuery>(figbird, desc, config)
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

/** The slice of a Figbird instance the descriptor hooks need. @internal */
export interface DescFigbirdLike {
  queryDesc(
    desc: QueryDescriptor,
    config: QueryConfig<unknown, unknown>,
  ): {
    hash(): string
    refetch(): void
    subscribe(fn: () => void): () => void
    getSnapshot(): unknown
  }
  adapter: { emptyMeta(): unknown }
}

export function useQueryByDescImpl<
  T,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TQuery = unknown,
>(
  figbird: DescFigbirdLike,
  desc: QueryDescriptor,
  config: QueryConfig<T, TQuery>,
): QueryResult<T, TMeta> {
  // For network-only and custom matcher queries, we need a unique ID for each hook
  // instance to ensure that queries are not shared between components.
  // useId provides a stable, unique ID for the lifetime of the component.
  const uniqueId = useId()

  // we create a new query on each render! but we'll throw it away via useMemo
  // if the q.hash() is the same as the previous query, this allows us to keep
  // the q.subscribe and q.getSnapshot stable and avoid unsubbing and resubbing
  // you don't need to do this outside React where you can more easily create a
  // stable reference to a query and use it for as long as you want
  const shouldScopeToHook = isEphemeralQuery(config)
  const queryConfig = shouldScopeToHook
    ? ({
        ...config,
        [queryIdentityKey]: uniqueId,
      } as QueryConfig<unknown, unknown> & QueryIdentityConfig)
    : (config as QueryConfig<unknown, unknown>)
  const _q = figbird.queryDesc(desc, queryConfig)

  // a bit of React foo to create stable fn references
  const hash = _q.hash()
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed on hash, not _q identity
  const q = useMemo(() => _q, [hash])
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

  return useMemo(() => {
    // Preserve the legacy error contract while the store retains warm rows.
    const status = queryResult.error
      ? queryResult.isFetching
        ? 'loading'
        : 'error'
      : queryResult.status
    const result: UntypedData = {
      status,
      data: status === 'success' ? queryResult.data : null,
      isFetching: queryResult.isFetching,
      error: status === 'error' ? queryResult.error : null,
      refetch,
    }
    if ('meta' in queryResult) {
      result.meta = queryResult.error ? emptyMetaRef.current : queryResult.meta
    }
    return result as QueryResult<T, TMeta>
  }, [queryResult, refetch])
}
