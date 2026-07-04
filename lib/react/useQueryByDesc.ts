import { useCallback, useId, useMemo, useRef, useSyncExternalStore } from 'react'
import type { QueryState } from '../core/figbird.js'
import { splitConfig, type QueryConfig, type QueryDescriptor } from '../core/figbird.js'
import { queryIdentityKey, type QueryIdentityConfig } from '../core/queryIdentity.js'
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
 * Returns untyped data. For type-safe queries, use createHooks(figbird).
 *
 * @deprecated Legacy descriptor-based hook. Prefer `useQuery(q.service.get(id))` from
 * the builder API — this stays functional but new code should not use it.
 */
export function useGet(
  serviceName: string,
  resourceId: string | number,
  params: Record<string, UntypedData> = {},
): QueryResult<UntypedData> {
  // Service path aliases are resolved centrally by figbird.query().
  const { desc, config } = splitConfig<UntypedData, Record<string, unknown>>({
    serviceName,
    method: 'get' as const,
    resourceId,
    ...params,
  })
  return useQueryByDesc<UntypedData, Record<string, unknown>, Record<string, unknown>>(
    desc,
    config,
  ) as QueryResult<UntypedData>
}

/**
 * Hook for fetching multiple items with optional query parameters.
 * Returns untyped data. For type-safe queries, use createHooks(figbird).
 *
 * @deprecated Legacy descriptor-based hook. Prefer `useQuery(q.service.where(...))` from
 * the builder API — this stays functional but new code should not use it.
 */
export function useFind(
  serviceName: string,
  params: Record<string, UntypedData> = {},
): QueryResult<UntypedData[], Record<string, unknown>> {
  // Service path aliases are resolved centrally by figbird.query().
  const { desc, config } = splitConfig<UntypedData[], Record<string, unknown>>({
    serviceName,
    method: 'find' as const,
    ...params,
  })
  return useQueryByDesc<UntypedData[], Record<string, unknown>, Record<string, unknown>>(
    desc,
    config,
  )
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

  const { data, status } = useQueryByDesc({
    serviceName: 'notes',
    method: 'find'
  })

*/
function useQueryByDesc<
  T,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TQuery = unknown,
>(desc: QueryDescriptor, config: QueryConfig<T, TQuery>): QueryResult<T, TMeta> {
  return useQueryByDescImpl(useFigbird(), desc, config)
}

/**
 * Instance-taking implementation shared by the context-bound hooks and the
 * bound-instance hooks that `createHooks` produces. @internal
 */
export function useQueryByDescImpl<
  T,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TQuery = unknown,
>(
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  figbird: any,
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
  const shouldScopeToHook = config.fetchPolicy === 'network-only' || config.matcher
  const queryConfig = shouldScopeToHook
    ? ({
        ...config,
        [queryIdentityKey]: uniqueId,
      } as QueryConfig<unknown, unknown> & QueryIdentityConfig)
    : (config as QueryConfig<unknown, unknown>)
  const _q = figbird.query(desc, queryConfig)

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
    // Handle each case of the discriminated union explicitly
    if (queryResult.status === 'success') {
      const result: UntypedData = {
        status: 'success' as const,
        data: queryResult.data,
        isFetching: queryResult.isFetching,
        error: null,
        refetch,
      }
      if ('meta' in queryResult) {
        result.meta = queryResult.meta
      }
      return result as QueryResult<T, TMeta>
    } else if (queryResult.status === 'error') {
      const result: UntypedData = {
        status: 'error' as const,
        data: null,
        isFetching: queryResult.isFetching,
        error: queryResult.error,
        refetch,
      }
      if ('meta' in queryResult) {
        result.meta = queryResult.meta
      }
      return result as QueryResult<T, TMeta>
    } else {
      // status === 'loading'
      const result: UntypedData = {
        status: queryResult.status,
        data: null,
        isFetching: queryResult.isFetching,
        error: null,
        refetch,
      }
      if ('meta' in queryResult) {
        result.meta = queryResult.meta
      }
      return result as QueryResult<T, TMeta>
    }
  }, [queryResult, refetch])
}
