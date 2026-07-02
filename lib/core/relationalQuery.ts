import type { Adapter } from '../adapters/adapter.js'
import type { Figbird } from './figbird.js'
import { hashObject } from './hash.js'
import type { QueryAST } from './query-builder.js'
import type { QueryRef } from './queryRef.js'
import type { AnySchema, RelationshipDef, Schema } from './schema.js'
import { resolveServicePath } from './schema.js'
import { hasWindowFilters } from './queryClassification.js'
import type { QueryConfig, QueryDescriptor, QueryState } from './queryTypes.js'
import {
  collectRelationalFilterDependencies,
  collectRelationalFilterPaths,
  hasRelationalFilter,
  materializeRelationalFilterItem,
  shouldRefetchRelationalFilterQuery,
} from './relationalFilters.js'

// Above this many parents, a windowed relation's per-parent queries are almost
// certainly the wrong shape (N requests for one screen) — warn and point at embed.
const WINDOWED_RELATION_FANOUT_WARN_THRESHOLD = 10

/**
 * Pagination metadata exposed by paginated queries. Present on the snapshot only
 * when the underlying builder used `.paginate(...)`.
 */
export interface RelationalPaginationState {
  /**
   * Whether more pages are likely to exist. Sticky during a `loadMore()` so the UI
   * doesn't flicker between "more available" / "loading" / "more available".
   */
  hasMore: boolean
  /** A `loadMore()` is in-flight. */
  isLoadingMore: boolean
  /** The most recent `loadMore()` failed. Cleared on the next attempt. */
  loadMoreError: Error | null
  /** Total row count from the first page's meta, if `returnTotal: true` was set. */
  totalCount: number | undefined
}

/**
 * State for relational queries
 */
export type RelationalQueryState<T> =
  | {
      status: 'idle' | 'loading'
      data: null
      error: null
      isFetching: boolean
      pagination?: RelationalPaginationState
    }
  | {
      status: 'success'
      data: T
      error: null
      isFetching: boolean
      pagination?: RelationalPaginationState
    }
  | {
      status: 'error'
      data: null
      error: Error
      isFetching: boolean
      pagination?: RelationalPaginationState
    }

interface RelationQuerySub<
  S extends Schema,
  TParams,
  TMeta extends Record<string, unknown>,
  TQuery,
> {
  queryRef: QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery> | null
  unsub: (() => void) | null
  sourceKey: string
  junction?: {
    queryRef: QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery>
    unsub: () => void
    sourceKey: string
  }
  perParent?: Map<
    string,
    {
      queryRef: QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery>
      unsub: () => void
      sourceValue: string | number
    }
  >
}

/**
 * Reference to a relational query with nested relations.
 * Manages multiple sub-queries and assembles data on-the-fly from entity caches.
 */
export class RelationalQueryRef<
  T,
  S extends Schema = AnySchema,
  TParams = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TQuery = Record<string, unknown>,
> {
  #figbird: Figbird<S, Adapter<TParams, TMeta, TQuery>>
  #ast: QueryAST
  #schema: S
  #queryId: string
  #rootQueryRef: QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery> | null = null
  #rootUnsub: (() => void) | null = null
  // Paginated mode: each loaded page is its own `find` query in the QueryStore. Together they
  // form the accumulated `data` array. Refetching/realtime is per-page.
  #pageRefs: Array<QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery>> = []
  #pageUnsubs: Array<() => void> = []
  #isLoadingMore = false
  #loadMoreError: Error | null = null
  // Sticky `hasMore`: only flips to false when we've observed a partial page. Stays true while
  // `loadMore()` is in flight so the UI's "Load more" button doesn't disappear and reappear.
  #hasMoreSticky = true
  // Per-relation state, keyed by dotted relation path (e.g. "comments" or "comments.reactions").
  // A relation is "synced" once its entry exists here — even if no queryRef was created because
  // sourceKey was empty (so loading detection doesn't hang on empty relations).
  //
  // For two-hop `many` (junction-table relations) the entry also carries a `junction` sub
  // describing the parent → junction fetch. The `queryRef` field still holds the
  // consumer-visible (junction → dest) ref. The loading/error/cache-invalidation passes
  // walk both the dest and junction refs so realtime events on either service propagate.
  #relationSubs: Map<string, RelationQuerySub<S, TParams, TMeta, TQuery>> = new Map()
  #listeners: Set<(state: RelationalQueryState<T>) => void> = new Set()
  #processedEventUnsub: (() => void) | null = null
  #relationalFilterRefetchQueued = false
  #lastSnapshot: RelationalQueryState<T> | null = null
  // Cached pagination object — only re-allocated when one of the underlying fields changes.
  // Stable identity is required by useSyncExternalStore: getSnapshot() must return ref-equal
  // values when nothing has changed, otherwise React detects a tear and re-renders forever.
  #lastPagination: RelationalPaginationState | null = null
  // The last `getSnapshot()` return for paginate mode, including its pagination wrapper.
  // Held separately from `#lastSnapshot` because the pagination wrapper has its own identity.
  #lastWrappedSnapshot: RelationalQueryState<T> | null = null
  #lastRootData: unknown[] | null = null
  // Last-seen data ref per relation key — triggers reassembly when a relation's query
  // data changes (e.g. realtime event landed a new matching entity).
  #lastRelationData: Map<string, unknown[] | null> = new Map()
  // Cache for the wrapped array returned by #rootDataAsArray when AST kind is 'get'.
  // The underlying root data is a single object, but the inputsChanged check downstream
  // compares array refs — without this cache, every getSnapshot call would allocate a
  // fresh `[data]` array and force reassembly, producing a new lastSnapshot identity on
  // each call and tripping React's "getSnapshot should be cached" warning + infinite-loop
  // protection.
  #lastGetData: unknown = undefined
  #lastGetDataAsArray: unknown[] = []
  // Suspense-support state. The promise is created lazily when suspensePromise() is first
  // called and resolves/rejects on the first transition to success/error. Once settled, no
  // new promise is created for this qRef instance — a cold start happens exactly once.
  #suspensePromise: Promise<void> | null = null
  #resolveSuspense: (() => void) | null = null
  #rejectSuspense: ((error: Error) => void) | null = null
  #suspenseSettled = false
  // Relation keys that already produced a fan-out warning — warn once per relation,
  // not on every sync pass.
  #fanOutWarnedKeys: Set<string> = new Set()

  #onEvict: (() => void) | null = null

  constructor(
    figbird: Figbird<S, Adapter<TParams, TMeta, TQuery>>,
    ast: QueryAST,
    schema: S,
    onEvict?: () => void,
  ) {
    this.#figbird = figbird
    this.#ast = ast
    this.#schema = schema
    this.#queryId = `rq/${hashObject(ast)}`
    this.#onEvict = onEvict ?? null
  }

  /** Returns internal details of this query reference (for debugging/testing). */
  details(): { queryId: string; ast: QueryAST } {
    return {
      queryId: this.#queryId,
      ast: this.#ast,
    }
  }

  /** Returns a stable hash representing the query AST. */
  hash(): string {
    return this.#queryId
  }

  /**
   * Subscribes to this relational query's state. Triggers fetching if needed.
   * Returns an unsubscribe function.
   *
   * Note: Does NOT call fn synchronously - useSyncExternalStore expects this.
   */
  subscribe(fn: (state: RelationalQueryState<T>) => void): () => void {
    this.#listeners.add(fn)

    // Set up queries if not already done
    if (!this.#rootQueryRef && this.#pageRefs.length === 0) {
      this.#setupRootQuery()
    }

    // Don't call fn synchronously - useSyncExternalStore will call getSnapshot() instead

    return () => {
      this.#listeners.delete(fn)

      // Clean up if no more listeners
      if (this.#listeners.size === 0) {
        this.#cleanup()
      }
    }
  }

  /** Returns the latest snapshot of the relational query state. */
  getSnapshot(): RelationalQueryState<T> {
    const isPaginate = this.#ast.kind === 'paginate'
    // Memoize pagination — stable identity is required by useSyncExternalStore.
    const paginationState = (): RelationalPaginationState | undefined => {
      if (!isPaginate) return undefined
      const hasMore = this.#hasMoreSticky
      const isLoadingMore = this.#isLoadingMore
      const loadMoreError = this.#loadMoreError
      const totalCount = this.#computeTotalCount()
      const prev = this.#lastPagination
      if (
        prev &&
        prev.hasMore === hasMore &&
        prev.isLoadingMore === isLoadingMore &&
        prev.loadMoreError === loadMoreError &&
        prev.totalCount === totalCount
      ) {
        return prev
      }
      const next: RelationalPaginationState = {
        hasMore,
        isLoadingMore,
        loadMoreError,
        totalCount,
      }
      this.#lastPagination = next
      return next
    }

    const withPagination = (s: RelationalQueryState<T>): RelationalQueryState<T> => {
      if (!isPaginate) return s
      const pagination = paginationState()
      // Reuse the previously wrapped snapshot when both inputs are reference-equal — this is
      // what gives useSyncExternalStore a stable snapshot across consecutive reads.
      const prev = this.#lastWrappedSnapshot
      if (prev && prev === s) return prev
      if (
        prev &&
        (prev as RelationalQueryState<T> & { __inner?: unknown }).__inner === s &&
        prev.pagination === pagination
      ) {
        return prev
      }
      const wrapped = { ...s, pagination } as RelationalQueryState<T> & {
        __inner?: unknown
      }
      // Stash the inner snapshot for identity checks on the next call without mutating it.
      Object.defineProperty(wrapped, '__inner', { value: s, enumerable: false })
      this.#lastWrappedSnapshot = wrapped
      return wrapped
    }

    // While a sub-query (root or relation) is fetching but we already have a previous
    // successful snapshot, keep showing it with isFetching: true. This is the SWR
    // pattern at the relational level — without it, a parent-data change that
    // triggers a relation `$in` to grow would force a brand-new (cold) relation
    // queryRef, flipping the assembled view back to 'loading' and flashing a
    // Suspense fallback under `useQuery`.
    const fetchingSnapshot = (): RelationalQueryState<T> => {
      if (this.#lastSnapshot?.status === 'success') {
        if (!this.#lastSnapshot.isFetching) {
          this.#lastSnapshot = { ...this.#lastSnapshot, isFetching: true }
        }
        return withPagination(this.#lastSnapshot)
      }
      if (!this.#lastSnapshot || this.#lastSnapshot.status !== 'loading') {
        this.#lastSnapshot = {
          status: 'loading',
          data: null,
          error: null,
          isFetching: true,
        }
      }
      return withPagination(this.#lastSnapshot)
    }

    const errorSnapshot = (error: Error): RelationalQueryState<T> => {
      if (
        !this.#lastSnapshot ||
        this.#lastSnapshot.status !== 'error' ||
        this.#lastSnapshot.error !== error
      ) {
        this.#lastSnapshot = {
          status: 'error',
          data: null,
          error,
          isFetching: false,
        }
      }
      return withPagination(this.#lastSnapshot)
    }

    // Collect relation states and surface their errors. For two-hop `many` relations
    // we also walk the junction sub so the consumer's snapshot reflects both halves.
    // Returns null when a relation is still loading (caller returns fetchingSnapshot),
    // or an error snapshot when a relation failed.
    const collectRelationData = ():
      | { relationData: Map<string, unknown[] | null> }
      | { snapshot: RelationalQueryState<T> } => {
      const currentRelationData = new Map<string, unknown[] | null>()
      for (const [key, sub] of this.#relationSubs) {
        if (sub.junction) {
          const js = sub.junction.queryRef.getSnapshot()
          if (!js || js.status === 'loading') {
            return { snapshot: fetchingSnapshot() }
          }
          if (js.status === 'error') {
            return { snapshot: errorSnapshot(js.error) }
          }
          currentRelationData.set(`${key}#junction`, js.data as unknown[])
        }
        if (sub.perParent) {
          currentRelationData.set(key, null)
          for (const [sourceKey, child] of sub.perParent) {
            const s = child.queryRef.getSnapshot()
            if (!s || s.status === 'loading') {
              return { snapshot: fetchingSnapshot() }
            }
            if (s.status === 'error') {
              return { snapshot: errorSnapshot(s.error) }
            }
            currentRelationData.set(`${key}#parent:${sourceKey}`, s.data as unknown[])
          }
          continue
        }
        if (!sub.queryRef) {
          currentRelationData.set(key, null)
          continue
        }
        const s = sub.queryRef.getSnapshot()
        if (!s || s.status === 'loading') {
          return { snapshot: fetchingSnapshot() }
        }
        if (s.status === 'error') {
          return { snapshot: errorSnapshot(s.error) }
        }
        currentRelationData.set(key, s.data as unknown[])
      }
      return { relationData: currentRelationData }
    }

    // Paginate: aggregate page state. We need every loaded page to be in success state
    // before we can present an assembled snapshot.
    if (isPaginate) {
      if (this.#pageRefs.length === 0) {
        return fetchingSnapshot()
      }
      // Check page states.
      const pageStates: QueryState<unknown, TMeta>[] = []
      for (const ref of this.#pageRefs) {
        const s = ref.getSnapshot()
        if (!s) return fetchingSnapshot()
        pageStates.push(s)
      }
      // Surface the first page error.
      for (const s of pageStates) {
        if (s.status === 'error') {
          return errorSnapshot(s.error)
        }
      }
      // First page must have succeeded once before we present data.
      const firstPage = pageStates[0]!
      if (firstPage.status === 'loading') {
        return fetchingSnapshot()
      }

      const rootData = this.#allPagesData()
      // We can present even if a follow-up page is still loading: the accumulated array
      // covers what's been read so far, and `isLoadingMore` signals the in-flight load.
      const anyFetching = pageStates.some(s => s.isFetching)

      if (!this.#areExpectedRelationsSynced(rootData, this.#ast, null)) {
        return fetchingSnapshot()
      }

      const collected = collectRelationData()
      if ('snapshot' in collected) return collected.snapshot
      const currentRelationData = collected.relationData

      let inputsChanged =
        this.#lastRootData !== rootData || this.#lastRelationData.size !== currentRelationData.size
      if (!inputsChanged) {
        for (const [key, data] of currentRelationData) {
          if (this.#lastRelationData.get(key) !== data) {
            inputsChanged = true
            break
          }
        }
      }

      if (
        !inputsChanged &&
        this.#lastSnapshot?.status === 'success' &&
        this.#lastSnapshot.isFetching === anyFetching
      ) {
        return withPagination(this.#lastSnapshot)
      }

      const assembled = this.#assembleRelations(rootData, this.#ast, null)

      this.#lastRootData = rootData
      this.#lastRelationData = currentRelationData
      this.#lastSnapshot = {
        status: 'success',
        data: assembled as unknown as T,
        error: null,
        isFetching: anyFetching,
      }

      return withPagination(this.#lastSnapshot)
    }

    // If not subscribed yet, return initial loading state
    if (!this.#rootQueryRef) {
      return fetchingSnapshot()
    }

    const rootState = this.#rootQueryRef.getSnapshot()

    // Check root query state
    if (!rootState || rootState.status === 'loading') {
      return fetchingSnapshot()
    }

    if (rootState.status === 'error') {
      return errorSnapshot(rootState.error)
    }

    // Check relation queries. Relations are synced lazily from parent success, so we must
    // confirm that every expected relation at every already-resolved parent level has been
    // synced. "Synced" means present in #relationSubs (even with a null queryRef for the
    // empty-sources case, so we don't hang forever on empty relations).
    if (!this.#areExpectedRelationsSynced(this.#rootDataAsArray(rootState.data), this.#ast, null)) {
      return fetchingSnapshot()
    }

    const collected = collectRelationData()
    if ('snapshot' in collected) return collected.snapshot
    const currentRelationData = collected.relationData

    const rootData = this.#rootDataAsArray(rootState.data)

    // Decide whether the assembled output could have changed. Reassemble if root data or any
    // relation data ref has changed. This is what lets realtime events on relation services
    // propagate into the assembled view: a new matching comment mutates the comments query's
    // data ref → we reassemble → the new comment appears under the right issue.
    let inputsChanged =
      this.#lastRootData !== rootData || this.#lastRelationData.size !== currentRelationData.size
    if (!inputsChanged) {
      for (const [key, data] of currentRelationData) {
        if (this.#lastRelationData.get(key) !== data) {
          inputsChanged = true
          break
        }
      }
    }

    if (
      !inputsChanged &&
      this.#lastSnapshot?.status === 'success' &&
      this.#lastSnapshot.isFetching === rootState.isFetching
    ) {
      return this.#lastSnapshot
    }

    const assembled = this.#assembleRelations(rootData, this.#ast, null)

    const data =
      this.#ast.cardinality === 'one' ? ((assembled[0] ?? null) as T) : (assembled as unknown as T)

    this.#lastRootData = rootData
    this.#lastRelationData = currentRelationData
    this.#lastSnapshot = {
      status: 'success',
      data,
      error: null,
      isFetching: rootState.isFetching,
    }

    return this.#lastSnapshot
  }

  /**
   * Walks the AST to verify that every relation at every parent level whose parent has
   * resolved has been synced (i.e. entered into #relationSubs). Used to decide whether the
   * assembled snapshot is ready to return, or whether we're still waiting on sync to run.
   */
  #areExpectedRelationsSynced(
    _parentData: unknown[],
    ast: QueryAST,
    parentKey: string | null,
  ): boolean {
    const relationships = this.#schema.relationships?.[ast.service] ?? {}
    for (const [relName, relAST] of Object.entries(ast.related)) {
      if (!relationships[relName]) {
        // Missing relationship definition was warned about in sync; treat as synced so we
        // don't block rendering.
        continue
      }
      const key = parentKey ? `${parentKey}.${relName}` : relName
      const sub = this.#relationSubs.get(key)
      if (!sub) return false
      // If this relation has nested relations and its own data has resolved, recurse.
      if (Object.keys(relAST.related).length > 0 && sub.perParent) {
        const childData = this.#perParentDataIfReady(sub)
        if (childData) {
          if (!this.#areExpectedRelationsSynced(childData, relAST, key)) {
            return false
          }
        }
      }
      if (Object.keys(relAST.related).length > 0 && sub.queryRef) {
        const s = sub.queryRef.getSnapshot()
        if (s?.status === 'success') {
          if (!this.#areExpectedRelationsSynced(s.data as unknown[], relAST, key)) {
            return false
          }
        }
      }
    }
    return true
  }

  /**
   * Triggers a refetch for the root query (or for paginated queries, drops follow-up pages
   * and re-fetches from page 0).
   */
  refetch(): void {
    if (this.#ast.kind === 'paginate') {
      // Drop pages 1+ — they may now be invalid (the dataset shifted). Page 0 stays so the
      // existing UI doesn't blank out; the QueryStore re-fetches it in place.
      for (let i = 1; i < this.#pageUnsubs.length; i++) {
        this.#pageUnsubs[i]?.()
      }
      this.#pageUnsubs.length = 1
      this.#pageRefs.length = 1
      this.#hasMoreSticky = true
      this.#loadMoreError = null
      this.#pageRefs[0]?.refetch()
      // Notify so subscribers see the re-evaluated `hasMore`/`isLoadingMore` even if no
      // store-level transition fired (e.g. nothing actually changed).
      this.#notifyListeners()
      return
    }
    this.#rootQueryRef?.refetch()
  }

  /**
   * Append the next page to the accumulator. No-op when not in paginate mode, when a
   * load is already in flight, when the previous page indicated no more rows, or when
   * the first page hasn't resolved yet.
   */
  loadMore(): void {
    if (this.#ast.kind !== 'paginate') return
    if (this.#isLoadingMore) return
    if (!this.#hasMoreSticky) return
    if (this.#pageRefs.length === 0) return

    // Need the first page to have succeeded before we know whether to add more. Without
    // this guard, a fast double-click during the initial load would queue a useless page 1.
    const firstPageState = this.#pageRefs[0]?.getSnapshot()
    if (!firstPageState || firstPageState.status !== 'success') return

    this.#isLoadingMore = true
    this.#loadMoreError = null
    this.#setupPage(this.#pageRefs.length)
    // The new page's subscription will fire when it resolves, flipping isLoadingMore off
    // and updating hasMore. Notify listeners now so the UI flips to "loading more" state
    // synchronously.
    this.#notifyListeners()

    // Watch the page we just created to reset the in-flight flag on settle.
    const pageRef = this.#pageRefs[this.#pageRefs.length - 1]!
    const pageSize = this.#ast.pageSize!
    const onSettle = pageRef.subscribe(state => {
      if (state.status === 'success') {
        const data = (state.data ?? []) as unknown[]
        this.#hasMoreSticky = data.length >= pageSize
        this.#isLoadingMore = false
        this.#loadMoreError = null
        onSettle()
        this.#notifyListeners()
      } else if (state.status === 'error') {
        this.#isLoadingMore = false
        this.#loadMoreError = state.error
        // The failed page stays in the list with its error state; refetch() resets pages.
        // Keep hasMore truthy so the UI can offer a retry via loadMore again.
        this.#hasMoreSticky = true
        // Drop the failed page so a future loadMore retries the same skip rather than skipping past.
        this.#pageRefs.pop()
        const popped = this.#pageUnsubs.pop()
        popped?.()
        onSettle()
        this.#notifyListeners()
      }
    })
  }

  /**
   * Total count from the first page's meta if `returnTotal: true` was set on the builder.
   * Returns `undefined` when the adapter didn't supply a total (e.g. Feathers `total: -1`)
   * or when the user opted out of `returnTotal`.
   */
  #computeTotalCount(): number | undefined {
    if (!this.#ast.returnTotal) return undefined
    const first = this.#pageRefs[0]
    if (!first) return undefined
    const s = first.getSnapshot()
    if (!s || s.status !== 'success') return undefined
    const meta = s.meta as { total?: number } | undefined
    if (!meta || typeof meta.total !== 'number' || meta.total < 0) return undefined
    return meta.total
  }

  /**
   * Normalize the root query's data to an array. For a `find` root the data is already
   * an array; for a `get` root, the data is a single item (a removed event flips the
   * underlying query to a terminal error state in QueryStore, so this only sees
   * non-null on success).
   *
   * For `get` we cache the wrapper array against the underlying data ref so consecutive
   * getSnapshot() calls return the same array identity — without this cache the
   * inputsChanged check downstream always trips, lastSnapshot is rebuilt on every read,
   * and useSyncExternalStore enters an infinite loop.
   */
  #rootDataAsArray(data: unknown): unknown[] {
    if (this.#ast.kind === 'get') {
      if (data === this.#lastGetData) return this.#lastGetDataAsArray
      this.#lastGetData = data
      this.#lastGetDataAsArray = data == null ? [] : [data]
      return this.#lastGetDataAsArray
    }
    return data as unknown[]
  }

  // Cache of per-page data refs and the concatenated array — so identity is stable for
  // useSyncExternalStore. Recomputed only when at least one page's data ref changes.
  #lastPageDataRefs: unknown[] = []
  #lastAllPagesData: unknown[] = []

  /** Concatenate the data of all loaded pages (paginated mode). Stable identity across calls. */
  #allPagesData(): unknown[] {
    const refs: unknown[] = []
    for (const ref of this.#pageRefs) {
      const s = ref.getSnapshot()
      refs.push(s?.status === 'success' && Array.isArray(s.data) ? s.data : null)
    }
    let unchanged = refs.length === this.#lastPageDataRefs.length
    if (unchanged) {
      for (let i = 0; i < refs.length; i++) {
        if (refs[i] !== this.#lastPageDataRefs[i]) {
          unchanged = false
          break
        }
      }
    }
    if (unchanged) return this.#lastAllPagesData
    const all: unknown[] = []
    for (const ref of refs) {
      if (Array.isArray(ref)) all.push(...ref)
    }
    this.#lastPageDataRefs = refs
    this.#lastAllPagesData = all
    return all
  }

  #setupRootQuery(): void {
    if (this.#ast.kind === 'paginate') {
      this.#subscribeToRelationalFilterInvalidations()
      this.#setupPage(0)
      return
    }

    const serviceName = resolveServicePath(this.#schema, this.#ast.service)
    const rootDesc: QueryDescriptor =
      this.#ast.kind === 'get'
        ? {
            serviceName,
            method: 'get',
            resourceId: this.#ast.resourceId!,
          }
        : {
            serviceName,
            method: 'find',
            params: { query: this.#ast.query },
          }

    this.#rootQueryRef = this.#figbird.query(rootDesc, {
      realtime: 'merge',
      fetchPolicy: 'swr',
      ...(this.#ast.kind === 'find' && hasRelationalFilter(this.#schema, this.#ast)
        ? {
            matcher: this.#createRelationalMatcher(this.#ast),
          }
        : {}),
      ...(this.#ast.server ? { server: true } : {}),
    } as QueryConfig<unknown, unknown>) as unknown as QueryRef<
      unknown[],
      unknown,
      S,
      TParams,
      TMeta,
      TQuery
    >

    this.#rootUnsub = this.#rootQueryRef.subscribe(state => {
      if (state.status === 'success' && Object.keys(this.#ast.related).length > 0) {
        // Sync (create/recreate/dispose) relation queries based on current root data.
        // Called on every root success — not just first — so realtime-inserted root entities
        // cause their relations to be fetched.
        this.#syncRelations(this.#rootDataAsArray(state.data), this.#ast, null)
      }
      this.#notifyListeners()
    })

    // If the underlying root query is already warm (another consumer fetched it earlier
    // and the result is cached in QueryStore), subscribe() won't invoke its callback —
    // listeners only fire on state *changes*. Seed #syncRelations from the current state
    // so getSnapshot() can resolve past "loading" synchronously and the Suspense promise
    // settles immediately for cache-hit cases.
    const initial = this.#rootQueryRef.getSnapshot()
    if (initial?.status === 'success' && Object.keys(this.#ast.related).length > 0) {
      this.#syncRelations(this.#rootDataAsArray(initial.data), this.#ast, null)
    }

    this.#subscribeToRelationalFilterInvalidations()
  }

  /**
   * Spin up a `find` query for one paginated page. Each page is its own QueryRef in the
   * store, with its own `$skip + $limit` window — realtime events from the service
   * refetch the affected pages via the existing server-maintained-query path.
   */
  #setupPage(pageIndex: number): void {
    const pageSize = this.#ast.pageSize!
    const desc: QueryDescriptor = {
      serviceName: resolveServicePath(this.#schema, this.#ast.service),
      method: 'find',
      params: {
        query: {
          ...this.#ast.query,
          $limit: pageSize,
          $skip: pageIndex * pageSize,
        },
      },
    }

    const queryRef = this.#figbird.query(desc, {
      realtime: 'merge',
      fetchPolicy: 'swr',
      ...(hasRelationalFilter(this.#schema, this.#ast)
        ? {
            matcher: this.#createRelationalMatcher(this.#ast),
          }
        : {}),
    } as QueryConfig<unknown, unknown>) as unknown as QueryRef<
      unknown[],
      unknown,
      S,
      TParams,
      TMeta,
      TQuery
    >

    this.#pageRefs.push(queryRef)

    const unsub = queryRef.subscribe(state => {
      if (state.status === 'success') {
        const pageData = (state.data ?? []) as unknown[]
        // A page that returned fewer rows than requested is the last page. Update the
        // sticky flag — but only when no `loadMore()` is in flight so we don't briefly
        // toggle the UI as pages arrive in unexpected orders.
        if (!this.#isLoadingMore) {
          this.#hasMoreSticky = pageData.length >= pageSize
        }
        if (Object.keys(this.#ast.related).length > 0) {
          this.#syncRelations(this.#allPagesData(), this.#ast, null)
        }
      }
      this.#notifyListeners()
    })
    this.#pageUnsubs.push(unsub)

    // Warm-cache seeding: same rationale as the find/get path above.
    const initial = queryRef.getSnapshot()
    if (initial?.status === 'success') {
      const pageData = (initial.data ?? []) as unknown[]
      if (!this.#isLoadingMore) {
        this.#hasMoreSticky = pageData.length >= pageSize
      }
      if (Object.keys(this.#ast.related).length > 0) {
        this.#syncRelations(this.#allPagesData(), this.#ast, null)
      }
    }
  }

  /**
   * Reconciles relation subscriptions with the current parent data at this AST level.
   * - Creates a relation subscription when needed
   * - Replaces it when the set of source values changed (e.g. a new root item introduced a
   *   new id, so the child $in filter needs to expand)
   * - Records an empty entry when source values are empty so we don't hang on loading
   *
   * Recurses into nested relations when their parent query has resolved. Recursion happens
   * both immediately (if the child query is already succeeded from a previous cycle) and
   * lazily (child subscription callback calls back in).
   *
   * Three relation kinds are supported:
   * - single-hop `'one'` / `'many'` — fan-in IN(...) on `destField` keyed by `sourceField`
   * - `'embedded'` — `sourceField` is a list of dest ids on each parent; flat-mapped into
   *   the same IN(...) shape, no junction
   * - two-hop `'many'` (`relDef.via` set) — first fetch the junction service, then fetch
   *   the destination keyed by ids collected from the junction
   */
  #syncRelations(parentData: unknown[], ast: QueryAST, parentKey: string | null): void {
    const relationships = this.#schema.relationships?.[ast.service] ?? {}

    for (const [relName, relAST] of Object.entries(ast.related)) {
      const key = parentKey ? `${parentKey}.${relName}` : relName
      const relDef = relationships[relName]
      if (!relDef) {
        console.warn(`Relationship "${relName}" not found for service "${ast.service}"`)
        // Mark as synced with no query so loading detection doesn't hang.
        if (!this.#relationSubs.has(key)) {
          this.#relationSubs.set(key, {
            queryRef: null,
            unsub: null,
            sourceKey: '',
          })
        }
        continue
      }

      if (relDef.via) {
        this.#syncJunctionRelation(parentData, relDef, relAST, key)
        continue
      }

      if (relDef.cardinality === 'many' && this.#hasRelationWindowing(relAST)) {
        this.#syncWindowedManyRelation(parentData, relDef, relAST, key)
        continue
      }

      // Collect the set of ids we need to IN(...) for this relation. For 'embedded' the
      // parent's sourceField is itself a list — flat-map across parents.
      let uniqueValues: (string | number)[]
      if (relDef.cardinality === 'embedded') {
        const all: (string | number)[] = []
        for (const item of parentData) {
          const list = this.#getFieldValueAsList(item, relDef.sourceField)
          if (list) for (const v of list) all.push(v)
        }
        uniqueValues = [...new Set(all)].sort()
      } else {
        const sourceValues = parentData
          .map(item => this.#getFieldValue(item, relDef.sourceField))
          .filter((v): v is string | number => v !== undefined)
        uniqueValues = [...new Set(sourceValues)].sort()
      }
      const newSourceKey = JSON.stringify(uniqueValues)

      const existing = this.#relationSubs.get(key)
      if (existing && existing.sourceKey === newSourceKey && !existing.junction) {
        // Already synced for this exact set of source values. Still need to recurse into
        // nested relations in case this relation's data already resolved and its own
        // children need to be synced.
        if (existing.queryRef && Object.keys(relAST.related).length > 0) {
          const s = existing.queryRef.getSnapshot()
          if (s?.status === 'success') {
            this.#syncRelations(s.data as unknown[], relAST, key)
          }
        }
        continue
      }

      // Dispose old subscription (if source values changed or entry didn't exist)
      if (existing) this.#disposeRelationSub(existing)

      if (uniqueValues.length === 0) {
        this.#relationSubs.set(key, {
          queryRef: null,
          unsub: null,
          sourceKey: newSourceKey,
        })
        continue
      }

      const queryRef = this.#buildRelationQueryRef(relDef.destService, relDef, relAST, uniqueValues)

      const unsub = queryRef.subscribe(state => {
        if (state.status === 'success' && Object.keys(relAST.related).length > 0) {
          this.#syncRelations(state.data as unknown[], relAST, key)
        }
        this.#notifyListeners()
      })

      this.#relationSubs.set(key, { queryRef, unsub, sourceKey: newSourceKey })

      // Warm-cache recursion: if this relation's queryRef already has success state
      // (e.g. the same query was resolved by a previous RelationalQueryRef whose data
      // lives on in QueryStore), seed its nested relations synchronously. Without this,
      // navigating back to a previously-viewed item would report "loading" until the
      // SWR refetch finished, because the subscription callback above only fires on
      // state *changes* — not on subscribe.
      if (Object.keys(relAST.related).length > 0) {
        const initial = queryRef.getSnapshot()
        if (initial?.status === 'success') {
          this.#syncRelations(initial.data as unknown[], relAST, key)
        }
      }
    }
  }

  #syncWindowedManyRelation(
    parentData: unknown[],
    relDef: RelationshipDef,
    relAST: QueryAST,
    key: string,
  ): void {
    const sourceValues = parentData
      .map(item => this.#getFieldValue(item, relDef.sourceField))
      .filter((v): v is string | number => v !== undefined)
    const uniqueValues = [...new Set(sourceValues)].sort()
    const newSourceKey = JSON.stringify(uniqueValues)

    const existing = this.#relationSubs.get(key)
    if (existing?.perParent && existing.sourceKey === newSourceKey && !existing.junction) {
      this.#syncNestedWindowedRelationIfReady(existing, relAST, key)
      return
    }

    if (existing) this.#disposeRelationSub(existing)

    if (uniqueValues.length === 0) {
      this.#relationSubs.set(key, {
        queryRef: null,
        unsub: null,
        sourceKey: newSourceKey,
      })
      return
    }

    if (
      uniqueValues.length > WINDOWED_RELATION_FANOUT_WARN_THRESHOLD &&
      !this.#fanOutWarnedKeys.has(key)
    ) {
      this.#fanOutWarnedKeys.add(key)
      console.warn(
        `figbird: windowed relation "${key}" on service "${this.#ast.service}" is fanning out ` +
          `${uniqueValues.length} per-parent queries (one per parent, because per-parent ` +
          '$limit/$sort windows cannot be expressed as a single find). For list screens, ' +
          'consider a server-materialized id-list field declared with the `embed` relation ' +
          'kind instead — it collapses this to one batched IN(...) fetch.',
      )
    }

    const perParent = new Map<
      string,
      {
        queryRef: QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery>
        unsub: () => void
        sourceValue: string | number
      }
    >()

    const entry: RelationQuerySub<S, TParams, TMeta, TQuery> = {
      queryRef: null,
      unsub: null,
      sourceKey: newSourceKey,
      perParent,
    }
    this.#relationSubs.set(key, entry)

    for (const sourceValue of uniqueValues) {
      const queryRef = this.#buildSingleParentRelationQueryRef(
        relDef.destService,
        relDef,
        relAST,
        sourceValue,
      )
      const sourceKey = this.#sourceValueKey(sourceValue)
      const unsub = queryRef.subscribe(state => {
        if (state.status === 'success') {
          this.#syncNestedWindowedRelationIfReady(entry, relAST, key)
        }
        this.#notifyListeners()
      })

      perParent.set(sourceKey, { queryRef, unsub, sourceValue })
    }

    this.#syncNestedWindowedRelationIfReady(entry, relAST, key)
  }

  #syncNestedWindowedRelationIfReady(
    sub: RelationQuerySub<S, TParams, TMeta, TQuery>,
    relAST: QueryAST,
    key: string,
  ): void {
    if (Object.keys(relAST.related).length === 0) return
    const childData = this.#perParentDataIfReady(sub)
    if (childData) {
      this.#syncRelations(childData, relAST, key)
    }
  }

  /**
   * Build the destination `find` queryRef for a relation. Shared between single-hop and the
   * second hop of two-hop `many`. The query is built as `WHERE destField IN (uniqueIds)`
   * merged with any `relAST.query` (user-provided constraints) and `relDef.query` (schema-
   * level filter). `allPages` is enabled when no windowing is requested so the IN(...) set
   * isn't silently truncated by the default page cap.
   */
  #buildRelationQueryRef(
    destService: string,
    relDef: { destField: string[]; query?: Record<string, unknown> },
    relAST: QueryAST,
    uniqueValues: (string | number)[],
  ): QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery> {
    const query = {
      ...relAST.query,
      [relDef.destField[0]!]: { $in: uniqueValues },
      ...(relDef.query || {}),
    }

    // Relations without explicit windowing must paginate to capture every match for
    // the parent's IN(...) filter — otherwise the default per-page cap would silently
    // drop entries. When the user adds `.limit()`/`.skip()`/`.orderBy()`, that windowing
    // is the intent: respect it and let the query be server-maintained so realtime
    // events trigger a refetch of the window instead of merging locally.
    const hasWindowing = hasWindowFilters(relAST.query)

    return this.#figbird.query(
      {
        serviceName: resolveServicePath(this.#schema, destService),
        method: 'find',
        params: { query },
      },
      {
        realtime: 'merge',
        fetchPolicy: 'swr',
        ...(hasWindowing ? {} : { allPages: true }),
        ...(relAST.server ? { server: true } : {}),
      } as QueryConfig<unknown, unknown>,
    ) as unknown as QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery>
  }

  #buildSingleParentRelationQueryRef(
    destService: string,
    relDef: { destField: string[]; query?: Record<string, unknown> },
    relAST: QueryAST,
    sourceValue: string | number,
  ): QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery> {
    const query = {
      ...relAST.query,
      [relDef.destField[0]!]: sourceValue,
      ...(relDef.query || {}),
    }

    return this.#figbird.query(
      {
        serviceName: resolveServicePath(this.#schema, destService),
        method: 'find',
        params: { query },
      },
      {
        realtime: 'merge',
        fetchPolicy: 'swr',
        ...(relAST.server ? { server: true } : {}),
      } as QueryConfig<unknown, unknown>,
    ) as unknown as QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery>
  }

  #hasRelationWindowing(relAST: QueryAST): boolean {
    return hasWindowFilters(relAST.query)
  }

  #subscribeToRelationalFilterInvalidations(): void {
    if (this.#processedEventUnsub) return
    const dependencies = collectRelationalFilterDependencies(this.#schema, this.#ast)
    if (dependencies.length === 0) return

    for (const dependency of dependencies) {
      this.#figbird.queryStore.ensureRealtimeSubscription(dependency.serviceName)
    }

    this.#processedEventUnsub = this.#figbird.queryStore.subscribeToProcessedEvents(event => {
      if (
        !shouldRefetchRelationalFilterQuery(
          this.#schema,
          this.#figbird.getState(),
          this.#ast,
          dependencies,
          event,
        )
      ) {
        return
      }
      this.#queueRelationalFilterRefetch()
    })
  }

  #queueRelationalFilterRefetch(): void {
    if (this.#relationalFilterRefetchQueued) return
    this.#relationalFilterRefetchQueued = true
    queueMicrotask(() => {
      this.#relationalFilterRefetchQueued = false
      if (this.#listeners.size === 0) return
      this.refetch()
    })
  }

  #createRelationalMatcher(ast: QueryAST): (query: unknown) => (item: unknown) => boolean {
    return query => {
      const match = this.#figbird.adapter.matcher(query as TQuery | undefined)
      const paths = collectRelationalFilterPaths(this.#schema, ast.service, query)
      return item => {
        if (paths.length === 0) return match(item)
        const materialized = materializeRelationalFilterItem(
          this.#schema,
          this.#figbird.getState(),
          ast.service,
          item,
          paths,
        )
        return materialized.complete ? match(materialized.item) : false
      }
    }
  }

  #perParentDataIfReady(sub: RelationQuerySub<S, TParams, TMeta, TQuery>): unknown[] | null {
    if (!sub.perParent) return null

    const rows: unknown[] = []
    for (const child of sub.perParent.values()) {
      const state = child.queryRef.getSnapshot()
      if (state?.status !== 'success') return null
      rows.push(...(state.data as unknown[]))
    }
    return rows
  }

  #sourceValueKey(value: string | number): string {
    return JSON.stringify(value)
  }

  #disposeRelationSub(sub: RelationQuerySub<S, TParams, TMeta, TQuery>): void {
    sub.unsub?.()
    sub.junction?.unsub()
    if (sub.perParent) {
      for (const child of sub.perParent.values()) {
        child.unsub()
      }
    }
  }

  /**
   * Sync a two-hop `many` relation (junction-table many-to-many).
   *
   * Phase 1: collect parent ids from `via.sourceField`, fetch the junction with
   *   `WHERE via.destField IN (parentIds)` (plus any `via.query`).
   * Phase 2: when the junction resolves, collect dest ids from `relDef.sourceField`
   *   on the junction items and fetch the destination with
   *   `WHERE relDef.destField IN (destIds)` (plus `relDef.query` and `relAST.query`).
   *
   * Both phases register their queryRefs in `#relationSubs` so loading/error/cache
   * invalidation passes can see them.
   */
  #syncJunctionRelation(
    parentData: unknown[],
    relDef: RelationshipDef,
    relAST: QueryAST,
    key: string,
  ): void {
    const via = relDef.via!

    const parentIds = parentData
      .map(item => this.#getFieldValue(item, via.sourceField))
      .filter((v): v is string | number => v !== undefined)
    const uniqueParentIds = [...new Set(parentIds)].sort()
    const junctionSourceKey = JSON.stringify(uniqueParentIds)

    const existing = this.#relationSubs.get(key)

    // Same parent set: junction (and downstream dest) is already up to date. Recurse into
    // nested relations under the dest if they exist and the dest has resolved.
    if (
      existing?.junction &&
      existing.junction.sourceKey === junctionSourceKey &&
      existing.queryRef
    ) {
      if (Object.keys(relAST.related).length > 0) {
        const s = existing.queryRef.getSnapshot()
        if (s?.status === 'success') {
          this.#syncRelations(s.data as unknown[], relAST, key)
        }
      }
      return
    }

    // Dispose previous subs — both junction and dest — before rebuilding.
    if (existing) this.#disposeRelationSub(existing)

    if (uniqueParentIds.length === 0) {
      this.#relationSubs.set(key, {
        queryRef: null,
        unsub: null,
        sourceKey: junctionSourceKey,
      })
      return
    }

    // Build the junction queryRef. Junction never windows from the consumer's API surface;
    // it must be exhaustive for the parents we asked about so assembly doesn't drop edges.
    const junctionRef = this.#figbird.query(
      {
        serviceName: resolveServicePath(this.#schema, via.destService),
        method: 'find',
        params: {
          query: {
            [via.destField[0]!]: { $in: uniqueParentIds },
            ...(via.query || {}),
          },
        },
      },
      {
        realtime: 'merge',
        fetchPolicy: 'swr',
        allPages: true,
      } as QueryConfig<unknown, unknown>,
    ) as unknown as QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery>

    // Phase 2: build/refresh the dest sub from the junction's data.
    const refreshDest = (junctionItems: unknown[]): void => {
      const destIds = junctionItems
        .map(j => this.#getFieldValue(j, relDef.sourceField))
        .filter((v): v is string | number => v !== undefined)
      const uniqueDestIds = [...new Set(destIds)].sort()
      const destSourceKey = JSON.stringify(uniqueDestIds)

      const cur = this.#relationSubs.get(key)
      if (cur?.queryRef && cur.sourceKey === destSourceKey) return

      if (cur?.unsub) cur.unsub()

      const junctionEntry = cur?.junction
      if (uniqueDestIds.length === 0) {
        this.#relationSubs.set(key, {
          queryRef: null,
          unsub: null,
          sourceKey: destSourceKey,
          ...(junctionEntry ? { junction: junctionEntry } : {}),
        })
        return
      }

      const destRef = this.#buildRelationQueryRef(relDef.destService, relDef, relAST, uniqueDestIds)

      const destUnsub = destRef.subscribe(state => {
        if (state.status === 'success' && Object.keys(relAST.related).length > 0) {
          this.#syncRelations(state.data as unknown[], relAST, key)
        }
        this.#notifyListeners()
      })

      this.#relationSubs.set(key, {
        queryRef: destRef,
        unsub: destUnsub,
        sourceKey: destSourceKey,
        ...(junctionEntry ? { junction: junctionEntry } : {}),
      })

      if (Object.keys(relAST.related).length > 0) {
        const initial = destRef.getSnapshot()
        if (initial?.status === 'success') {
          this.#syncRelations(initial.data as unknown[], relAST, key)
        }
      }
    }

    const junctionUnsub = junctionRef.subscribe(state => {
      if (state.status === 'success') {
        refreshDest(state.data as unknown[])
      }
      this.#notifyListeners()
    })

    // Seed the entry with the junction sub. The dest sub is added once the junction
    // resolves (either via the subscribe callback above or the warm-cache path below).
    this.#relationSubs.set(key, {
      queryRef: null,
      unsub: null,
      sourceKey: '',
      junction: {
        queryRef: junctionRef,
        unsub: junctionUnsub,
        sourceKey: junctionSourceKey,
      },
    })

    // Warm-cache: if the junction is already in success state (the same junction query
    // resolved earlier and its data is still in QueryStore), build the dest sub right
    // away. Subscribe callbacks only fire on state *changes*, so without this seeding
    // the dest would never get built on warm reads.
    const junctionInitial = junctionRef.getSnapshot()
    if (junctionInitial?.status === 'success') {
      refreshDest(junctionInitial.data as unknown[])
    }
  }

  /**
   * Build per-relation lookup indexes over the relation query results so per-parent
   * matching during assembly is a map lookup instead of a linear scan — O(parents +
   * relation rows) per reassembly rather than O(parents × relation rows).
   *
   * - `byKey` maps a dest-key value to the first matching entity ('one'/'embedded').
   * - `listByKey` groups entities by dest-key value in result order ('many').
   * - `junctionsByParent` groups junction rows by the parent-side join value (two-hop).
   */
  #buildAssemblyIndexes(
    ast: QueryAST,
    parentKey: string | null,
    relationships: Record<string, RelationshipDef>,
  ): Map<
    string,
    {
      byKey?: Map<string | number, unknown>
      listByKey?: Map<string | number, unknown[]>
      junctionsByParent?: Map<string | number, unknown[]>
    }
  > {
    const indexes = new Map<
      string,
      {
        byKey?: Map<string | number, unknown>
        listByKey?: Map<string | number, unknown[]>
        junctionsByParent?: Map<string | number, unknown[]>
      }
    >()

    for (const [relName] of Object.entries(ast.related)) {
      const relDef = relationships[relName]
      if (!relDef) continue

      const key = parentKey ? `${parentKey}.${relName}` : relName
      const sub = this.#relationSubs.get(key)
      // Per-parent windowed relations are already keyed by parent — no index needed.
      if (sub?.perParent) continue

      const subState = sub?.queryRef?.getSnapshot()
      const relationItems =
        subState?.status === 'success' ? (subState.data as unknown[]) : ([] as unknown[])

      if (relDef.via) {
        const byKey = new Map<string | number, unknown>()
        for (const entity of relationItems) {
          const k = this.#getFieldValue(entity, relDef.destField)
          if (k !== undefined && !byKey.has(k)) byKey.set(k, entity)
        }
        const junctionSnap = sub?.junction?.queryRef.getSnapshot()
        const junctionItems =
          junctionSnap?.status === 'success' ? (junctionSnap.data as unknown[]) : []
        const junctionsByParent = new Map<string | number, unknown[]>()
        for (const j of junctionItems) {
          const p = this.#getFieldValue(j, relDef.via.destField)
          if (p === undefined) continue
          let list = junctionsByParent.get(p)
          if (!list) {
            list = []
            junctionsByParent.set(p, list)
          }
          list.push(j)
        }
        indexes.set(relName, { byKey, junctionsByParent })
      } else if (relDef.cardinality === 'one' || relDef.cardinality === 'embedded') {
        // First match wins — mirrors the previous scan's short-circuit semantics.
        const byKey = new Map<string | number, unknown>()
        for (const entity of relationItems) {
          const k = this.#getFieldValue(entity, relDef.destField)
          if (k !== undefined && !byKey.has(k)) byKey.set(k, entity)
        }
        indexes.set(relName, { byKey })
      } else {
        const listByKey = new Map<string | number, unknown[]>()
        for (const entity of relationItems) {
          const k = this.#getFieldValue(entity, relDef.destField)
          if (k === undefined) continue
          let list = listByKey.get(k)
          if (!list) {
            list = []
            listByKey.set(k, list)
          }
          list.push(entity)
        }
        indexes.set(relName, { listByKey })
      }
    }

    return indexes
  }

  #assembleRelations(items: unknown[], ast: QueryAST, parentKey: string | null): unknown[] {
    const relationships = this.#schema.relationships?.[ast.service] ?? {}
    const indexes = this.#buildAssemblyIndexes(ast, parentKey, relationships)

    return items.map(item => {
      const result = { ...(item as object) }

      for (const [relName, relAST] of Object.entries(ast.related)) {
        const key = parentKey ? `${parentKey}.${relName}` : relName
        const relDef = relationships[relName]
        if (!relDef) continue

        const sub = this.#relationSubs.get(key)
        const index = indexes.get(relName)

        let matchedItems: unknown[]

        if (sub?.perParent) {
          const sourceValue = this.#getFieldValue(item, relDef.sourceField)
          const perParent =
            sourceValue === undefined
              ? undefined
              : sub.perParent.get(this.#sourceValueKey(sourceValue))
          const state = perParent?.queryRef.getSnapshot()
          matchedItems = state?.status === 'success' ? (state.data as unknown[]) : []
        } else if (relDef.cardinality === 'embedded') {
          const sourceList = this.#getFieldValueAsList(item, relDef.sourceField)
          if (!sourceList || sourceList.length === 0) {
            matchedItems = []
          } else {
            // Walk the parent's id list (preserves the server-chosen order) and look up
            // each id against the materialised dest set.
            matchedItems = []
            for (const id of sourceList) {
              const found = index?.byKey?.get(id)
              if (found) matchedItems.push(found)
            }
          }
        } else if (relDef.via) {
          // Two-hop many: walk this parent's junction rows, then collect dest items
          // keyed by the junction's outgoing FK.
          const via = relDef.via
          const parentJoinValue = this.#getFieldValue(item, via.sourceField)
          const junctions =
            parentJoinValue === undefined
              ? undefined
              : index?.junctionsByParent?.get(parentJoinValue)
          matchedItems = []
          if (junctions) {
            for (const j of junctions) {
              const destId = this.#getFieldValue(j, relDef.sourceField)
              if (destId === undefined) continue
              const found = index?.byKey?.get(destId)
              if (found) matchedItems.push(found)
            }
          }
        } else if (relDef.cardinality === 'one') {
          const sourceValue = this.#getFieldValue(item, relDef.sourceField)
          const found = sourceValue === undefined ? null : (index?.byKey?.get(sourceValue) ?? null)
          ;(result as Record<string, unknown>)[relName] = found
          if (Object.keys(relAST.related).length > 0 && found) {
            const assembled = this.#assembleRelations([found], relAST, key)
            ;(result as Record<string, unknown>)[relName] = assembled[0] ?? null
          }
          continue
        } else {
          // Single-hop many — every entity whose dest key matches this parent.
          const sourceValue = this.#getFieldValue(item, relDef.sourceField)
          matchedItems = sourceValue === undefined ? [] : (index?.listByKey?.get(sourceValue) ?? [])
        }

        if (Object.keys(relAST.related).length > 0 && matchedItems.length > 0) {
          matchedItems = this.#assembleRelations(matchedItems, relAST, key)
        }
        ;(result as Record<string, unknown>)[relName] = matchedItems
      }

      return result
    })
  }

  #getFieldValue(item: unknown, fields: string[]): string | number | undefined {
    if (fields.length === 1) {
      const value = (item as Record<string, unknown>)[fields[0]!]
      return typeof value === 'string' || typeof value === 'number' ? value : undefined
    }

    // Compound key — use JSON.stringify for an unambiguous encoding so that two distinct
    // tuples cannot collide even if individual values contain separator characters.
    // (E.g. values ['a|b', 'c'] and ['a', 'b|c'] must produce different keys.)
    const values = fields.map(field => (item as Record<string, unknown>)[field])
    if (values.some(v => v === undefined || v === null)) {
      return undefined
    }
    return JSON.stringify(values)
  }

  /**
   * Read a list-of-ids field for `'embedded'` relations. The parent record is expected to
   * carry an array of `string | number` at `fields[0]`; non-array or missing values become
   * `undefined` so callers can treat them as "no edges from this parent". Compound keys are
   * not supported here — embedded relations are by definition single-key id lists.
   */
  #getFieldValueAsList(item: unknown, fields: string[]): (string | number)[] | undefined {
    if (fields.length !== 1) return undefined
    const value = (item as Record<string, unknown>)[fields[0]!]
    if (!Array.isArray(value)) return undefined
    return value.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
  }

  #notifyListeners(): void {
    // Compute snapshot once and cache it
    const snapshot = this.getSnapshot()
    // Settle the suspense promise on first success/error. After that it stays settled —
    // subsequent transitions back to loading (e.g. a manual refetch) do not re-suspend
    // because the keep-previous-data contract in the hook handles them without throwing.
    if (!this.#suspenseSettled) {
      if (snapshot.status === 'success') {
        this.#suspenseSettled = true
        this.#resolveSuspense?.()
        this.#resolveSuspense = null
        this.#rejectSuspense = null
      } else if (snapshot.status === 'error') {
        this.#suspenseSettled = true
        this.#rejectSuspense?.(snapshot.error)
        this.#resolveSuspense = null
        this.#rejectSuspense = null
      }
    }
    // Notify all listeners with the cached snapshot
    for (const listener of this.#listeners) {
      listener(snapshot)
    }
  }

  /**
   * Returns a promise suitable for throwing from a React Suspense boundary. Resolves on
   * first successful data, rejects on first error. After the first settle, returns an
   * already-resolved promise — callers that still see a loading/error state should defer
   * to the keep-previous-data path rather than throwing again.
   */
  suspensePromise(): Promise<void> {
    if (this.#suspenseSettled) return Promise.resolve()
    if (!this.#suspensePromise) {
      this.#suspensePromise = new Promise<void>((resolve, reject) => {
        this.#resolveSuspense = resolve
        this.#rejectSuspense = reject
      })
      // Ensure the underlying queries are materialised — callers may reach this method via
      // the hook before subscribe() runs in some orderings.
      if (!this.#rootQueryRef && this.#pageRefs.length === 0) {
        this.#setupRootQuery()
      }
      // If we've already reached a terminal state synchronously, settle immediately.
      const snap = this.getSnapshot()
      if (snap.status === 'success') {
        this.#suspenseSettled = true
        this.#resolveSuspense?.()
        this.#resolveSuspense = null
        this.#rejectSuspense = null
      } else if (snap.status === 'error') {
        this.#suspenseSettled = true
        this.#rejectSuspense?.(snap.error)
        this.#resolveSuspense = null
        this.#rejectSuspense = null
      }
    }
    return this.#suspensePromise
  }

  #cleanup(): void {
    if (this.#rootUnsub) {
      this.#rootUnsub()
      this.#rootUnsub = null
    }
    this.#processedEventUnsub?.()
    this.#processedEventUnsub = null
    this.#relationalFilterRefetchQueued = false
    for (const unsub of this.#pageUnsubs) {
      unsub()
    }
    this.#pageUnsubs.length = 0
    this.#pageRefs.length = 0
    this.#isLoadingMore = false
    this.#loadMoreError = null
    this.#hasMoreSticky = true
    for (const sub of this.#relationSubs.values()) {
      this.#disposeRelationSub(sub)
    }
    this.#relationSubs.clear()
    this.#rootQueryRef = null
    this.#lastSnapshot = null
    this.#lastPagination = null
    this.#lastWrappedSnapshot = null
    this.#lastPageDataRefs = []
    this.#lastAllPagesData = []
    this.#lastRootData = null
    this.#lastRelationData.clear()
    // Evict from the figbird-level cache so a subsequent query rebuilds a fresh ref.
    // Reset the suspense promise state too — a fresh cold-start will need a fresh promise.
    this.#suspensePromise = null
    this.#resolveSuspense = null
    this.#rejectSuspense = null
    this.#suspenseSettled = false
    this.#onEvict?.()
  }
}
