import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type { Adapter, EventHandlers } from '../adapters/adapter.js'
import { useFigbird } from './react.js'

/**
 * Configuration for paginated queries (traditional page-based navigation)
 */
export interface UsePaginatedFindConfig<TItem, TQuery, TMeta> {
  /** Query parameters for filtering/sorting */
  query?: TQuery
  /** Page size (required) */
  limit: number
  /** Starting page (1-indexed, default: 1) */
  initialPage?: number
  /** Skip fetching entirely */
  skip?: boolean
  /** Realtime strategy: 'merge' updates current page, 'refetch' refetches current page, 'disabled' ignores events */
  realtime?: 'merge' | 'refetch' | 'disabled'
  /** Custom matcher for realtime events (default: built from query using adapter.matcher/sift) */
  matcher?: (query: TQuery | undefined) => (item: TItem) => boolean
  /** Custom function to extract total count from meta */
  getTotal?: (meta: TMeta) => number
}

/**
 * Result type for paginated queries
 */
export interface UsePaginatedFindResult<TItem, TMeta> {
  /** Current status of the query */
  status: 'loading' | 'success' | 'error'
  /** Data for the current page */
  data: TItem[]
  /** Metadata from the current page */
  meta: TMeta
  /** Whether any fetch is in progress */
  isFetching: boolean
  /** Error from fetch */
  error: Error | null

  /** Current page number (1-indexed) */
  page: number
  /** Total number of pages */
  totalPages: number
  /** Whether there is a next page */
  hasNextPage: boolean
  /** Whether there is a previous page */
  hasPrevPage: boolean

  /** Navigate to a specific page (1-indexed) */
  setPage: (page: number) => void
  /** Navigate to the next page */
  nextPage: () => void
  /** Navigate to the previous page */
  prevPage: () => void
  /** Refetch the current page */
  refetch: () => void
}

// State shape for the reducer
interface PaginatedState<TItem, TMeta> {
  status: 'loading' | 'success' | 'error'
  data: TItem[]
  meta: TMeta
  isFetching: boolean
  error: Error | null
  page: number
  total: number
}

// Action types
type PaginatedAction<TItem, TMeta> =
  | { type: 'FETCH_START' }
  | { type: 'FETCH_SUCCESS'; data: TItem[]; meta: TMeta; total: number }
  | { type: 'FETCH_ERROR'; error: Error }
  | { type: 'SET_PAGE'; page: number }
  | { type: 'RESET_PAGE' }
  | { type: 'REALTIME_UPDATE'; data: TItem[] }

function createReducer<TItem, TMeta>(emptyMeta: TMeta, initialPage: number) {
  return function reducer(
    state: PaginatedState<TItem, TMeta>,
    action: PaginatedAction<TItem, TMeta>,
  ): PaginatedState<TItem, TMeta> {
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
          error: null,
          page: state.page,
          total: action.total,
        }
      case 'FETCH_ERROR':
        return {
          ...state,
          status: 'error',
          isFetching: false,
          error: action.error,
        }
      case 'SET_PAGE':
        return {
          ...state,
          page: action.page,
          isFetching: true,
          error: null,
        }
      case 'RESET_PAGE':
        return {
          status: 'loading',
          data: [],
          meta: emptyMeta,
          isFetching: true,
          error: null,
          page: initialPage,
          total: 0,
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
 * Hook for traditional page-based pagination with caching, smooth transitions, and realtime updates.
 *
 * Each page is cached separately, making back-navigation instant.
 * Previous page data is kept visible during page transitions (keepPreviousData behavior).
 *
 * @example
 * ```tsx
 * const { data, page, totalPages, setPage, nextPage, prevPage } = usePaginatedFind(
 *   'api/documents',
 *   { query: { $sort: { createdAt: -1 } }, limit: 20 }
 * )
 * ```
 */
export function usePaginatedFind<
  TItem,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TQuery = Record<string, unknown>,
>(
  serviceName: string,
  config: UsePaginatedFindConfig<TItem, TQuery, TMeta>,
): UsePaginatedFindResult<TItem, TMeta> {
  const figbird = useFigbird()
  const adapter = figbird.adapter as Adapter<unknown, TMeta, TQuery & Record<string, unknown>>

  const {
    query,
    limit,
    initialPage = 1,
    skip = false,
    realtime = 'merge',
    matcher: customMatcher,
    getTotal: customGetTotal,
  } = config

  // Default getTotal: extract from meta.total
  const getTotal = customGetTotal ?? ((meta: TMeta) => (meta as { total?: number }).total ?? 0)

  const emptyMeta = useMemo(() => adapter.emptyMeta(), [adapter])
  const reducer = useMemo(
    () => createReducer<TItem, TMeta>(emptyMeta, initialPage),
    [emptyMeta, initialPage],
  )

  const [state, dispatch] = useReducer(reducer, {
    status: 'loading',
    data: [],
    meta: emptyMeta,
    isFetching: !skip,
    error: null,
    page: initialPage,
    total: 0,
  })

  // Build matcher for realtime events
  const itemMatcher = useMemo(() => {
    if (realtime !== 'merge') return () => false
    if (customMatcher) return customMatcher(query)
    return adapter.matcher(query as (TQuery & Record<string, unknown>) | undefined) as (
      item: TItem,
    ) => boolean
  }, [adapter, query, realtime, customMatcher])

  // Ref for keeping previous data during transitions
  const prevDataRef = useRef<{ data: TItem[]; meta: TMeta } | null>(null)

  // Track query changes to reset to page 1
  const queryKey = JSON.stringify(query)
  const prevQueryKeyRef = useRef(queryKey)

  // Refs to access latest values in callbacks
  const stateRef = useRef(state)
  stateRef.current = state

  const configRef = useRef({ query, limit, getTotal })
  configRef.current = { query, limit, getTotal }

  // Fetch function
  const fetchPage = useCallback(
    async (pageNum: number) => {
      const { query: currentQuery, limit: currentLimit, getTotal: gt } = configRef.current

      const $skip = (pageNum - 1) * currentLimit
      const params: Record<string, unknown> = {
        query: {
          ...currentQuery,
          $skip,
          $limit: currentLimit,
        },
      }

      try {
        const result = await adapter.find(serviceName, params)
        const data = result.data as TItem[]
        const meta = result.meta as TMeta
        const total = gt(meta)

        dispatch({
          type: 'FETCH_SUCCESS',
          data,
          meta,
          total,
        })

        return { data, meta, total }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        dispatch({ type: 'FETCH_ERROR', error })
        return null
      }
    },
    [adapter, serviceName],
  )

  // Reset to page 1 when query changes
  useEffect(() => {
    if (prevQueryKeyRef.current !== queryKey) {
      prevQueryKeyRef.current = queryKey
      prevDataRef.current = null
      dispatch({ type: 'RESET_PAGE' })
    }
  }, [queryKey])

  // Fetch effect - triggers when page or query changes
  useEffect(() => {
    if (skip) return

    let cancelled = false

    async function doFetch() {
      dispatch({ type: 'FETCH_START' })
      const result = await fetchPage(state.page)
      if (cancelled || !result) return
    }

    doFetch()

    return () => {
      cancelled = true
    }
  }, [skip, fetchPage, state.page, queryKey])

  // Store successful results for smooth transitions
  useEffect(() => {
    if (state.status === 'success' && state.data) {
      prevDataRef.current = { data: state.data, meta: state.meta }
    }
  }, [state.status, state.data, state.meta])

  // Calculate pagination info
  const totalPages = Math.max(1, Math.ceil(state.total / limit))
  const hasNextPage = state.page < totalPages
  const hasPrevPage = state.page > 1

  // Navigation functions
  const setPage = useCallback(
    (newPage: number) => {
      const currentTotal = stateRef.current.total
      const currentTotalPages = Math.max(1, Math.ceil(currentTotal / limit))
      const clamped = Math.max(1, Math.min(newPage, currentTotalPages))
      if (clamped !== stateRef.current.page) {
        dispatch({ type: 'SET_PAGE', page: clamped })
      }
    },
    [limit],
  )

  const nextPage = useCallback(() => {
    const currentState = stateRef.current
    const currentTotalPages = Math.max(1, Math.ceil(currentState.total / limit))
    if (currentState.page < currentTotalPages) {
      dispatch({ type: 'SET_PAGE', page: currentState.page + 1 })
    }
  }, [limit])

  const prevPage = useCallback(() => {
    const currentState = stateRef.current
    if (currentState.page > 1) {
      dispatch({ type: 'SET_PAGE', page: currentState.page - 1 })
    }
  }, [])

  const refetch = useCallback(() => {
    dispatch({ type: 'FETCH_START' })
    fetchPage(stateRef.current.page)
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

        // For created events in merge mode, refetch to get accurate page data
        // (since insertion position depends on sorting and may affect pagination)
        refetch()
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
          // Item no longer matches - refetch to get replacement item
          refetch()
        } else if (existingIndex >= 0 && matches) {
          // Update in place
          const newData = [...currentData]
          newData[existingIndex] = typedItem
          dispatch({ type: 'REALTIME_UPDATE', data: newData })
        }
        // If item matches but wasn't in our page, we don't add it
        // (it may belong on a different page)
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
        const existingIndex = currentData.findIndex(d => getId(d) === itemId)

        if (existingIndex >= 0) {
          // Item was on our page - refetch to get replacement item
          refetch()
        }
      },
    }

    const unsubscribe = adapter.subscribe(serviceName, handlers)
    return unsubscribe
  }, [serviceName, skip, realtime, adapter, itemMatcher, refetch])

  // Use previous data during loading for smooth transitions
  const displayData =
    state.isFetching && state.status !== 'loading' && prevDataRef.current
      ? prevDataRef.current.data
      : state.data
  const displayMeta =
    state.isFetching && state.status !== 'loading' && prevDataRef.current
      ? prevDataRef.current.meta
      : state.meta

  return useMemo(
    () => ({
      status: state.status,
      data: displayData,
      meta: displayMeta,
      isFetching: state.isFetching,
      error: state.error,
      page: state.page,
      totalPages,
      hasNextPage,
      hasPrevPage,
      setPage,
      nextPage,
      prevPage,
      refetch,
    }),
    [
      state.status,
      displayData,
      displayMeta,
      state.isFetching,
      state.error,
      state.page,
      totalPages,
      hasNextPage,
      hasPrevPage,
      setPage,
      nextPage,
      prevPage,
      refetch,
    ],
  )
}
