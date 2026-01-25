import { useCallback, useMemo, useRef, useState } from 'react'
import type { Figbird } from '../core/figbird.js'
import type { AnySchema } from '../core/schema.js'
import type { QueryResult } from './useQuery.js'
import { useFigbird } from './react.js'

/**
 * Configuration for paginated queries (traditional page-based navigation)
 */
export interface UsePaginatedFindConfig<TQuery> {
  /** Query parameters for filtering/sorting */
  query?: TQuery
  /** Page size (required) */
  limit: number
  /** Starting page (1-indexed, default: 1) */
  initialPage?: number
  /** Skip fetching entirely */
  skip?: boolean
  /** Realtime strategy: 'refetch' (default) refetches current page, 'merge' updates in place, 'disabled' ignores events */
  realtime?: 'merge' | 'refetch' | 'disabled'
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
  /** Total number of pages (-1 for cursor mode where total is unknown) */
  totalPages: number
  /** Whether there is a next page */
  hasNextPage: boolean
  /** Whether there is a previous page */
  hasPrevPage: boolean

  /** Navigate to a specific page (1-indexed). In cursor mode, silently ignores non-sequential jumps. */
  setPage: (page: number) => void
  /** Navigate to the next page */
  nextPage: () => void
  /** Navigate to the previous page */
  prevPage: () => void
  /** Refetch the current page */
  refetch: () => void
}

/**
 * Keep previous data during loading transitions
 */
function usePreviousData<T>(data: T, keepPrevious: boolean): T {
  const ref = useRef(data)
  if (!keepPrevious && data != null) {
    ref.current = data
  }
  return ref.current
}

/**
 * Create a paginated find hook from a base useFind hook.
 * This is a thin wrapper that adds page state management on top of useFind.
 * Supports both offset pagination (traditional) and cursor pagination (sequential navigation only).
 *
 * @param useFind - The base useFind hook (typed or untyped)
 * @returns A usePaginatedFind hook
 */
export function createUsePaginatedFind<
  TItem,
  TMeta extends Record<string, unknown>,
  TQuery,
  TParams extends Record<string, unknown>,
>(
  useFind: (serviceName: string, params?: TParams) => QueryResult<TItem[], TMeta>,
): (
  serviceName: string,
  config: UsePaginatedFindConfig<TQuery> & Omit<TParams, 'query'>,
) => UsePaginatedFindResult<TItem, TMeta> {
  return function usePaginatedFind(
    serviceName: string,
    config: UsePaginatedFindConfig<TQuery> & Omit<TParams, 'query'>,
  ): UsePaginatedFindResult<TItem, TMeta> {
    const figbird = useFigbird() as Figbird<AnySchema>
    const {
      query,
      limit,
      initialPage = 1,
      skip = false,
      realtime = 'refetch',
      ...restParams
    } = config

    // Page index for cursor mode (0-indexed internally)
    const [pageIndex, setPageIndex] = useState(initialPage - 1)
    // Cursor history for navigating backwards in cursor mode
    // cursorHistory[0] = null (first page), cursorHistory[1] = cursor for page 2, etc.
    const [cursorHistory, setCursorHistory] = useState<(string | null)[]>([null])

    // Track if we've detected cursor mode
    const [isCursorMode, setIsCursorMode] = useState<boolean | null>(null)

    // Reset to page 1 when query changes
    const queryKey = JSON.stringify(query)
    const prevQueryKeyRef = useRef(queryKey)
    if (prevQueryKeyRef.current !== queryKey) {
      prevQueryKeyRef.current = queryKey
      if (pageIndex !== 0) {
        setPageIndex(0)
        setCursorHistory([null])
        setIsCursorMode(null)
      }
    }

    // Create a matcher that uses only the filter query (without $skip/$limit/$cursor)
    const matcher = useMemo(() => {
      if (realtime !== 'merge') return undefined
      return (_queryWithPagination: unknown) =>
        figbird.adapter.matcher(query as Record<string, unknown> | undefined)
    }, [figbird.adapter, queryKey, realtime])

    // Determine what pagination param to use
    const currentCursor = cursorHistory[pageIndex] ?? null
    const usesCursor = isCursorMode === true || (isCursorMode === null && pageIndex > 0)

    // Build params for useFind with pagination
    const params = useMemo(
      () =>
        ({
          ...restParams,
          query: {
            ...(query as object),
            $limit: limit,
            // Use cursor if in cursor mode and we have one, otherwise use skip
            ...(usesCursor && currentCursor != null
              ? { $cursor: currentCursor }
              : { $skip: pageIndex * limit }),
          },
          skip,
          realtime,
          ...(matcher && { matcher }),
        }) as unknown as TParams,
      [
        queryKey,
        pageIndex,
        limit,
        skip,
        realtime,
        matcher,
        currentCursor,
        usesCursor,
        JSON.stringify(restParams),
      ],
    )

    const result = useFind(serviceName, params)

    // Detect pagination mode from meta response
    const meta = (result as { meta?: TMeta }).meta
    const hasEndCursor = meta && 'endCursor' in meta
    const hasTotal = meta && 'total' in meta && typeof meta.total === 'number' && meta.total >= 0

    // Once we have a response, determine if we're in cursor mode
    // Cursor mode: has endCursor OR no valid total
    const detectedCursorMode =
      result.status === 'success' ? hasEndCursor || !hasTotal : isCursorMode
    if (detectedCursorMode !== null && detectedCursorMode !== isCursorMode) {
      setIsCursorMode(detectedCursorMode)
    }

    // Get the next cursor from meta for advancing cursor history
    const nextCursor = hasEndCursor ? (meta.endCursor as string | null) : null

    // Calculate pagination values
    const total = hasTotal ? (meta.total as number) : 0
    const totalPages = detectedCursorMode ? -1 : Math.max(1, Math.ceil(total / limit))
    const page = pageIndex + 1 // 1-indexed for external API

    // Determine hasNextPage
    const hasNextPageFromAdapter = meta
      ? figbird.adapter.getHasNextPage(meta, result.data ?? [])
      : false
    const hasNextPage = detectedCursorMode ? hasNextPageFromAdapter : page < totalPages
    const hasPrevPage = pageIndex > 0

    // Keep previous data during page transitions
    const showPrevious = result.isFetching || result.status === 'loading'
    const displayData = usePreviousData(result.data ?? [], showPrevious)
    const displayMeta = usePreviousData(meta as TMeta, showPrevious)

    // Store refs for callbacks
    const totalPagesRef = useRef(totalPages)
    totalPagesRef.current = totalPages
    const hasNextPageRef = useRef(hasNextPage)
    hasNextPageRef.current = hasNextPage
    const nextCursorRef = useRef(nextCursor)
    nextCursorRef.current = nextCursor
    const isCursorModeRef = useRef(detectedCursorMode)
    isCursorModeRef.current = detectedCursorMode

    const nextPage = useCallback(() => {
      if (isCursorModeRef.current) {
        // Cursor mode: advance and store cursor
        if (hasNextPageRef.current && nextCursorRef.current !== null) {
          setCursorHistory(h => {
            const newHistory = [...h]
            // Store cursor for the next page index
            newHistory[pageIndex + 1] = nextCursorRef.current
            return newHistory
          })
          setPageIndex(i => i + 1)
        }
      } else {
        // Offset mode
        setPageIndex(i => Math.min(i + 1, totalPagesRef.current - 1))
      }
    }, [pageIndex])

    const prevPage = useCallback(() => {
      setPageIndex(i => Math.max(i - 1, 0))
    }, [])

    const setPage = useCallback(
      (newPage: number) => {
        const newIndex = newPage - 1 // Convert to 0-indexed

        if (isCursorModeRef.current) {
          // Cursor mode: only allow sequential navigation
          // Silently ignore non-sequential jumps
          if (newIndex === pageIndex + 1) {
            nextPage()
          } else if (newIndex === pageIndex - 1) {
            prevPage()
          }
          // All other values are silently ignored
          return
        }

        // Offset mode: clamp and set
        const clamped = Math.max(0, Math.min(newIndex, totalPagesRef.current - 1))
        setPageIndex(clamped)
      },
      [pageIndex, nextPage, prevPage],
    )

    return useMemo(
      () => ({
        status: result.status,
        data: displayData,
        meta: displayMeta,
        isFetching: result.isFetching,
        error: result.error,
        page,
        totalPages,
        hasNextPage,
        hasPrevPage,
        setPage,
        nextPage,
        prevPage,
        refetch: result.refetch,
      }),
      [
        result.status,
        displayData,
        displayMeta,
        result.isFetching,
        result.error,
        page,
        totalPages,
        hasNextPage,
        hasPrevPage,
        setPage,
        nextPage,
        prevPage,
        result.refetch,
      ],
    )
  }
}

/**
 * Hook for traditional page-based pagination.
 *
 * This is a thin wrapper around useFind that adds page state management.
 * Each page is fetched independently and realtime updates come free from useFind.
 * Previous page data is kept visible during page transitions for smooth UX.
 *
 * Supports both offset pagination (random access) and cursor pagination (sequential only).
 * In cursor mode:
 * - totalPages is -1 (unknown)
 * - setPage(n) silently ignores non-sequential jumps
 * - nextPage()/prevPage() work correctly using cursor history
 *
 * @example
 * ```tsx
 * const { data, page, totalPages, setPage, nextPage, prevPage } = usePaginatedFind(
 *   'api/documents',
 *   { query: { $sort: { createdAt: -1 } }, limit: 20 }
 * )
 * ```
 */
export { createUsePaginatedFind as usePaginatedFind }
