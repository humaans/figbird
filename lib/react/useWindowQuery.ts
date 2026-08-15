import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { AnyWindowQueryBuilder, QueryBuilderItem } from '../core/queryBuilder.js'
import type { QueryInput, QueryRequest } from '../core/queryDefinition.js'
import type { Schema } from '../core/schema.js'
import type { WindowQueryConfig, WindowQueryState, WindowRange } from '../core/windowQuery.js'
import { useFigbird } from './context.js'
import type { UseQueryOptions } from './useQuery.js'

export type { WindowRange }

export interface UseWindowQueryOptions extends UseQueryOptions {
  /** Visible row indexes; `start` is inclusive and `end` is exclusive. */
  range: WindowRange
  /** Number of server rows in one retained block. */
  pageSize: number
  /** Adjacent blocks fetched ahead of the visible range. Defaults to 1. */
  preloadPages?: number
  /** Maximum retained blocks, excluding blocks required by active readers. Defaults to 5. */
  maxPages?: number
}

export type WindowQueryResult<T> =
  | {
      status: 'idle' | 'loading'
      data: ReadonlyMap<number, T>
      total: number | undefined
      error: null
      isFetching: boolean
      refetch: () => void
    }
  | {
      status: 'success'
      data: ReadonlyMap<number, T>
      total: number | undefined
      error: Error | null
      isFetching: boolean
      refetch: () => void
    }
  | {
      status: 'error'
      data: ReadonlyMap<number, T>
      total: number | undefined
      error: Error
      isFetching: false
      refetch: () => void
    }

type WindowData<T> = ReadonlyMap<number, T>

type SkipAwareWindowData<T, O extends UseWindowQueryOptions> = [O] extends [{ skip: false }]
  ? WindowData<T>
  : O extends { skip: boolean }
    ? WindowData<T> | undefined
    : WindowData<T>

export interface SuspenseWindowQueryResult<T, TData = WindowData<T>> {
  data: TData
  total: number | undefined
  error: Error | null
  isFetching: boolean
  refetch: () => void
}

interface WindowQueryRefLike<T> {
  subscribe(
    listener: (state: WindowQueryState<T>) => void,
    options: { range: WindowRange; staleTime?: number },
  ): () => void
  getSnapshot(range: WindowRange): WindowQueryState<T>
  refetch(): void
  suspensePromise(range: WindowRange): Promise<void>
  releaseColdStart(range: WindowRange): void
}

interface FigbirdWindowLike {
  window<Args, B extends AnyWindowQueryBuilder>(
    query: QueryInput<B, Args>,
    config: WindowQueryConfig,
  ): WindowQueryRefLike<QueryBuilderItem<B>>
}

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export interface UseWindowQueryHook<S extends Schema = any> {
  <Args, B extends AnyWindowQueryBuilder<S>>(
    query: QueryInput<B, Args>,
    options: UseWindowQueryOptions & { suspense: false },
  ): WindowQueryResult<QueryBuilderItem<B>>
  <Args, B extends AnyWindowQueryBuilder<S>, O extends UseWindowQueryOptions>(
    query: QueryInput<B, Args>,
    options: O,
  ): SuspenseWindowQueryResult<QueryBuilderItem<B>, SkipAwareWindowData<QueryBuilderItem<B>, O>>
  <Args, B extends AnyWindowQueryBuilder<S>>(
    request: QueryRequest<Args, B> | null,
    options: UseWindowQueryOptions & { suspense: false },
  ): WindowQueryResult<QueryBuilderItem<B>>
  <Args, B extends AnyWindowQueryBuilder<S>>(
    request: QueryRequest<Args, B> | null,
    options: UseWindowQueryOptions,
  ): SuspenseWindowQueryResult<QueryBuilderItem<B>, WindowData<QueryBuilderItem<B>> | undefined>
}

const EMPTY_DATA: ReadonlyMap<number, never> = new Map<number, never>()
const idleState = {
  status: 'idle' as const,
  data: EMPTY_DATA,
  total: undefined,
  error: null,
  isFetching: false,
}

function normalizeConfig(options: UseWindowQueryOptions): WindowQueryConfig {
  const { pageSize, preloadPages = 1, maxPages = 5 } = options
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error(`useWindowQuery(): pageSize must be a positive integer, got ${pageSize}`)
  }
  if (!Number.isInteger(preloadPages) || preloadPages < 0) {
    throw new Error(
      `useWindowQuery(): preloadPages must be a non-negative integer, got ${preloadPages}`,
    )
  }
  if (!Number.isInteger(maxPages) || maxPages <= 0) {
    throw new Error(`useWindowQuery(): maxPages must be a positive integer, got ${maxPages}`)
  }
  return { pageSize, preloadPages, maxPages }
}

export const useWindowQuery: UseWindowQueryHook = ((
  query: QueryInput<AnyWindowQueryBuilder> | null,
  options: UseWindowQueryOptions,
): unknown =>
  useWindowQueryImpl(useFigbird() as FigbirdWindowLike, query, options)) as UseWindowQueryHook

export function useWindowQueryImpl(
  figbird: FigbirdWindowLike,
  query: QueryInput<AnyWindowQueryBuilder> | null,
  options: UseWindowQueryOptions,
): unknown {
  const { range, suspense = true, staleTime, skip = false } = options
  const config = normalizeConfig(options)
  const qRef = skip || query === null ? null : figbird.window(query, config)
  const stableRange = useMemo(
    () => ({ start: range.start, end: range.end }),
    [range.start, range.end],
  )

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!qRef) return () => {}
      return qRef.subscribe(onStoreChange, {
        range: stableRange,
        ...(staleTime !== undefined ? { staleTime } : {}),
      })
    },
    [qRef, stableRange, staleTime],
  )
  const getSnapshot = useCallback(
    () => (qRef ? qRef.getSnapshot(stableRange) : idleState),
    [qRef, stableRange],
  )
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const refetch = useCallback(() => qRef?.refetch(), [qRef])

  const taggedResult = useMemo(
    () => ({ ...state, refetch }) as WindowQueryResult<unknown>,
    [state, refetch],
  )
  if (!suspense) return taggedResult

  if (!qRef) {
    return {
      data: undefined,
      total: undefined,
      error: null,
      isFetching: false,
      refetch,
    }
  }
  if (state.status === 'error') {
    qRef.releaseColdStart(stableRange)
    throw state.error
  }
  if (state.status !== 'success') throw qRef.suspensePromise(stableRange)

  return {
    data: state.data,
    total: state.total,
    error: state.error,
    isFetching: state.isFetching,
    refetch,
  }
}
