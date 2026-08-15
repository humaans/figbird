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
 *   return <Overview people={people.data} announcements={announcements.data} />
 * }
 * ```
 *
 * Suspense-only by design: `{ suspense: false }` `useQuery` calls never throw, so
 * N of them already run in parallel — compose those for the tagged-union style.
 * Reach for `useQueries` when one boundary needs several *unrelated* roots; when
 * the data is connected, prefer a single builder with `.related()`.
 */

import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import { isQueryRequest, type QueryRequest, type RelationalQueryState } from '../core/figbird.js'
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

type QueryInput<S extends Schema> =
  | AnyQueryBuilder<S>
  // A heterogeneous tuple needs to erase each request's args while retaining its builder.
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  | QueryRequest<any, AnyQueryBuilder<S>>

type QueryInputBuilder<T> =
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  T extends QueryRequest<any, infer B> ? B : T extends AnyQueryBuilder ? T : never

/**
 * The `useQueries` call surface — declared once and shared by the root export
 * (schema-agnostic) and the `createHooks` kit (bound to a schema), like `UseQueryHook`.
 *
 * Each element of the result carries the same contract as the `useQuery` suspense
 * result for that builder: cold reads suspend (all of them at once), cold errors
 * throw to the ErrorBoundary (the first one, after every errored query is released
 * for retry), and a refetch failure with data present surfaces on that element's
 * `error` while its last good `data` keeps rendering. A `.paginate()` element widens
 * exactly like single-hook pagination — its own `loadMore`/`hasMore`/... family, keyed
 * off that builder's `TKind`.
 */
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export interface UseQueriesHook<S extends Schema = any> {
  <Queries extends readonly QueryInput<S>[]>(
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
  queries: readonly QueryInput<Schema>[],
  options?: UseQueriesOptions,
): unknown => useQueriesImpl(useFigbird(), queries, options)) as UseQueriesHook

/**
 * Instance-taking implementation behind the context-bound `useQueries`. @internal
 */
export function useQueriesImpl(
  figbird: FigbirdLike,
  queries: readonly QueryInput<Schema>[],
  options: UseQueriesOptions = {},
): unknown {
  const { staleTime } = options

  // figbird.query() interns refs by AST hash, so each element is reference-stable
  // across renders while retained (same reasoning as useQueryRef — no memoization
  // of the lookup itself). The array literal is rebuilt every render though, so pin
  // its identity element-wise: the subscription and snapshot cache key off actual
  // ref changes, and an evicted-then-re-interned ref is a new instance that
  // correctly busts the pin.
  const refs = useStableArray(
    queries.map(query => (isQueryRequest(query) ? figbird.query(query) : figbird.query(query))),
  )

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
