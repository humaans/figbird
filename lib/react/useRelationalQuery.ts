/**
 * Hook for executing relational queries with the query builder
 *
 * @example
 * ```tsx
 * function IssueView({ issueId }: { issueId: number }) {
 *   const issue = useRelationalQuery(
 *     figbird.q.issues
 *       .where({ id: issueId })
 *       .one()
 *       .related('comments')
 *       .related('creator')
 *   )
 *
 *   if (issue.status === 'loading') return <Loading />
 *   if (issue.status === 'error') return <Error error={issue.error} />
 *
 *   return <IssueDetails issue={issue.data} />
 * }
 * ```
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { QueryBuilder, QueryBuilderKind, QueryBuilderResult } from '../core/query-builder.js'
import {
  isQueryDefinition,
  type QueryDefinition,
  type RelationalPaginationState,
  type RelationalQueryState,
} from '../core/figbird.js'
import { useFigbird } from './react.js'

/**
 * State for the relational query hook
 */
export type RelationalQueryResult<T> =
  | {
      status: 'idle' | 'loading'
      data: null
      error: null
      isFetching: boolean
      refetch: () => void
    }
  | {
      status: 'success'
      data: T
      error: null
      isFetching: boolean
      refetch: () => void
    }
  | {
      status: 'error'
      data: null
      error: Error
      isFetching: boolean
      refetch: () => void
    }

/**
 * Options for the relational query hook
 */
export interface UseRelationalQueryOptions {
  /**
   * Skip the query (don't fetch data)
   */
  skip?: boolean
}

// Default idle state for skipped queries
const idleState: RelationalQueryState<null> = {
  status: 'idle',
  data: null,
  error: null,
  isFetching: false,
}

/**
 * Hook for executing relational queries built with the query builder.
 *
 * Uses `figbird.relationalQuery()` internally to create a `RelationalQueryRef`
 * that manages sub-queries and caches entities in the QueryStore.
 *
 * The query is recreated each render, but the hook uses AST hash for change detection.
 * This enables inline queries without a deps array:
 *
 * ```tsx
 * useRelationalQuery(figbird.q.issues.where({ projectId }))
 * ```
 *
 * @param query - A QueryBuilder instance created via figbird.q
 * @param options - Optional configuration
 */
export function useRelationalQuery<
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  B extends QueryBuilder<any, any, any, any, any, any>,
>(query: B, options: UseRelationalQueryOptions = {}): RelationalQueryResult<QueryBuilderResult<B>> {
  type T = QueryBuilderResult<B>
  const { skip = false } = options
  const figbird = useFigbird()

  // Create RelationalQueryRef on every render, but useMemo keeps the old one if hash matches
  // This pattern avoids depending on the query object (which is new each render)
  // while still allowing the QueryBuilder's AST to drive memoization
  const _qRef = skip ? null : figbird.relationalQuery(query)
  const qRef = useMemo(() => _qRef, [_qRef?.hash() ?? '', skip, figbird])

  // Subscribe function for useSyncExternalStore
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!qRef) return () => {}
      return qRef.subscribe(onStoreChange)
    },
    [qRef],
  )

  // Get snapshot function for useSyncExternalStore
  const getSnapshot = useCallback((): RelationalQueryState<T> => {
    if (!qRef) return idleState as RelationalQueryState<T>
    return qRef.getSnapshot()
  }, [qRef])

  // Use useSyncExternalStore for efficient subscription
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  // Build the result object with refetch function
  return useMemo((): RelationalQueryResult<T> => {
    const refetch = () => qRef?.refetch()

    if (state.status === 'success') {
      return {
        status: 'success',
        data: state.data,
        error: null,
        isFetching: state.isFetching,
        refetch,
      }
    } else if (state.status === 'error') {
      return {
        status: 'error',
        data: null,
        error: state.error,
        isFetching: state.isFetching,
        refetch,
      }
    } else {
      return {
        status: state.status,
        data: null,
        error: null,
        isFetching: state.isFetching,
        refetch,
      }
    }
  }, [state, qRef])
}

/**
 * Result shape for `useQuery`. Data is guaranteed to belong to the exact query key the
 * caller passed in: the hook suspends on cold reads (throwing a Promise for the nearest
 * Suspense boundary) and throws errors to the nearest ErrorBoundary. There is no
 * "previous data" — params changes re-suspend.
 *
 * To keep the old UI committed across a param change, wrap the state update that drives
 * the new key in `startTransition`. React will hold the previous render visible while
 * the new data resolves; `useTransition`'s `isPending` is the right signal for "the user
 * asked for new data and we're catching up". `isFetching` here is purely about an
 * in-flight fetch on the current key (e.g. SWR background revalidation).
 *
 * ```tsx
 * const [isPending, startTransition] = useTransition()
 * const showSpinner = useDelayedFlag(isPending, 400)
 * ```
 *
 * For paginated builders (`.paginate({ pageSize })`), the result widens to include
 * `loadMore`, `hasMore`, `isLoadingMore`, `loadMoreError`, and (if `returnTotal: true`
 * was set) `totalCount`. The pagination shape is selected by the second type
 * parameter, which the hook infers from the builder's `TKind`.
 */
export type SuspenseQueryResult<
  T,
  TKind extends 'find' | 'get' | 'paginate' = 'find',
> = TKind extends 'paginate'
  ? {
      data: T
      error: Error | null
      isFetching: boolean
      refetch: () => void
      loadMore: () => void
      hasMore: boolean
      isLoadingMore: boolean
      loadMoreError: Error | null
      totalCount: number | undefined
    }
  : {
      data: T
      error: Error | null
      isFetching: boolean
      refetch: () => void
    }

/**
 * Options for `useQuery`.
 */
export interface UseQueryOptions {
  /**
   * Skip the query entirely. Returns a result with `data: undefined` (typed as `T`) — the
   * caller is responsible for not reading it. Use this only for conditional fetching where
   * the consuming code is gated behind the same condition.
   */
  skip?: boolean
}

/**
 * Suspense-native query hook for relational queries.
 *
 * ```tsx
 * function IssueDetail({ id }: { id: number }) {
 *   const { data } = useQuery(figbird.q.issues.where({ id }).one().related('comments'))
 *   return <div>{data.title} ({data.comments.length})</div>
 * }
 * ```
 *
 * Cold reads suspend, errors throw, and param changes re-suspend. To preserve the old UI
 * across a param change, wrap the param state update in `startTransition` — React keeps
 * the previous render committed while the new data resolves.
 */
// Overload: builder
export function useQuery<
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  B extends QueryBuilder<any, any, any, any, any, any>,
>(
  query: B,
  options?: UseQueryOptions,
): SuspenseQueryResult<QueryBuilderResult<B>, QueryBuilderKind<B>>
// Overload: definition + args
export function useQuery<
  Args,
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  B extends QueryBuilder<any, any, any, any, any, any>,
>(
  definition: QueryDefinition<Args, B>,
  args: Args,
  options?: UseQueryOptions,
): SuspenseQueryResult<QueryBuilderResult<B>, QueryBuilderKind<B>>
// Implementation
export function useQuery(
  queryOrDefinition: unknown,
  argsOrOptions?: unknown,
  maybeOptions?: UseQueryOptions,
): unknown {
  if (isQueryDefinition(queryOrDefinition)) {
    const definition = queryOrDefinition
    const rawArgs = argsOrOptions
    const options = maybeOptions ?? {}
    const validatedArgs = definition.validate(rawArgs)
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const builder = definition.build(validatedArgs as any) as QueryBuilder<
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
      any,
      any,
      any,
      any,
      any,
      any
    >
    return useQueryForBuilder(builder, options)
  }
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  const builder = queryOrDefinition as QueryBuilder<any, any, any, any, any, any>
  const options = (argsOrOptions as UseQueryOptions | undefined) ?? {}
  return useQueryForBuilder(builder, options)
}

const idlePagination: RelationalPaginationState = {
  hasMore: false,
  isLoadingMore: false,
  loadMoreError: null,
  totalCount: undefined,
}

function useQueryForBuilder<
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  B extends QueryBuilder<any, any, any, any, any, any>,
>(
  query: B,
  options: UseQueryOptions,
): SuspenseQueryResult<QueryBuilderResult<B>, QueryBuilderKind<B>> {
  type T = QueryBuilderResult<B>
  const { skip = false } = options
  const figbird = useFigbird()

  const _qRef = skip ? null : figbird.relationalQuery(query)
  const qRef = useMemo(() => _qRef, [_qRef?.hash() ?? '', skip, figbird])

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!qRef) return () => {}
      return qRef.subscribe(onStoreChange)
    },
    [qRef],
  )

  const getSnapshot = useCallback((): RelationalQueryState<T> => {
    if (!qRef) return idleState as RelationalQueryState<T>
    return qRef.getSnapshot()
  }, [qRef])

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const refetch = useCallback(() => qRef?.refetch(), [qRef])
  const loadMore = useCallback(() => qRef?.loadMore(), [qRef])

  const isPaginated = query.toAST().kind === 'paginate'

  if (skip || !qRef) {
    if (isPaginated) {
      return {
        data: undefined as unknown as T,
        error: null,
        isFetching: false,
        refetch,
        loadMore,
        hasMore: false,
        isLoadingMore: false,
        loadMoreError: null,
        totalCount: undefined,
      } as SuspenseQueryResult<T, QueryBuilderKind<B>>
    }
    return {
      data: undefined as unknown as T,
      error: null,
      isFetching: false,
      refetch,
    } as SuspenseQueryResult<T, QueryBuilderKind<B>>
  }

  if (state.status === 'error') {
    throw state.error
  }
  if (state.status !== 'success') {
    throw qRef.suspensePromise()
  }

  if (isPaginated) {
    const pagination = state.pagination ?? idlePagination
    return {
      data: state.data,
      error: null,
      isFetching: state.isFetching,
      refetch,
      loadMore,
      hasMore: pagination.hasMore,
      isLoadingMore: pagination.isLoadingMore,
      loadMoreError: pagination.loadMoreError,
      totalCount: pagination.totalCount,
    } as SuspenseQueryResult<T, QueryBuilderKind<B>>
  }

  return {
    data: state.data,
    error: null,
    isFetching: state.isFetching,
    refetch,
  } as SuspenseQueryResult<T, QueryBuilderKind<B>>
}
