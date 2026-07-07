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
import type { RelationalPaginationState, RelationalQueryState } from '../core/figbird.js'
import type { AnyQueryBuilder, QueryBuilderKind, QueryBuilderResult } from '../core/queryBuilder.js'
import type { Schema } from '../core/schema.js'
import { useFigbird } from './context.js'
import type { FigbirdLike, SuspenseQueryResult } from './useQuery.js'

/** Inert pagination fields for a paginated element before its first page settles. */
const idlePagination: RelationalPaginationState = {
  hasMore: false,
  isLoadingMore: false,
  loadMoreError: null,
  totalCount: undefined,
}

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
  <Bs extends readonly AnyQueryBuilder<S>[]>(
    queries: readonly [...Bs],
    options?: UseQueriesOptions,
  ): { [K in keyof Bs]: SuspenseQueryResult<QueryBuilderResult<Bs[K]>, QueryBuilderKind<Bs[K]>> }
}

/**
 * Suspense-native hook for fetching several independent queries in parallel.
 *
 * ```tsx
 * const [person, settings] = useQueries([q.people.one(id), q.settings.one(orgId)])
 * ```
 *
 * All cold queries suspend together; the boundary resolves when the whole set has
 * data. See `UseQueriesHook` for the per-element contract.
 */
export const useQueries: UseQueriesHook = ((
  queries: readonly AnyQueryBuilder[],
  options?: UseQueriesOptions,
): unknown => useQueriesImpl(useFigbird(), queries, options)) as UseQueriesHook

/**
 * Instance-taking implementation shared by the context-bound `useQueries` and the
 * bound-instance hook that `createHooks` produces. @internal
 */
export function useQueriesImpl(
  figbird: FigbirdLike,
  queries: readonly AnyQueryBuilder[],
  options: UseQueriesOptions = {},
): unknown {
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

  // Projected unconditionally so the hook order is identical across suspensions
  // (mirrors useQueryForBuilder's taggedResult + widen). A `.paginate()` element
  // widens with the loadMore family, exactly like a single useQuery; the plain
  // elements stay as-is. Rebuilt per render like the single hook's suspense
  // projection — the data inside stays reference-stable via the ref's snapshot cache.
  const results = useMemo(
    () =>
      states.map((state, i) => {
        const base = {
          data: state.data,
          error: state.error,
          isFetching: state.isFetching,
          refetch: () => refs[i]?.refetch(),
        }
        if (queries[i]?.toAST().kind !== 'paginate') return base
        return {
          ...base,
          loadMore: () => refs[i]?.loadMore(),
          ...(state.pagination ?? idlePagination),
        }
      }),
    [states, refs, queries],
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

  // suspensePromise() materializes each query's root (see RelationalQueryRef), so
  // mapping the whole pending set starts every fetch before the throw — that
  // parallelism is the point of this hook.
  const pending = refs.filter((_, i) => states[i]?.status !== 'success')
  if (pending.length > 0) {
    const started = pending.map(ref => ({ ref, promise: ref.suspensePromise() }))
    const promises = started.map(({ promise }) => promise)
    const aggregate = Promise.all(promises)
    void aggregate.catch(() => {
      void Promise.allSettled(promises).then(() => {
        setTimeout(() => {
          for (const { ref } of started) ref.releaseColdStart()
        }, 0)
      })
    })
    throw aggregate
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
