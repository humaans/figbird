/**
 * useQueries — suspend on several independent queries in parallel.
 *
 * A single component calling `useQuery` more than once fetches sequentially under
 * Suspense: the first call throws its promise before the second ever runs, so N
 * queries cost N round-trips. `useQueries` starts every fetch first and throws one
 * combined promise — one suspension for the whole set:
 *
 * @example
 * ```tsx
 * function Dashboard() {
 *   const [people, announcements] = useQueries([
 *     q.people.find(),
 *     q.announcements.orderBy('createdAt', 'desc').limit(5),
 *   ])
 *   return <Overview people={people} announcements={announcements} />
 * }
 * ```
 *
 * Suspense-only by design. Multiple `{ suspense: false }` `useQueryResult` calls
 * already run in parallel, so compose those for the tagged-union style.
 * Reach for `useQueries` when one boundary needs several *unrelated* roots; when
 * the data is connected, prefer a single builder with `.related()`.
 */

import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import type { RelationalQueryState } from '../core/figbird.js'
import type { QueryInput, QueryInputBuilder } from '../core/queryDefinition.js'
import { suspensePromiseAll } from '../core/relationalQuery.js'
import type { AnyQueryBuilder, QueryBuilderKind, QueryBuilderResult } from '../core/queryBuilder.js'
import type { Schema } from '../core/schema.js'
import { useFigbird } from './context.js'
import { projectSuspenseResult, type FigbirdLike, type SuspenseQueryResult } from './useQuery.js'

/**
 * Options for `useQueries`.
 */
export interface UseQueriesOptions {
  /**
   * Freshness tolerance in ms, shared by every query in the set
   * (see `UseQueryOptions.staleTime`).
   */
  staleTime?: number
}

/** A heterogeneous tuple erases each request's args while retaining its builder. */
type SchemaQueryInput<S extends Schema> = QueryInput<AnyQueryBuilder<S>>

/**
 * The `useQueries` call surface — declared once and shared by the root export
 * (schema-agnostic) and the `createHooks` kit (bound to a schema), like `UseQueryHook`.
 *
 * `useQueries` maps each input to its data. Cold reads suspend together and cold errors
 * throw to the ErrorBoundary.
 */
// The unbound root hook accepts builders from every schema. `any` is required here
// because QueryBuilder is intentionally invariant in its schema parameter.
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export interface UseQueriesHook<S extends Schema = any> {
  <Queries extends readonly SchemaQueryInput<S>[]>(
    queries: readonly [...Queries],
    options?: UseQueriesOptions,
  ): {
    [K in keyof Queries]: QueryBuilderResult<QueryInputBuilder<Queries[K]>>
  }
}

/** Metadata-bearing counterpart to `UseQueriesHook`. */
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export interface UseQueryResultsHook<S extends Schema = any> {
  <Queries extends readonly SchemaQueryInput<S>[]>(
    queries: readonly [...Queries],
    options?: UseQueriesOptions,
  ): {
    [K in keyof Queries]: SuspenseQueryResult<
      QueryBuilderResult<QueryInputBuilder<Queries[K]>>,
      QueryBuilderKind<QueryInputBuilder<Queries[K]>>
    >
  }
}

/**
 * Suspense-native hook for fetching several independent queries in parallel.
 *
 * ```tsx
 * const [person, settings] = useQueries([q.people.get(id), q.settings.get(orgId)])
 * ```
 *
 * All cold queries suspend together; the boundary resolves when the whole set has
 * data. See `UseQueriesHook` for the per-element contract.
 */
export const useQueries: UseQueriesHook = ((
  queries: readonly SchemaQueryInput<Schema>[],
  options?: UseQueriesOptions,
): unknown => useQueriesImpl(useFigbird(), queries, options)) as UseQueriesHook

/** Suspense-native parallel query hook that retains each query's result object. */
export const useQueryResults: UseQueryResultsHook = ((
  queries: readonly SchemaQueryInput<Schema>[],
  options?: UseQueriesOptions,
): unknown => useQueryResultsImpl(useFigbird(), queries, options)) as UseQueryResultsHook

/**
 * Instance-taking implementation behind the context-bound `useQueries`. @internal
 */
export function useQueriesImpl(
  figbird: FigbirdLike,
  queries: readonly SchemaQueryInput<Schema>[],
  options: UseQueriesOptions = {},
): unknown {
  const results = useQueryResultsImpl(figbird, queries, options)
  return useMemo(() => results.map(result => result.data), [results])
}

/** Instance-taking implementation behind `useQueryResults`. @internal */
export function useQueryResultsImpl(
  figbird: FigbirdLike,
  queries: readonly SchemaQueryInput<Schema>[],
  options: UseQueriesOptions = {},
): SuspenseQueryResult<unknown>[] {
  const { staleTime } = options

  // figbird.query() interns refs by AST hash, so each element is reference-stable
  // across renders while retained (same reasoning as useQueryRef — no memoization
  // of the lookup itself). The array literal is rebuilt every render though, so pin
  // its identity element-wise: the subscription and snapshot cache key off actual
  // ref changes, and an evicted-then-re-interned ref is a new instance that
  // correctly busts the pin.
  const refs = useStableArray(queries.map(query => figbird.query(query)))

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const unsubs = refs.map(ref => ref.subscribe(onStoreChange, { staleTime }))
      return () => {
        for (const unsub of unsubs) unsub()
      }
    },
    [refs, staleTime],
  )
  // useSyncExternalStore needs a stable snapshot value: rebuild the combined array
  // only when some element's state changed (element states are identity-cached by
  // RelationalQueryRef, so reference comparison is exact).
  const snapshotCache = useRef<RelationalQueryState<unknown>[]>([])
  const getSnapshot = useCallback((): RelationalQueryState<unknown>[] => {
    const prev = snapshotCache.current
    const next = refs.map(ref => ref.getSnapshot())
    if (prev.length === next.length && next.every((state, i) => state === prev[i])) {
      return prev
    }
    snapshotCache.current = next
    return next
  }, [refs])

  const states = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  // Projected unconditionally so the hook order is identical across suspensions,
  // through the same projection as the single hook (a `.paginate()` element widens
  // with the loadMore family). Keyed on the pinned refs + identity-cached states,
  // so this only recomputes when an element's state actually changed.
  const results = useMemo(
    () =>
      states.map((state, i) => {
        const ref = refs[i]!
        return projectSuspenseResult(
          state,
          ref.kind() === 'paginate',
          () => ref.refetch(),
          () => ref.loadMore(),
        )
      }),
    [states, refs],
  )

  // Cold errors throw to the ErrorBoundary — the first one, matching useQuery's
  // "cold failure unmounts to the boundary" contract even while siblings are still
  // in flight. Every errored ref is released (not just the thrown one) so a
  // boundary retry cold-starts the errored queries instead of instantly re-throwing.
  let firstError: Error | null = null
  for (const [i, state] of states.entries()) {
    if (state.status === 'error') {
      refs[i]?.releaseColdStart()
      firstError ??= state.error
    }
  }
  if (firstError) throw firstError

  // suspensePromiseAll materializes each pending query's root, so the whole set
  // starts fetching before the throw — that parallelism is the point of this hook.
  // The failure-release choreography lives in core, next to the cleanup contract
  // it depends on.
  const pending = refs.filter((_, i) => states[i]?.status !== 'success')
  if (pending.length > 0) {
    throw suspensePromiseAll(pending)
  }

  return results
}

/**
 * Pin an array's identity while its elements stay reference-equal, so callbacks and
 * memos keyed on it don't churn when only the array literal is new. Written during
 * render — the same pattern as a getSnapshot cache: idempotent for equal inputs, and
 * the committed render's value wins.
 */
function useStableArray<T>(next: T[]): T[] {
  const pinned = useRef(next)
  if (
    pinned.current !== next &&
    (pinned.current.length !== next.length || next.some((value, i) => value !== pinned.current[i]))
  ) {
    pinned.current = next
  }
  return pinned.current
}
