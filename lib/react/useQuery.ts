/**
 * useQuery — the query hook for relational builders and definitions.
 *
 * Suspense-native by default; pass `{ suspense: false }` for an explicit
 * tagged-union result:
 *
 * @example
 * ```tsx
 * function IssueView({ issueId }: { issueId: number }) {
 *   const issue = useQuery(
 *     figbird.q.issues.get(issueId).related('comments'),
 *     { suspense: false },
 *   )
 *
 *   if (issue.status === 'loading') return <Loading />
 *   if (issue.status === 'error') return <Error error={issue.error} />
 *   return <IssueDetails issue={issue.data} />
 * }
 * ```
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { AnyQueryBuilder, QueryBuilderKind, QueryBuilderResult } from '../core/queryBuilder.js'
import {
  isQueryDefinition,
  splitDefinitionRest,
  type ArgsAndOptions,
  type ArgsAndRequiredOptions,
  type QueryDefinition,
  type RelationalPaginationState,
  type RelationalQueryState,
} from '../core/figbird.js'
import type { Schema } from '../core/schema.js'
import { useFigbird } from './context.js'

/**
 * State for the relational query hook.
 *
 * `error` on the success arm is non-null when the most recent refetch failed while
 * previous data is still being served — show a toast/banner, keep the screen. The
 * `error` status only occurs for cold failures (no data was ever produced).
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
      error: Error | null
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

/** The slice of a Figbird instance the query hooks need. @internal */
export interface FigbirdLike {
  query(builder: AnyQueryBuilder): {
    subscribe(
      fn: (state: unknown) => void,
      options?: { staleTime?: number | undefined },
    ): () => void
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    getSnapshot(): any
    refetch(): void
    loadMore(): void
    suspensePromise(): Promise<void>
    coldErrorDelivered(): void
    hash(): string
  }
}

// Default idle state for skipped queries
const idleState: RelationalQueryState<null> = {
  status: 'idle',
  data: null,
  error: null,
  isFetching: false,
}

/**
 * Shared subscription skeleton for both hook variants: resolve the interned
 * RelationalQueryRef for a builder and read its state via useSyncExternalStore.
 *
 * `figbird.query()` interns refs by AST hash, so the same builder shape
 * yields a reference-stable qRef across renders while subscribed — no memoization
 * here. (If the ref was evicted between renders, this picks up the freshly interned
 * instance instead of pinning the stale one.)
 */
function useQueryRef<B extends AnyQueryBuilder>(
  figbird: FigbirdLike,
  query: B,
  skip: boolean,
  staleTime?: number,
) {
  type T = QueryBuilderResult<B>
  const qRef = skip ? null : figbird.query(query)

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!qRef) return () => {}
      return qRef.subscribe(onStoreChange, { staleTime })
    },
    [qRef, staleTime],
  )

  const getSnapshot = useCallback((): RelationalQueryState<T> => {
    if (!qRef) return idleState as RelationalQueryState<T>
    return qRef.getSnapshot()
  }, [qRef])

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return { qRef, state }
}

/**
 * Result shape for `useQuery`. Data is guaranteed to belong to the exact query key the
 * caller passed in: the hook suspends on cold reads (throwing a Promise for the nearest
 * Suspense boundary) and throws cold errors to the nearest ErrorBoundary. There is no
 * "previous data" — params changes re-suspend.
 *
 * `error` is non-null when a *refetch* failed while previous data is still being served
 * (a background revalidation, realtime-triggered refetch, or manual `refetch()` that
 * errored). The screen stays mounted with the last good `data`; show a toast or inline
 * banner and let the next successful fetch clear it. Only a cold read with no data ever
 * produced throws to the ErrorBoundary.
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
  TKind extends 'find' | 'get' | 'paginate' | 'all' = 'find',
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
   * Skip the query entirely — nothing is fetched and `data` is `undefined` (the result
   * type widens to `T | undefined` accordingly). Use for conditional fetching where the
   * consuming code is gated behind the same condition.
   */
  skip?: boolean
  /**
   * `suspense: false` opts this call site out of Suspense: the hook never suspends or
   * throws, returning the tagged union `{ status, data, error, isFetching, refetch }`
   * instead — branch on `status` yourself. Must be static for the lifetime of the
   * call site. Defaults to `true`.
   */
  suspense?: boolean
  /**
   * Freshness tolerance in ms: if the query's data is younger than this on mount, the
   * background SWR revalidation is skipped. `0` (default) revalidates on every mount;
   * `Infinity` is cache-first. Not part of query identity — readers with different
   * tolerances share the cache entry, and the most demanding one keeps it freshest.
   */
  staleTime?: number
}

/**
 * `data` widens to `T | undefined` when the options could skip the query; without a
 * (possibly-true) `skip`, `data` stays `T`.
 */
export type SkipAware<T, O extends UseQueryOptions> = [O] extends [{ skip: false }]
  ? T
  : O extends { skip: boolean }
    ? T | undefined
    : T

/**
 * The `useQuery` call surface — builder/definition × suspense/non-suspense. Declared
 * once and shared by the root export (schema-agnostic) and the `createHooks` kit
 * (bound to a schema), so the two can never drift.
 */
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export interface UseQueryHook<S extends Schema = any> {
  // Builder, non-suspense — returns the tagged union, never throws
  <B extends AnyQueryBuilder<S>>(
    query: B,
    options: UseQueryOptions & { suspense: false },
  ): RelationalQueryResult<QueryBuilderResult<B>>
  // Definition, non-suspense — args omittable when the definition takes none
  <Args, B extends AnyQueryBuilder<S>>(
    definition: QueryDefinition<Args, B>,
    ...rest: ArgsAndRequiredOptions<Args, UseQueryOptions & { suspense: false }>
  ): RelationalQueryResult<QueryBuilderResult<B>>
  // Builder
  <B extends AnyQueryBuilder<S>, O extends UseQueryOptions = Record<string, never>>(
    query: B,
    options?: O,
  ): SuspenseQueryResult<SkipAware<QueryBuilderResult<B>, O>, QueryBuilderKind<B>>
  // Definition — args omittable when the definition takes none
  <Args, B extends AnyQueryBuilder<S>, O extends UseQueryOptions = Record<string, never>>(
    definition: QueryDefinition<Args, B>,
    ...rest: ArgsAndOptions<Args, O>
  ): SuspenseQueryResult<SkipAware<QueryBuilderResult<B>, O>, QueryBuilderKind<B>>
  // Definition, nullable args — `null` skips the query without invoking the build
  // function, so the skip condition lives in the args: `useQuery(def, id ? { id } : null)`.
  // Non-suspense variant:
  <Args, B extends AnyQueryBuilder<S>>(
    definition: QueryDefinition<Args, B>,
    args: Args | null,
    options: UseQueryOptions & { suspense: false },
  ): RelationalQueryResult<QueryBuilderResult<B>>
  // Suspense variant — data widens with `undefined` exactly like `skip`:
  <Args, B extends AnyQueryBuilder<S>, O extends UseQueryOptions = Record<string, never>>(
    definition: QueryDefinition<Args, B>,
    args: Args | null,
    options?: O,
  ): SuspenseQueryResult<QueryBuilderResult<B> | undefined, QueryBuilderKind<B>>
}

/**
 * Suspense-native query hook for relational queries.
 *
 * ```tsx
 * function IssueDetail({ id }: { id: number }) {
 *   const { data } = useQuery(figbird.q.issues.get(id).related('comments'))
 *   return <div>{data.title} ({data.comments.length})</div>
 * }
 * ```
 *
 * Cold reads suspend, errors throw, and param changes re-suspend. To preserve the old UI
 * across a param change, wrap the param state update in `startTransition` — React keeps
 * the previous render committed while the new data resolves.
 */
export const useQuery: UseQueryHook = ((
  queryOrDefinition: unknown,
  argsOrOptions?: unknown,
  maybeOptions?: UseQueryOptions,
): unknown =>
  useQueryImpl(
    useFigbird() as FigbirdLike,
    queryOrDefinition,
    argsOrOptions,
    maybeOptions,
  )) as UseQueryHook

/**
 * Instance-taking dispatch shared by the context-bound `useQuery` and the
 * bound-instance hooks that `createHooks` produces. @internal
 */
export function useQueryImpl(
  figbird: FigbirdLike,
  queryOrDefinition: unknown,
  argsOrOptions?: unknown,
  maybeOptions?: UseQueryOptions,
): unknown {
  if (isQueryDefinition(queryOrDefinition)) {
    const definition = queryOrDefinition
    // Zero-arg definitions take options in the args slot (see ArgsAndOptions).
    const { args, options } = splitDefinitionRest<UseQueryOptions>(
      definition,
      argsOrOptions,
      maybeOptions,
    )
    // `null` args skip the query — the definition's build function is never invoked
    // (it may dereference its args), so the condition lives in the args themselves:
    // `useQuery(issueDetail, id ? { id } : null)`. Routed through the same code path
    // as `skip: true` so the hook sequence is identical when args flip null <-> real.
    if (args === null) {
      return useQueryForBuilder(figbird, SKIPPED_BUILDER, { ...options, skip: true })
    }
    const validatedArgs = definition.validate(args)
    const builder = definition.build(validatedArgs) as AnyQueryBuilder
    return useQueryForBuilder(figbird, builder, options ?? {})
  }
  const builder = queryOrDefinition as AnyQueryBuilder
  const options = (argsOrOptions as UseQueryOptions | undefined) ?? {}
  return useQueryForBuilder(figbird, builder, options)
}

const idlePagination: RelationalPaginationState = {
  hasMore: false,
  isLoadingMore: false,
  loadMoreError: null,
  totalCount: undefined,
}

// Stand-in for null-args skips: the skip path never materializes a query, so only
// toAST() is consulted (for the pagination widening — which the skip branch applies
// unconditionally anyway, see below).
const SKIPPED_BUILDER = {
  toAST: () => ({ kind: 'find' }),
} as unknown as AnyQueryBuilder

function useQueryForBuilder<B extends AnyQueryBuilder>(
  figbird: FigbirdLike,
  query: B,
  options: UseQueryOptions,
): unknown {
  type T = QueryBuilderResult<B>
  const { skip = false, suspense = true, staleTime } = options
  const { qRef, state } = useQueryRef(figbird, query, skip, staleTime)
  const refetch = useCallback(() => qRef?.refetch(), [qRef])
  const loadMore = useCallback(() => qRef?.loadMore(), [qRef])

  // The tagged-union projection is memoized unconditionally so the hook order is
  // identical in both suspense modes (the option must still be static per call site).
  const taggedResult = useMemo((): RelationalQueryResult<T> => {
    if (state.status === 'success') {
      return {
        status: 'success',
        data: state.data,
        error: state.error,
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
    }
    return {
      status: state.status,
      data: null,
      error: null,
      isFetching: state.isFetching,
      refetch,
    }
  }, [state, refetch])

  if (!suspense) return taggedResult

  // Two axes only: where data comes from (skipped vs live) and whether the builder
  // is paginated (widening the shape with the loadMore family).
  const isPaginated = query.toAST().kind === 'paginate'
  const widen = (base: object, pagination: RelationalPaginationState) =>
    (isPaginated ? { ...base, loadMore, ...pagination } : base) as SuspenseQueryResult<
      T,
      QueryBuilderKind<B>
    >

  if (skip || !qRef) {
    // Always the widened shape: a null-args skip can't know the definition's kind
    // (build never ran), and inert pagination fields on a non-paginated result are
    // hidden by the static type.
    return {
      data: undefined as unknown as T,
      error: null,
      isFetching: false,
      refetch,
      loadMore,
      ...idlePagination,
    } as SuspenseQueryResult<T, QueryBuilderKind<B>>
  }

  // `status: 'error'` only occurs for cold failures (no data was ever produced) —
  // a refetch failure with data present stays on the success arm with `error` set.
  if (state.status === 'error') {
    // Deferred self-eviction: nothing committed, so nothing will ever unsubscribe
    // this ref — releasing it here is what makes an error-boundary retry cold-start
    // a fresh query instead of instantly re-throwing the same settled error.
    qRef.coldErrorDelivered()
    throw state.error
  }
  if (state.status !== 'success') {
    throw qRef.suspensePromise()
  }

  return widen(
    { data: state.data, error: state.error, isFetching: state.isFetching, refetch },
    state.pagination ?? idlePagination,
  )
}
