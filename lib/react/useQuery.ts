import { useCallback, useId, useMemo, useRef, useSyncExternalStore } from 'react'
import type { QueryState } from '../core/figbird.js'
import { splitConfig, type QueryConfig, type QueryDescriptor } from '../core/figbird.js'
import { findServiceByName } from '../core/schema.js'
import { useFigbird } from './react.js'

type BaseQueryResult = {
  refetch: () => void
}

export type QueryResult<T, TMeta = undefined> = BaseQueryResult &
  (TMeta extends undefined
    ?
        | {
            status: 'idle' | 'loading'
            data: null
            isFetching: boolean
            error: null
          }
        | {
            status: 'success'
            data: T
            isFetching: boolean
            error: null
          }
        | {
            status: 'error'
            data: null
            isFetching: boolean
            error: Error
          }
    :
        | {
            status: 'idle' | 'loading'
            data: null
            meta: TMeta
            isFetching: boolean
            error: null
          }
        | {
            status: 'success'
            data: T
            meta: TMeta
            isFetching: boolean
            error: null
          }
        | {
            status: 'error'
            data: null
            meta: TMeta
            isFetching: boolean
            error: Error
          })

/**
 * Hook for fetching a single item by ID.
 * Returns untyped data. For type-safe queries, use createHooks(figbird).
 */
export function useGet(
  serviceName: string,
  resourceId: string | number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: Record<string, any> = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): QueryResult<any> {
  const figbird = useFigbird()
  const service = findServiceByName(figbird.schema, serviceName)
  const actualServiceName = service?.name ?? serviceName
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { desc, config } = splitConfig<any, Record<string, unknown>>({
    serviceName: actualServiceName,
    method: 'get' as const,
    resourceId,
    ...params,
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return useQuery<any, Record<string, unknown>, Record<string, unknown>>(
    desc,
    config,
  ) as QueryResult<any> // eslint-disable-line @typescript-eslint/no-explicit-any
}

/**
 * Hook for fetching multiple items with optional query parameters.
 * Returns untyped data. For type-safe queries, use createHooks(figbird).
 */
export function useFind(
  serviceName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: Record<string, any> = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): QueryResult<any[], Record<string, unknown>> {
  const figbird = useFigbird()
  const service = findServiceByName(figbird.schema, serviceName)
  const actualServiceName = service?.name ?? serviceName
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { desc, config } = splitConfig<any[], Record<string, unknown>>({
    serviceName: actualServiceName,
    method: 'find' as const,
    ...params,
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return useQuery<any[], Record<string, unknown>, Record<string, unknown>>(desc, config)
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
export function useQuery<
  T,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TQuery = unknown,
>(desc: QueryDescriptor, config: QueryConfig<T, TQuery>): QueryResult<T, TMeta> {
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
  const _q = figbird.query(desc, {
    ...config,
    ...(config.fetchPolicy === 'network-only' ? { uid: uniqueId } : {}),
  } as QueryConfig<unknown, unknown>)

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

  return useMemo(() => {
    // Handle each case of the discriminated union explicitly
    if (queryResult.status === 'success') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = {
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = {
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
      // status === 'idle' || status === 'loading'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = {
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
