import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type { Adapter, EventHandlers } from '../adapters/adapter.js'
import { useFigbird } from './react.js'

/**
 * Configuration for infinite/cursor-based pagination queries
 */
export interface UseInfiniteFindConfig<TItem, TQuery, TMeta> {
  /** Query parameters for filtering/sorting */
  query?: TQuery
  /** Skip fetching entirely */
  skip?: boolean
  /** Realtime strategy: 'merge' inserts events in sorted order, 'refetch' resets to first page, 'disabled' ignores events */
  realtime?: 'merge' | 'refetch' | 'disabled'
  /** Fetch all pages automatically on initial load */
  fetchAllPages?: boolean
  /** Page size limit (defaults to adapter's default) */
  limit?: number
  /** Custom matcher for realtime events (default: built from query using adapter.matcher/sift) */
  matcher?: (query: TQuery | undefined) => (item: TItem) => boolean
  /** Custom sorter for inserting realtime events (default: built from query.$sort) */
  sorter?: (a: TItem, b: TItem) => number
  /**
   * Extract next page param from response. Returns cursor string, skip number, or null if no more pages.
   * Auto-detects mode: uses cursor if meta.endCursor exists, otherwise uses offset (skip).
   */
  getPageParam?: (meta: TMeta, data: TItem[], allData: TItem[]) => string | number | null
  /** Custom hasNextPage extraction (default: meta.hasNextPage or derived from getPageParam) */
  getHasNextPage?: (meta: TMeta, data: TItem[], allData: TItem[]) => boolean
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

// State shape for the reducer
interface InfiniteState<TItem, TMeta> {
  status: 'loading' | 'success' | 'error'
  data: TItem[]
  meta: TMeta
  isFetching: boolean
  isLoadingMore: boolean
  loadMoreError: Error | null
  error: Error | null
  hasNextPage: boolean
  pageParam: string | number | null // cursor string OR skip number
}

// Action types
type InfiniteAction<TItem, TMeta> =
  | { type: 'FETCH_START' }
  | {
      type: 'FETCH_SUCCESS'
      data: TItem[]
      meta: TMeta
      hasNextPage: boolean
      pageParam: string | number | null
    }
  | { type: 'FETCH_ERROR'; error: Error }
  | { type: 'LOAD_MORE_START' }
  | {
      type: 'LOAD_MORE_SUCCESS'
      data: TItem[]
      meta: TMeta
      hasNextPage: boolean
      pageParam: string | number | null
    }
  | { type: 'LOAD_MORE_ERROR'; error: Error }
  | { type: 'REFETCH' }
  | { type: 'REALTIME_UPDATE'; data: TItem[] }

function createReducer<TItem, TMeta>(emptyMeta: TMeta) {
  return function reducer(
    state: InfiniteState<TItem, TMeta>,
    action: InfiniteAction<TItem, TMeta>,
  ): InfiniteState<TItem, TMeta> {
    switch (action.type) {
      case 'FETCH_START':
        return {
          ...state,
          isFetching: true,
          error: null,
        }
      case 'FETCH_SUCCESS':
        return {
          status: 'success',
          data: action.data,
          meta: action.meta,
          isFetching: false,
          isLoadingMore: false,
          loadMoreError: null,
          error: null,
          hasNextPage: action.hasNextPage,
          pageParam: action.pageParam,
        }
      case 'FETCH_ERROR':
        return {
          ...state,
          status: 'error',
          isFetching: false,
          error: action.error,
        }
      case 'LOAD_MORE_START':
        return {
          ...state,
          isLoadingMore: true,
          loadMoreError: null,
        }
      case 'LOAD_MORE_SUCCESS':
        return {
          ...state,
          data: [...state.data, ...action.data],
          meta: action.meta,
          isLoadingMore: false,
          hasNextPage: action.hasNextPage,
          pageParam: action.pageParam,
        }
      case 'LOAD_MORE_ERROR':
        return {
          ...state,
          isLoadingMore: false,
          loadMoreError: action.error,
        }
      case 'REFETCH':
        return {
          status: 'loading',
          data: [],
          meta: emptyMeta,
          isFetching: true,
          isLoadingMore: false,
          loadMoreError: null,
          error: null,
          hasNextPage: false,
          pageParam: null,
        }
      case 'REALTIME_UPDATE':
        return {
          ...state,
          data: action.data,
        }
      default:
        return state
    }
  }
}

/**
 * Build a sorter function from a $sort object
 */
function buildSorter<TItem>(
  sort: Record<string, 1 | -1> | undefined,
): (a: TItem, b: TItem) => number {
  if (!sort || Object.keys(sort).length === 0) {
    // Default: append at end (no sorting)
    return () => 0
  }

  const sortEntries = Object.entries(sort)
  return (a: TItem, b: TItem) => {
    for (const [key, direction] of sortEntries) {
      const aVal = (a as Record<string, unknown>)[key]
      const bVal = (b as Record<string, unknown>)[key]

      let cmp = 0
      if (aVal == null && bVal == null) {
        cmp = 0
      } else if (aVal == null) {
        cmp = 1
      } else if (bVal == null) {
        cmp = -1
      } else if (typeof aVal === 'string' && typeof bVal === 'string') {
        cmp = aVal.localeCompare(bVal)
      } else if (aVal < bVal) {
        cmp = -1
      } else if (aVal > bVal) {
        cmp = 1
      }

      if (cmp !== 0) {
        return cmp * direction
      }
    }
    return 0
  }
}

/**
 * Insert an item into a sorted array at the correct position
 */
function insertSorted<TItem>(
  data: TItem[],
  item: TItem,
  sorter: (a: TItem, b: TItem) => number,
): TItem[] {
  const result = [...data]
  let low = 0
  let high = result.length

  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (sorter(item, result[mid]!) <= 0) {
      high = mid
    } else {
      low = mid + 1
    }
  }

  result.splice(low, 0, item)
  return result
}

/**
 * Hook for infinite/cursor-based pagination with realtime updates.
 * Manages accumulated data across pages with loadMore functionality.
 */
export function useInfiniteFind<
  TItem,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TQuery = Record<string, unknown>,
>(
  serviceName: string,
  config: UseInfiniteFindConfig<TItem, TQuery, TMeta> = {},
): UseInfiniteFindResult<TItem, TMeta> {
  const figbird = useFigbird()
  const adapter = figbird.adapter as Adapter<unknown, TMeta, TQuery & Record<string, unknown>>

  // Default getPageParam: auto-detect mode from response
  const defaultGetPageParam = (meta: TMeta, data: TItem[], _allData: TItem[]) => {
    // Cursor mode: if endCursor exists, use it
    if ('endCursor' in meta && meta.endCursor != null) {
      return meta.endCursor as string
    }
    // Offset mode: calculate next skip value
    const skip = (meta as Record<string, unknown>).skip as number | undefined
    const limit = (meta as Record<string, unknown>).limit as number | undefined
    const total = (meta as Record<string, unknown>).total as number | undefined
    const currentSkip = skip ?? 0
    const nextSkip = currentSkip + data.length
    // No more pages if we've fetched everything
    if (total !== undefined && nextSkip >= total) return null
    // No more pages if we got fewer items than limit (and limit is known)
    if (limit !== undefined && data.length < limit) return null
    // If we got no data, no more pages
    if (data.length === 0) return null
    return nextSkip
  }

  // Default getHasNextPage: derive from pageParam or explicit meta.hasNextPage
  const defaultGetHasNextPage = (meta: TMeta, data: TItem[], allData: TItem[]) => {
    // If meta.hasNextPage is explicitly set, use it
    if ('hasNextPage' in meta && typeof meta.hasNextPage === 'boolean') {
      return meta.hasNextPage
    }
    // Otherwise derive from whether getPageParam returns non-null
    return defaultGetPageParam(meta, data, allData) !== null
  }

  const {
    query,
    skip = false,
    realtime = 'merge',
    fetchAllPages = false,
    limit,
    matcher: customMatcher,
    sorter: customSorter,
    getPageParam = defaultGetPageParam,
    getHasNextPage = defaultGetHasNextPage,
  } = config

  const emptyMeta = useMemo(() => adapter.emptyMeta(), [adapter])
  const reducer = useMemo(() => createReducer<TItem, TMeta>(emptyMeta), [emptyMeta])

  const [state, dispatch] = useReducer(reducer, {
    status: 'loading',
    data: [],
    meta: emptyMeta,
    isFetching: !skip,
    isLoadingMore: false,
    loadMoreError: null,
    error: null,
    hasNextPage: false,
    pageParam: null,
  })

  // Build matcher for realtime events
  const itemMatcher = useMemo(() => {
    if (realtime !== 'merge') return () => false
    if (customMatcher) return customMatcher(query)
    return adapter.matcher(query as (TQuery & Record<string, unknown>) | undefined) as (
      item: TItem,
    ) => boolean
  }, [adapter, query, realtime, customMatcher])

  // Build sorter for realtime insertions
  const itemSorter = useMemo(() => {
    if (customSorter) return customSorter
    const sort = (query as { $sort?: Record<string, 1 | -1> } | undefined)?.$sort
    return buildSorter<TItem>(sort)
  }, [query, customSorter])

  // Refs to access latest values in callbacks
  const stateRef = useRef(state)
  stateRef.current = state

  const configRef = useRef({ query, limit, getPageParam, getHasNextPage })
  configRef.current = { query, limit, getPageParam, getHasNextPage }

  // Fetch function
  const fetchPage = useCallback(
    async (pageParam: string | number | null, isLoadMore: boolean, allData: TItem[] = []) => {
      const {
        query: currentQuery,
        limit: currentLimit,
        getPageParam: gpp,
        getHasNextPage: ghnp,
      } = configRef.current

      const params: Record<string, unknown> = {
        query: {
          ...currentQuery,
          ...(currentLimit && { $limit: currentLimit }),
          // Add pagination param based on type
          ...(typeof pageParam === 'string' && { cursor: pageParam }),
          ...(typeof pageParam === 'number' && { $skip: pageParam }),
        },
      }

      try {
        const result = await adapter.find(serviceName, params)
        const data = result.data as TItem[]
        const meta = result.meta as TMeta
        const newAllData = isLoadMore ? [...allData, ...data] : data
        const nextPageParam = gpp(meta, data, newAllData)
        const hasMore = ghnp(meta, data, newAllData)

        if (isLoadMore) {
          dispatch({
            type: 'LOAD_MORE_SUCCESS',
            data,
            meta,
            hasNextPage: hasMore,
            pageParam: nextPageParam,
          })
        } else {
          dispatch({
            type: 'FETCH_SUCCESS',
            data,
            meta,
            hasNextPage: hasMore,
            pageParam: nextPageParam,
          })
        }

        return { data, meta, hasNextPage: hasMore, pageParam: nextPageParam, allData: newAllData }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        if (isLoadMore) {
          dispatch({ type: 'LOAD_MORE_ERROR', error })
        } else {
          dispatch({ type: 'FETCH_ERROR', error })
        }
        return null
      }
    },
    [adapter, serviceName],
  )

  // Initial fetch effect
  useEffect(() => {
    if (skip) return

    let cancelled = false

    async function initialFetch() {
      dispatch({ type: 'FETCH_START' })

      const result = await fetchPage(null, false, [])

      if (cancelled || !result) return

      // If fetchAllPages is enabled, continue fetching
      if (fetchAllPages && result.hasNextPage && result.pageParam !== null) {
        let currentPageParam: string | number | null = result.pageParam
        let hasMore: boolean = result.hasNextPage
        let allData: TItem[] = result.allData

        while (hasMore && currentPageParam !== null && !cancelled) {
          dispatch({ type: 'LOAD_MORE_START' })
          const nextResult = await fetchPage(currentPageParam, true, allData)
          if (!nextResult || cancelled) break
          currentPageParam = nextResult.pageParam
          hasMore = nextResult.hasNextPage
          allData = nextResult.allData
        }
      }
    }

    initialFetch()

    return () => {
      cancelled = true
    }
    // Note: We intentionally use JSON.stringify(query) to re-fetch when query changes
  }, [skip, fetchPage, fetchAllPages, JSON.stringify(query)])

  // loadMore function
  const loadMore = useCallback(() => {
    const currentState = stateRef.current
    if (
      currentState.isLoadingMore ||
      !currentState.hasNextPage ||
      currentState.pageParam === null
    ) {
      return
    }
    dispatch({ type: 'LOAD_MORE_START' })
    fetchPage(currentState.pageParam, true, currentState.data)
  }, [fetchPage])

  // refetch function
  const refetch = useCallback(() => {
    dispatch({ type: 'REFETCH' })
    fetchPage(null, false, [])
  }, [fetchPage])

  // Realtime subscription effect
  useEffect(() => {
    if (skip || realtime === 'disabled' || !adapter.subscribe) {
      return
    }

    const getId = (item: unknown) => adapter.getId(item)

    const handlers: EventHandlers = {
      created: (item: unknown) => {
        if (realtime === 'refetch') {
          refetch()
          return
        }

        const typedItem = item as TItem
        if (!itemMatcher(typedItem)) return

        const currentData = stateRef.current.data
        const newData = insertSorted(currentData, typedItem, itemSorter)
        dispatch({ type: 'REALTIME_UPDATE', data: newData })
      },
      updated: (item: unknown) => {
        if (realtime === 'refetch') {
          refetch()
          return
        }

        const typedItem = item as TItem
        const itemId = getId(typedItem)
        const currentData = stateRef.current.data
        const existingIndex = currentData.findIndex(d => getId(d) === itemId)
        const matches = itemMatcher(typedItem)

        if (existingIndex >= 0 && !matches) {
          // Remove: no longer matches
          const newData = currentData.filter((_, i) => i !== existingIndex)
          dispatch({ type: 'REALTIME_UPDATE', data: newData })
        } else if (existingIndex >= 0 && matches) {
          // Update in place
          const newData = [...currentData]
          newData[existingIndex] = typedItem
          dispatch({ type: 'REALTIME_UPDATE', data: newData })
        } else if (existingIndex < 0 && matches) {
          // New item that matches - insert sorted
          const newData = insertSorted(currentData, typedItem, itemSorter)
          dispatch({ type: 'REALTIME_UPDATE', data: newData })
        }
      },
      patched: (item: unknown) => {
        // Same logic as updated
        handlers.updated(item)
      },
      removed: (item: unknown) => {
        if (realtime === 'refetch') {
          refetch()
          return
        }

        const typedItem = item as TItem
        const itemId = getId(typedItem)
        const currentData = stateRef.current.data
        const newData = currentData.filter(d => getId(d) !== itemId)
        if (newData.length !== currentData.length) {
          dispatch({ type: 'REALTIME_UPDATE', data: newData })
        }
      },
    }

    const unsubscribe = adapter.subscribe(serviceName, handlers)
    return unsubscribe
  }, [serviceName, skip, realtime, adapter, itemMatcher, itemSorter, refetch])

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
