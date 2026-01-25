import { useCallback, useId, useMemo, useRef, useSyncExternalStore } from 'react'
import type { InfiniteFindQueryConfig, InfiniteQueryState } from '../core/figbird.js'
import { useFigbird } from './react.js'

/**
 * Configuration for infinite/cursor-based pagination queries
 */
export interface UseInfiniteFindConfig<TItem, TQuery> {
  /** Query parameters for filtering/sorting */
  query?: TQuery
  /** Skip fetching entirely */
  skip?: boolean
  /** Realtime strategy: 'merge' inserts events in sorted order, 'refetch' resets to first page, 'disabled' ignores events */
  realtime?: 'merge' | 'refetch' | 'disabled'
  /** Page size limit (defaults to adapter's default) */
  limit?: number
  /** Custom matcher for realtime events (default: built from query using adapter.matcher/sift) */
  matcher?: (query: TQuery | undefined) => (item: TItem) => boolean
  /** Custom sorter for inserting realtime events (default: built from query.$sort) */
  sorter?: (a: TItem, b: TItem) => number
}

/**
 * Result type for infinite/cursor-based pagination queries
 */
export interface UseInfiniteFindResult<TItem, TMeta> {
  /** Current status of the query */
  status: 'loading' | 'success' | 'error'
  /** Accumulated data from all loaded pages */
  data: TItem[]
  /** Metadata from the last fetched page */
  meta: TMeta
  /** Whether any fetch is in progress (initial or loadMore) */
  isFetching: boolean
  /** Whether a loadMore fetch is in progress */
  isLoadingMore: boolean
  /** Error from loadMore operation (separate from initial error) */
  loadMoreError: Error | null
  /** Error from initial fetch */
  error: Error | null
  /** Whether there are more pages available */
  hasNextPage: boolean
  /** Load the next page */
  loadMore: () => void
  /** Refetch from the beginning */
  refetch: () => void
}

function getInitialInfiniteQueryState<TItem, TMeta extends Record<string, unknown>>(
  emptyMeta: TMeta,
): InfiniteQueryState<TItem, TMeta> {
  return {
    status: 'loading' as const,
    data: [],
    meta: emptyMeta,
    isFetching: true,
    isLoadingMore: false,
    loadMoreError: null,
    error: null,
    hasNextPage: false,
    pageParam: null,
  }
}

/**
 * Hook for infinite/cursor-based pagination with realtime updates.
 * Manages accumulated data across pages with loadMore functionality.
 *
 * This is a thin wrapper around Figbird's query system using useSyncExternalStore.
 * All state is stored in Figbird's central store, enabling:
 * - Consistency with mutations (patching an item updates it everywhere)
 * - Entity deduplication across queries
 * - Proper realtime event batching and handling
 */
export function useInfiniteFind<
  TItem,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TQuery = Record<string, unknown>,
>(
  serviceName: string,
  config: UseInfiniteFindConfig<TItem, TQuery> = {},
): UseInfiniteFindResult<TItem, TMeta> {
  const figbird = useFigbird()

  const { query, skip = false, realtime = 'merge', limit, matcher, sorter } = config

  // Each hook instance gets its own unique query via instanceId.
  // This ensures pagination state is not shared between components,
  // while the underlying entities are still shared in the central cache.
  const instanceId = useId()

  // Build the query config
  const queryConfig: InfiniteFindQueryConfig<TItem[], TQuery> = useMemo(
    () => ({
      skip,
      realtime,
      ...(limit !== undefined && { limit }),
      ...(matcher !== undefined && { matcher }),
      ...(sorter !== undefined && { sorter }),
    }),
    [skip, realtime, limit, matcher, sorter],
  )

  // Create the query reference.
  // We create a new one on each render but use useMemo with the hash to stabilize it.
  const _q = figbird.query(
    {
      serviceName,
      method: 'infiniteFind' as const,
      params: query ? { query } : undefined,
      instanceId,
    },
    queryConfig as InfiniteFindQueryConfig<unknown[], unknown>,
  )

  // Stabilize the query ref by its hash
  const q = useMemo(() => _q, [_q.hash()])

  // Cache empty meta to avoid creating it repeatedly
  const emptyMetaRef = useRef<TMeta | null>(null)
  if (emptyMetaRef.current == null) {
    emptyMetaRef.current = figbird.adapter.emptyMeta() as TMeta
  }

  // Callbacks for useSyncExternalStore
  const subscribe = useCallback((onStoreChange: () => void) => q.subscribe(onStoreChange), [q])

  const getSnapshot = useCallback(
    (): InfiniteQueryState<TItem, TMeta> =>
      (q.getSnapshot() as InfiniteQueryState<TItem, TMeta> | undefined) ??
      getInitialInfiniteQueryState<TItem, TMeta>(emptyMetaRef.current!),
    [q],
  )

  // Subscribe to the query state changes
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  // Action callbacks
  const loadMore = useCallback(() => q.loadMore(), [q])
  const refetch = useCallback(() => q.refetch(), [q])

  return useMemo(
    () => ({
      status: state.status,
      data: state.data,
      meta: state.meta,
      isFetching: state.isFetching,
      isLoadingMore: state.isLoadingMore,
      loadMoreError: state.loadMoreError,
      error: state.error,
      hasNextPage: state.hasNextPage,
      loadMore,
      refetch,
    }),
    [state, loadMore, refetch],
  )
}
