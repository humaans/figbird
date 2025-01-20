import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { splitConfig } from '../core/figbird'
import { useFigbird } from './react'
import type { Schema, InferServiceType } from '../core/schema'

type ServiceName<S extends Schema<any>> = keyof S & string

export interface QueryResult<TData> {
  data: TData | null
  status: 'idle' | 'loading' | 'success' | 'error'
  isFetching: boolean
  error: Error | null
  refetch: () => void
}

export function useGet<S extends Schema<any>, K extends ServiceName<S>>(
  serviceName: K,
  resourceId: string,
  params: Record<string, any> = {},
): QueryResult<InferServiceType<S, K>> {
  const { desc, config } = splitConfig<S, K>({
    serviceName,
    method: 'get',
    resourceId,
    ...params,
  })
  return useQuery<S, K, InferServiceType<S, K>>(desc, config)
}

export function useFind<S extends Schema<any>, K extends ServiceName<S>>(
  serviceName: K,
  params: Record<string, any> = {},
): QueryResult<InferServiceType<S, K>[]> {
  const { desc, config } = splitConfig<S, K>({
    serviceName,
    method: 'find',
    ...params,
  })
  return useQuery<S, K, InferServiceType<S, K>[]>(desc, config)
}

let _seq = 0

export function useQuery<S extends Schema<any>, K extends ServiceName<S>, TData>(
  desc: {
    serviceName: K
    method: string
    resourceId?: string
    params?: any
  },
  config: any,
): QueryResult<TData> {
  const figbird = useFigbird<S>()
  if (!figbird) {
    throw new Error('Figbird context not found.')
  }

  // The "seq" can be used to force a re-fetch in "network-only" mode
  const [seq] = useState(() => _seq++)

  // Get the actual query instance from figbird
  const _q = figbird.query(desc, {
    ...config,
    ...(config.fetchPolicy === 'network-only' ? { seq } : {}),
  })

  // Because figbird.query(...) might return a new object each time,
  // we memoize it by its .hash() (or some stable key).
  const q = useMemo(() => _q, [_q?.hash()])

  // Setup callbacks for the React 18 useSyncExternalStore pattern
  const refetch = useCallback(() => q.refetch?.(), [q])
  const subscribe = useCallback((fn: () => void) => q.subscribe?.(fn), [q])
  const getSnapshot = useCallback(() => q.getSnapshot?.(), [q])

  // Now read the external store to track changes in the query.
  const queryResult = useSyncExternalStore(subscribe, getSnapshot, getSnapshot) as {
    data: unknown
    status: 'idle' | 'loading' | 'success' | 'error'
    isFetching: boolean
    error: Error | null
  }

  // Finally, build our typed return object, converting `data` into TData
  return useMemo(
    () => ({
      data: queryResult.data as TData | null,
      status: queryResult.status,
      isFetching: queryResult.isFetching,
      error: queryResult.error,
      refetch,
    }),
    [queryResult, refetch],
  )
}
