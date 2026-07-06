import { hashObject } from './hash.js'
import type { QueryAST } from './queryBuilder.js'
import { hasWindowFilters } from './queryClassification.js'
import type { QueryRef } from './queryRef.js'
import type {
  ProcessedRealtimeEvent,
  QueryConfig,
  QueryDescriptor,
  QueryState,
  ServiceState,
} from './queryTypes.js'
import {
  collectRelationalFilterDependencies,
  collectRelationalFilterPaths,
  hasRelationalFilter,
  materializeRelationalFilterItem,
  shouldRefetchRelationalFilterQuery,
  getFieldValue,
} from './relationalFilters.js'
import type { AnySchema, RelationshipDef, Schema } from './schema.js'
import { resolveServicePath } from './schema.js'

// This module is organised top-down: the consumer-facing RelationalQueryRef first,
// followed by its internal machinery — root sources (single query vs page
// accumulator behind one snapshot contract) and the pure assembly pass.

// Above this many parents, a windowed relation's per-parent queries are almost
// certainly the wrong shape (N requests for one screen) — warn and point at embed.
const WINDOWED_RELATION_FANOUT_WARN_THRESHOLD = 10

/**
 * The narrow contract the relational engine needs from a Figbird instance. Keeping
 * this structural (rather than importing the Figbird class) avoids a circular
 * dependency and states exactly what the engine relies on.
 */
export interface RelationalQueryHost<TMeta extends Record<string, unknown>, TQuery> {
  adapter: {
    matcher(query: TQuery | undefined, options?: unknown): (item: unknown) => boolean
  }
  queryStore: {
    subscribeToProcessedEvents(fn: (event: ProcessedRealtimeEvent) => void): () => void
    ensureRealtimeSubscription(serviceName: string): void
  }
  getState(): Map<string, ServiceState<TMeta>>
  /** Returns a QueryRef; typed loosely here and re-typed once at the engine's seam. */
  queryDesc(desc: QueryDescriptor, config?: QueryConfig<unknown, unknown>): unknown
}

/**
 * State for relational queries.
 *
 * The success arm carries `error` so that a failed *refetch* doesn't tear down a
 * screen that already has data: the query keeps serving the last successful
 * snapshot with the failure attached, and clears it on the next successful fetch.
 * The `error` status is reserved for cold failures — no successful data was ever
 * produced for this query.
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
      error: Error | null
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

/**
 * Live subscription state for one relation key (dotted path), tagged by resolution
 * strategy:
 *
 * - `empty` — no source values (or no relationship definition); nothing to fetch.
 * - `fanIn` — one IN(...) query covering every parent.
 * - `junction` — two-hop: a junction query, then a destination query built from the
 *   junction's rows. `dest` is null until the junction first resolves; `dest.queryRef`
 *   is null when the junction resolved to zero edges.
 * - `perParent` — windowed relations: one query per parent source value.
 */
type RelationSub<S extends Schema, TParams, TMeta extends Record<string, unknown>, TQuery> =
  | { kind: 'empty'; sourceKey: string }
  | {
      kind: 'fanIn'
      sourceKey: string
      queryRef: QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery>
      unsub: () => void
    }
  | {
      kind: 'junction'
      junction: {
        queryRef: QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery>
        unsub: () => void
        sourceKey: string
      }
      dest: {
        queryRef: QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery> | null
        unsub: (() => void) | null
        sourceKey: string
      } | null
    }
  | {
      kind: 'perParent'
      sourceKey: string
      children: Map<
        string,
        {
          queryRef: QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery>
          unsub: () => void
          sourceValue: string | number
        }
      >
    }

/** Result of gathering every relation's current data ahead of assembly. */
type GatherResult =
  | { kind: 'loading' }
  | { kind: 'error'; error: Error }
  | {
      kind: 'ready'
      /** Data refs keyed for change detection (includes junction/per-parent sub-keys). */
      dataRefs: Map<string, unknown[] | null>
      /** Data shaped for the pure assembly pass. */
      assembly: Map<string, AssembledRelationData>
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
  #host: RelationalQueryHost<TMeta, TQuery>
  #ast: QueryAST
  #schema: S
  #queryId: string

  // The root data source — a single find/get query, or a page accumulator for
  // `.paginate()` builders. `#pagedRoot` aliases the same object when paginated so
  // pagination-specific calls (loadMore, pagination block) don't need casts.
  #root: RootSource | null = null
  #pagedRoot: PagedQueryRoot<S, TParams, TMeta, TQuery> | null = null

  // Per-relation state, keyed by dotted relation path (e.g. "comments" or
  // "comments.reactions"). A relation is "synced" once its entry exists here — even a
  // kind:'empty' entry counts, so loading detection doesn't hang on empty relations.
  #relationSubs: Map<string, RelationSub<S, TParams, TMeta, TQuery>> = new Map()
  #listeners: Set<(state: RelationalQueryState<T>) => void> = new Set()
  #processedEventUnsub: (() => void) | null = null
  #relationalFilterRefetchQueued = false
  // Freshness tolerance captured from the subscriber that triggers setup — applied to
  // every internal store subscription so warm-in-store reads within the window skip
  // the SWR revalidation. 0 (default) revalidates as always.
  #staleTime = 0
  // Snapshot mode: the whole tree is fetched once and frozen — every internal query
  // subscribes with realtime disabled, and relational-filter invalidation is skipped.
  get #realtimeMode(): 'merge' | 'disabled' {
    return this.#ast.snapshot ? 'disabled' : 'merge'
  }
  // A teardown is parked on the microtask queue (see #scheduleCleanup).
  #cleanupScheduled = false

  // Snapshot identity caching — useSyncExternalStore requires getSnapshot() to return
  // ref-equal values when nothing has changed, otherwise React detects a tear and
  // re-renders forever. `#lastSnapshot` always holds the unwrapped snapshot; the
  // paginate wrapper (snapshot + pagination block) is cached separately alongside the
  // inner snapshot it was built from.
  #lastSnapshot: RelationalQueryState<T> | null = null
  #lastWrappedSnapshot: RelationalQueryState<T> | null = null
  #lastWrappedInner: RelationalQueryState<T> | null = null
  #lastRootData: unknown[] | null = null
  // Last-seen data ref per relation key — triggers reassembly when a relation's query
  // data changes (e.g. realtime event landed a new matching entity).
  #lastRelationData: Map<string, unknown[] | null> = new Map()

  // Suspense-support state. The promise is created lazily when suspensePromise() is
  // first called and resolves/rejects on the first transition to success/error. Once
  // settled, no new promise is created for this qRef instance — a cold start happens
  // exactly once.
  #suspensePromise: Promise<void> | null = null
  #resolveSuspense: (() => void) | null = null
  #rejectSuspense: ((error: Error) => void) | null = null
  #suspenseSettled = false

  // Relation keys that already produced a fan-out warning — warn once per relation,
  // not on every sync pass.
  #fanOutWarnedKeys: Set<string> = new Set()

  #onEvict: (() => void) | null = null

  constructor(
    host: RelationalQueryHost<TMeta, TQuery>,
    ast: QueryAST,
    schema: S,
    onEvict?: () => void,
  ) {
    this.#host = host
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
   * The host returns adapter-typed refs; the engine re-types them once here at its
   * only construction seam instead of casting at every call site.
   */
  #query(
    desc: QueryDescriptor,
    config: QueryConfig<unknown, unknown>,
  ): QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery> {
    return this.#host.queryDesc(desc, config) as QueryRef<
      unknown[],
      unknown,
      S,
      TParams,
      TMeta,
      TQuery
    >
  }

  /**
   * Subscribes to this relational query's state. Triggers fetching if needed.
   * Returns an unsubscribe function.
   *
   * Note: Does NOT call fn synchronously - useSyncExternalStore expects this.
   */
  subscribe(
    fn: (state: RelationalQueryState<T>) => void,
    options?: { staleTime?: number | undefined },
  ): () => void {
    this.#listeners.add(fn)

    if (!this.#root) {
      this.#staleTime = options?.staleTime ?? 0
      this.#setupRoot()
    }

    // Don't call fn synchronously - useSyncExternalStore will call getSnapshot() instead

    return () => {
      this.#listeners.delete(fn)

      // Clean up if no more listeners — but not synchronously. React StrictMode
      // unsubscribes and immediately resubscribes every mount; tearing down on the
      // spot would evict this ref and reset its state, so the resubscribed hook
      // would find a cold replacement on its next render and re-suspend, forever.
      // Deferring by a microtask lets a back-to-back resubscribe cancel the teardown.
      if (this.#listeners.size === 0) {
        this.#scheduleCleanup()
      }
    }
  }

  #scheduleCleanup(): void {
    if (this.#cleanupScheduled) return
    this.#cleanupScheduled = true
    queueMicrotask(() => {
      this.#cleanupScheduled = false
      if (this.#listeners.size === 0 && this.#root) {
        this.#cleanup()
      }
    })
  }

  /** Returns the latest snapshot of the relational query state. */
  getSnapshot(): RelationalQueryState<T> {
    if (!this.#root) return this.#fetchingSnapshot()

    const root = this.#root.snapshot()
    if (root.phase === 'error') return this.#errorSnapshot(root.error!)
    if (root.phase === 'loading') return this.#fetchingSnapshot()

    // Relations are synced lazily from parent success, so confirm that every expected
    // relation at every already-resolved parent level has been synced before reading.
    if (!this.#areExpectedRelationsSynced(this.#ast, null)) {
      return this.#fetchingSnapshot()
    }

    const gathered = this.#gatherRelationData()
    if (gathered.kind === 'loading') return this.#fetchingSnapshot()
    if (gathered.kind === 'error') return this.#errorSnapshot(gathered.error)

    // Decide whether the assembled output could have changed. Reassemble if root data
    // or any relation data ref has changed. This is what lets realtime events on
    // relation services propagate into the assembled view: a new matching comment
    // mutates the comments query's data ref → we reassemble → the new comment appears
    // under the right issue.
    let inputsChanged =
      this.#lastRootData !== root.rows || this.#lastRelationData.size !== gathered.dataRefs.size
    if (!inputsChanged) {
      for (const [key, data] of gathered.dataRefs) {
        if (this.#lastRelationData.get(key) !== data) {
          inputsChanged = true
          break
        }
      }
    }

    // Reaching this point means the root and every relation are healthy, so a snapshot
    // still carrying a refetch error must be rebuilt (clearing it) even when the data
    // itself is unchanged.
    if (
      !inputsChanged &&
      this.#lastSnapshot?.status === 'success' &&
      this.#lastSnapshot.error === null &&
      this.#lastSnapshot.isFetching === root.isFetching
    ) {
      return this.#wrap(this.#lastSnapshot)
    }

    const assembled = assembleRelations(root.rows, this.#ast, this.#schema, gathered.assembly)
    const data =
      this.#ast.kind !== 'paginate' && this.#ast.cardinality === 'one'
        ? ((assembled[0] ?? null) as T)
        : (assembled as unknown as T)

    this.#lastRootData = root.rows
    this.#lastRelationData = gathered.dataRefs
    this.#lastSnapshot = {
      status: 'success',
      data,
      error: null,
      isFetching: root.isFetching,
    }

    return this.#wrap(this.#lastSnapshot)
  }

  /**
   * While a sub-query (root or relation) is fetching but we already have a previous
   * successful snapshot, keep showing it with isFetching: true. This is the SWR
   * pattern at the relational level — without it, a parent-data change that triggers
   * a relation `$in` to grow would force a brand-new (cold) relation queryRef,
   * flipping the assembled view back to 'loading' and flashing a Suspense fallback
   * under `useQuery`.
   */
  #fetchingSnapshot(): RelationalQueryState<T> {
    if (this.#lastSnapshot?.status === 'success') {
      if (!this.#lastSnapshot.isFetching) {
        this.#lastSnapshot = { ...this.#lastSnapshot, isFetching: true }
      }
      return this.#wrap(this.#lastSnapshot)
    }
    if (!this.#lastSnapshot || this.#lastSnapshot.status !== 'loading') {
      this.#lastSnapshot = {
        status: 'loading',
        data: null,
        error: null,
        isFetching: true,
      }
    }
    return this.#wrap(this.#lastSnapshot)
  }

  /**
   * A failure with a previous successful snapshot keeps that snapshot on screen and
   * attaches the error — a background refetch failing must not unmount a working view
   * (the hook only throws on `status: 'error'`, which this path never produces). The
   * error stays attached across retries (#fetchingSnapshot preserves it, so an error
   * banner doesn't flicker off while a retry is in flight) and clears when the next
   * successful assembly in getSnapshot() writes `error: null`.
   */
  #errorSnapshot(error: Error): RelationalQueryState<T> {
    if (this.#lastSnapshot?.status === 'success') {
      if (this.#lastSnapshot.error !== error || this.#lastSnapshot.isFetching) {
        this.#lastSnapshot = { ...this.#lastSnapshot, error, isFetching: false }
      }
      return this.#wrap(this.#lastSnapshot)
    }
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
    return this.#wrap(this.#lastSnapshot)
  }

  /**
   * Attach the pagination block for paginated queries. Reuses the previously wrapped
   * snapshot when both the inner snapshot and the pagination block are ref-equal —
   * this is what gives useSyncExternalStore a stable snapshot across reads.
   */
  #wrap(s: RelationalQueryState<T>): RelationalQueryState<T> {
    const paged = this.#pagedRoot
    if (!paged) return s
    const pagination = paged.pagination()
    const prev = this.#lastWrappedSnapshot
    if (prev && this.#lastWrappedInner === s && prev.pagination === pagination) {
      return prev
    }
    const wrapped = { ...s, pagination }
    this.#lastWrappedInner = s
    this.#lastWrappedSnapshot = wrapped
    return wrapped
  }

  /**
   * Collect every relation's current data in one pass — loading/error states
   * short-circuit, and the result feeds both change detection (dataRefs) and the pure
   * assembly pass. For two-hop `many` relations both the junction and dest halves are
   * walked so realtime events on either service trigger reassembly.
   */
  #gatherRelationData(): GatherResult {
    const dataRefs = new Map<string, unknown[] | null>()
    const assembly = new Map<string, AssembledRelationData>()

    for (const [key, sub] of this.#relationSubs) {
      switch (sub.kind) {
        case 'empty': {
          dataRefs.set(key, null)
          assembly.set(key, { kind: 'none' })
          break
        }
        case 'fanIn': {
          const s = sub.queryRef.getSnapshot()
          if (!s || s.status === 'loading') return { kind: 'loading' }
          if (s.status === 'error') return { kind: 'error', error: s.error }
          dataRefs.set(key, s.data as unknown[])
          assembly.set(key, { kind: 'fanIn', items: s.data as unknown[] })
          break
        }
        case 'junction': {
          const js = sub.junction.queryRef.getSnapshot()
          if (!js || js.status === 'loading') return { kind: 'loading' }
          if (js.status === 'error') return { kind: 'error', error: js.error }
          dataRefs.set(`${key}#junction`, js.data as unknown[])

          if (!sub.dest?.queryRef) {
            // Dest pending (junction still settling) or resolved to zero edges.
            dataRefs.set(key, null)
            assembly.set(key, {
              kind: 'junction',
              items: [],
              junctionItems: js.data as unknown[],
            })
            break
          }
          const ds = sub.dest.queryRef.getSnapshot()
          if (!ds || ds.status === 'loading') return { kind: 'loading' }
          if (ds.status === 'error') return { kind: 'error', error: ds.error }
          dataRefs.set(key, ds.data as unknown[])
          assembly.set(key, {
            kind: 'junction',
            items: ds.data as unknown[],
            junctionItems: js.data as unknown[],
          })
          break
        }
        case 'perParent': {
          dataRefs.set(key, null)
          const byParent = new Map<string, unknown[]>()
          for (const [childKey, child] of sub.children) {
            const s = child.queryRef.getSnapshot()
            if (!s || s.status === 'loading') return { kind: 'loading' }
            if (s.status === 'error') return { kind: 'error', error: s.error }
            dataRefs.set(`${key}#parent:${childKey}`, s.data as unknown[])
            byParent.set(childKey, s.data as unknown[])
          }
          assembly.set(key, { kind: 'perParent', byParent })
          break
        }
      }
    }

    return { kind: 'ready', dataRefs, assembly }
  }

  /**
   * Walks the AST to verify that every relation at every parent level whose parent has
   * resolved has been synced (i.e. entered into #relationSubs). Used to decide whether
   * the assembled snapshot is ready to return, or whether we're still waiting on sync.
   */
  #areExpectedRelationsSynced(ast: QueryAST, parentKey: string | null): boolean {
    const relationships = this.#schema.relationships?.[ast.service] ?? {}
    for (const [relName, relAST] of Object.entries(ast.related)) {
      if (!relationships[relName]) {
        // Missing relationship definition was warned about in sync; treat as synced so
        // we don't block rendering.
        continue
      }
      const key = parentKey ? `${parentKey}.${relName}` : relName
      const sub = this.#relationSubs.get(key)
      if (!sub) return false
      if (Object.keys(relAST.related).length === 0) continue

      // If this relation has nested relations and its own data has resolved, recurse.
      if (sub.kind === 'perParent') {
        if (this.#perParentDataIfReady(sub) && !this.#areExpectedRelationsSynced(relAST, key)) {
          return false
        }
      }
      const destRef =
        sub.kind === 'fanIn' ? sub.queryRef : sub.kind === 'junction' ? sub.dest?.queryRef : null
      if (destRef) {
        const s = destRef.getSnapshot()
        if (s?.status === 'success') {
          if (!this.#areExpectedRelationsSynced(relAST, key)) {
            return false
          }
        }
      }
    }
    return true
  }

  /**
   * Triggers a refetch for the root (for paginated queries this drops follow-up pages
   * and re-fetches from page 0).
   */
  refetch(): void {
    this.#root?.refetch()
  }

  /** Append the next page (paginated queries only; no-op otherwise). */
  loadMore(): void {
    this.#pagedRoot?.loadMore()
  }

  #setupRoot(): void {
    this.#subscribeToRelationalFilterInvalidations()

    const serviceName = resolveServicePath(this.#schema, this.#ast.service)
    const hasRelations = Object.keys(this.#ast.related).length > 0
    const onChange = () => this.#notifyListeners()
    const onRows = (rows: unknown[]) => {
      // Sync (create/recreate/dispose) relation queries based on current root data.
      // Called on every root success — not just first — so realtime-inserted root
      // entities cause their relations to be fetched.
      if (hasRelations) this.#syncRelations(rows, this.#ast, null)
    }
    const matcherConfig = hasRelationalFilter(this.#schema, this.#ast)
      ? { matcher: this.#createRelationalMatcher(this.#ast) }
      : {}

    if (this.#ast.kind === 'paginate') {
      const pageSize = this.#ast.pageSize!
      this.#pagedRoot = new PagedQueryRoot({
        pageSize,
        returnTotal: Boolean(this.#ast.returnTotal),
        staleTime: this.#staleTime,
        makePageRef: pageIndex =>
          this.#query(
            {
              serviceName,
              method: 'find',
              params: {
                query: {
                  ...this.#ast.query,
                  $limit: pageSize,
                  $skip: pageIndex * pageSize,
                },
              },
            },
            {
              realtime: this.#realtimeMode,
              fetchPolicy: 'swr',
              ...matcherConfig,
            },
          ),
        onRows,
        onChange,
      })
      this.#root = this.#pagedRoot
      return
    }

    const rootDesc: QueryDescriptor =
      this.#ast.kind === 'get'
        ? {
            serviceName,
            method: 'get',
            resourceId: this.#ast.resourceId!,
            // `.get(id).where(...)` conditions ride along as params.query to the
            // get endpoint (rare filters, $select, ...).
            ...(Object.keys(this.#ast.query).length > 0
              ? { params: { query: this.#ast.query } }
              : {}),
          }
        : { serviceName, method: 'find', params: { query: this.#ast.query } }

    this.#root = new SingleQueryRoot({
      queryRef: this.#query(rootDesc, {
        realtime: this.#realtimeMode,
        fetchPolicy: 'swr',
        // .all() fetches every page; when unfiltered, success marks the service
        // fully materialized.
        ...(this.#ast.kind === 'all' ? { allPages: true } : {}),
        ...(this.#ast.kind !== 'get' ? matcherConfig : {}),
        ...(this.#ast.server ? { server: true } : {}),
      }),
      isGet: this.#ast.kind === 'get',
      onRows,
      onChange,
      staleTime: this.#staleTime,
    })
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
          this.#relationSubs.set(key, { kind: 'empty', sourceKey: '' })
        }
      } else if (relDef.via) {
        this.#syncJunctionRelation(parentData, relDef, relAST, key)
      } else if (relDef.cardinality === 'many' && hasWindowFilters(relAST.query)) {
        this.#syncWindowedManyRelation(parentData, relDef, relAST, key)
      } else {
        this.#syncFanInRelation(parentData, relDef, relAST, key)
      }
    }
  }

  /** Recurse into a relation's own nested relations, if it declares any. */
  #syncNested(data: unknown[], relAST: QueryAST, key: string): void {
    if (Object.keys(relAST.related).length === 0) return
    this.#syncRelations(data, relAST, key)
  }

  /** Like #syncNested, but reading the relation's current (possibly resolved) snapshot. */
  #syncNestedFromSnapshot(
    queryRef: QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery>,
    relAST: QueryAST,
    key: string,
  ): void {
    if (Object.keys(relAST.related).length === 0) return
    const s = queryRef.getSnapshot()
    if (s?.status === 'success') {
      this.#syncRelations(s.data as unknown[], relAST, key)
    }
  }

  /**
   * Sync a single-hop fan-in relation (`one` / unwindowed `many` / `embedded`): one
   * IN(...) query on `destField` keyed by the parents' source values.
   */
  #syncFanInRelation(
    parentData: unknown[],
    relDef: RelationshipDef,
    relAST: QueryAST,
    key: string,
  ): void {
    // Collect the set of ids we need to IN(...) for this relation. For 'embedded' the
    // parent's sourceField is itself a list — flat-map across parents.
    let values: (string | number)[]
    let sourceKey: string
    if (relDef.cardinality === 'embedded') {
      const all: (string | number)[] = []
      for (const item of parentData) {
        const list = getFieldValueAsList(item, relDef.sourceField)
        if (list) for (const v of list) all.push(v)
      }
      ;({ values, key: sourceKey } = sourceSet(all))
    } else {
      ;({ values, key: sourceKey } = uniqueSourceValues(parentData, relDef.sourceField))
    }

    const existing = this.#relationSubs.get(key)
    if (
      existing &&
      existing.kind !== 'junction' &&
      existing.kind !== 'perParent' &&
      existing.sourceKey === sourceKey
    ) {
      // Already synced for this exact set of source values. Still need to recurse into
      // nested relations in case this relation's data already resolved and its own
      // children need to be synced.
      if (existing.kind === 'fanIn') {
        this.#syncNestedFromSnapshot(existing.queryRef, relAST, key)
      }
      return
    }

    // Dispose old subscription (if source values changed or entry didn't exist)
    if (existing) this.#disposeRelationSub(existing)

    if (values.length === 0) {
      this.#relationSubs.set(key, { kind: 'empty', sourceKey })
      return
    }

    const queryRef = this.#buildRelationQueryRef(relDef.destService, relDef, relAST, values)
    const unsub = subscribeAndSeed(
      queryRef,
      data => this.#syncNested(data, relAST, key),
      () => this.#notifyListeners(),
      this.#staleTime,
    )

    this.#relationSubs.set(key, { kind: 'fanIn', sourceKey, queryRef, unsub })
  }

  #syncWindowedManyRelation(
    parentData: unknown[],
    relDef: RelationshipDef,
    relAST: QueryAST,
    key: string,
  ): void {
    const { values: uniqueValues, key: newSourceKey } = uniqueSourceValues(
      parentData,
      relDef.sourceField,
    )

    const existing = this.#relationSubs.get(key)
    if (existing?.kind === 'perParent' && existing.sourceKey === newSourceKey) {
      this.#syncNestedWindowedRelationIfReady(existing, relAST, key)
      return
    }

    if (existing) this.#disposeRelationSub(existing)

    if (uniqueValues.length === 0) {
      this.#relationSubs.set(key, { kind: 'empty', sourceKey: newSourceKey })
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

    const entry: RelationSub<S, TParams, TMeta, TQuery> = {
      kind: 'perParent',
      sourceKey: newSourceKey,
      children: new Map(),
    }
    this.#relationSubs.set(key, entry)

    for (const sourceValue of uniqueValues) {
      const queryRef = this.#buildSingleParentRelationQueryRef(
        relDef.destService,
        relDef,
        relAST,
        sourceValue,
      )
      const unsub = queryRef.subscribe(
        state => {
          if (state.status === 'success') {
            this.#syncNestedWindowedRelationIfReady(entry, relAST, key)
          }
          this.#notifyListeners()
        },
        { staleTime: this.#staleTime },
      )

      entry.children.set(sourceValueKey(sourceValue), { queryRef, unsub, sourceValue })
    }

    this.#syncNestedWindowedRelationIfReady(entry, relAST, key)
  }

  #syncNestedWindowedRelationIfReady(
    sub: RelationSub<S, TParams, TMeta, TQuery> & { kind: 'perParent' },
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
   * Sync a two-hop `many` relation (junction-table many-to-many).
   *
   * Phase 1: collect parent ids from `via.sourceField`, fetch the junction with
   *   `WHERE via.destField IN (parentIds)` (plus any `via.query`).
   * Phase 2: when the junction resolves, collect dest ids from `relDef.sourceField`
   *   on the junction items and fetch the destination with
   *   `WHERE relDef.destField IN (destIds)` (plus `relDef.query` and `relAST.query`).
   */
  #syncJunctionRelation(
    parentData: unknown[],
    relDef: RelationshipDef,
    relAST: QueryAST,
    key: string,
  ): void {
    const via = relDef.via!

    const { values: uniqueParentIds, key: junctionSourceKey } = uniqueSourceValues(
      parentData,
      via.sourceField,
    )

    const existing = this.#relationSubs.get(key)

    // Same parent set: junction (and downstream dest) is already up to date. Recurse into
    // nested relations under the dest if they exist and the dest has resolved.
    if (
      existing?.kind === 'junction' &&
      existing.junction.sourceKey === junctionSourceKey &&
      existing.dest?.queryRef
    ) {
      this.#syncNestedFromSnapshot(existing.dest.queryRef, relAST, key)
      return
    }

    // Dispose previous subs — both junction and dest — before rebuilding.
    if (existing) this.#disposeRelationSub(existing)

    if (uniqueParentIds.length === 0) {
      this.#relationSubs.set(key, { kind: 'empty', sourceKey: junctionSourceKey })
      return
    }

    // Build the junction queryRef. Junction never windows from the consumer's API surface;
    // it must be exhaustive for the parents we asked about so assembly doesn't drop edges.
    const junctionRef = this.#query(
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
        realtime: this.#realtimeMode,
        fetchPolicy: 'swr',
        allPages: true,
      },
    )

    // Phase 2: build/refresh the dest sub from the junction's data.
    const refreshDest = (junctionItems: unknown[]): void => {
      const { values: uniqueDestIds, key: destSourceKey } = uniqueSourceValues(
        junctionItems,
        relDef.sourceField,
      )

      const cur = this.#relationSubs.get(key)
      if (cur?.kind !== 'junction') return
      if (cur.dest?.queryRef && cur.dest.sourceKey === destSourceKey) return

      cur.dest?.unsub?.()

      if (uniqueDestIds.length === 0) {
        cur.dest = { queryRef: null, unsub: null, sourceKey: destSourceKey }
        return
      }

      const destRef = this.#buildRelationQueryRef(relDef.destService, relDef, relAST, uniqueDestIds)
      const destUnsub = subscribeAndSeed(
        destRef,
        data => this.#syncNested(data, relAST, key),
        () => this.#notifyListeners(),
        this.#staleTime,
      )

      cur.dest = { queryRef: destRef, unsub: destUnsub, sourceKey: destSourceKey }
    }

    // Seed the entry with the junction sub, then let the junction's data drive the dest.
    const entry: RelationSub<S, TParams, TMeta, TQuery> = {
      kind: 'junction',
      junction: { queryRef: junctionRef, unsub: () => {}, sourceKey: junctionSourceKey },
      dest: null,
    }
    this.#relationSubs.set(key, entry)
    entry.junction.unsub = subscribeAndSeed(
      junctionRef,
      refreshDest,
      () => this.#notifyListeners(),
      this.#staleTime,
    )
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

    return this.#query(
      {
        serviceName: resolveServicePath(this.#schema, destService),
        method: 'find',
        params: { query },
      },
      {
        realtime: this.#realtimeMode,
        fetchPolicy: 'swr',
        ...(hasWindowing ? {} : { allPages: true }),
        ...(relAST.server ? { server: true } : {}),
      },
    )
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

    return this.#query(
      {
        serviceName: resolveServicePath(this.#schema, destService),
        method: 'find',
        params: { query },
      },
      {
        realtime: this.#realtimeMode,
        fetchPolicy: 'swr',
        ...(relAST.server ? { server: true } : {}),
      },
    )
  }

  #perParentDataIfReady(
    sub: RelationSub<S, TParams, TMeta, TQuery> & { kind: 'perParent' },
  ): unknown[] | null {
    const rows: unknown[] = []
    for (const child of sub.children.values()) {
      const state = child.queryRef.getSnapshot()
      if (state?.status !== 'success') return null
      rows.push(...(state.data as unknown[]))
    }
    return rows
  }

  #disposeRelationSub(sub: RelationSub<S, TParams, TMeta, TQuery>): void {
    switch (sub.kind) {
      case 'empty':
        return
      case 'fanIn':
        sub.unsub()
        return
      case 'junction':
        sub.junction.unsub()
        sub.dest?.unsub?.()
        return
      case 'perParent':
        for (const child of sub.children.values()) {
          child.unsub()
        }
        return
    }
  }

  #subscribeToRelationalFilterInvalidations(): void {
    if (this.#ast.snapshot) return
    if (this.#processedEventUnsub) return
    const dependencies = collectRelationalFilterDependencies(this.#schema, this.#ast)
    if (dependencies.length === 0) return
    const paths = collectRelationalFilterPaths(this.#schema, this.#ast.service, this.#ast.query)

    for (const dependency of dependencies) {
      this.#host.queryStore.ensureRealtimeSubscription(dependency.serviceName)
    }

    this.#processedEventUnsub = this.#host.queryStore.subscribeToProcessedEvents(event => {
      if (
        !shouldRefetchRelationalFilterQuery(
          this.#schema,
          this.#host.getState(),
          this.#ast,
          paths,
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
      const match = this.#host.adapter.matcher(query as TQuery | undefined)
      const paths = collectRelationalFilterPaths(this.#schema, ast.service, query)
      return item => {
        if (paths.length === 0) return match(item)
        const materialized = materializeRelationalFilterItem(
          this.#schema,
          this.#host.getState(),
          ast.service,
          item,
          paths,
        )
        return materialized.complete ? match(materialized.item) : false
      }
    }
  }

  #notifyListeners(): void {
    // Compute snapshot once and cache it
    const snapshot = this.getSnapshot()
    this.#settleSuspense(snapshot)
    // Notify all listeners with the cached snapshot
    for (const listener of this.#listeners) {
      listener(snapshot)
    }
  }

  /**
   * Settle the suspense promise on first success/error. After that it stays settled —
   * subsequent transitions back to loading (e.g. a manual refetch) do not re-suspend
   * because the keep-previous-data contract in the hook handles them without throwing.
   */
  #settleSuspense(snapshot: RelationalQueryState<T>): void {
    if (this.#suspenseSettled) return
    if (snapshot.status !== 'success' && snapshot.status !== 'error') return
    this.#suspenseSettled = true
    if (snapshot.status === 'success') {
      this.#resolveSuspense?.()
    } else {
      this.#rejectSuspense?.(snapshot.error)
    }
    this.#resolveSuspense = null
    this.#rejectSuspense = null
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
      if (!this.#root) {
        this.#setupRoot()
      }
      // If we've already reached a terminal state synchronously, settle immediately.
      this.#settleSuspense(this.getSnapshot())
    }
    return this.#suspensePromise
  }

  #cleanup(): void {
    this.#root?.teardown()
    this.#root = null
    this.#pagedRoot = null
    this.#processedEventUnsub?.()
    this.#processedEventUnsub = null
    this.#relationalFilterRefetchQueued = false
    for (const sub of this.#relationSubs.values()) {
      this.#disposeRelationSub(sub)
    }
    this.#relationSubs.clear()
    this.#lastSnapshot = null
    this.#lastWrappedSnapshot = null
    this.#lastWrappedInner = null
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

// ---------------------------------------------------------------------------
// Root sources
// ---------------------------------------------------------------------------

/**
 * Root sources for relational queries. A relational query's root data comes from one
 * of two shapes — a single find/get query, or an accumulating sequence of pages — and
 * everything downstream (relation sync, gathering, assembly) only cares about "the
 * current root rows". `RootSource` is that seam: the RelationalQueryRef consumes one
 * unified snapshot contract, and the paginate-specific machinery (loadMore, hasMore,
 * page accumulation) lives entirely inside `PagedQueryRoot`.
 */

interface RootSnapshot {
  phase: 'loading' | 'error' | 'ready'
  /** Valid when phase is 'ready'. Identity is stable while the underlying data is. */
  rows: unknown[]
  isFetching: boolean
  error: Error | null
}

interface RootSource {
  snapshot(): RootSnapshot
  refetch(): void
  teardown(): void
}

/**
 * Pagination metadata exposed by paginated queries. Present on the relational
 * snapshot only when the underlying builder used `.paginate(...)`.
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

const EMPTY_ROWS: unknown[] = []
const LOADING_ROOT: RootSnapshot = {
  phase: 'loading',
  rows: EMPTY_ROWS,
  isFetching: true,
  error: null,
}

/**
 * Subscribe to a store query and seed from its current state. Store listeners fire
 * only on state *changes* — a query that is already warm in the QueryStore (resolved
 * earlier by another consumer) never invokes the callback, so without the seed a warm
 * read would report "loading" until the SWR refetch finished.
 */
function subscribeAndSeed<S extends Schema, TParams, TMeta extends Record<string, unknown>, TQuery>(
  queryRef: QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery>,
  onSuccess: (data: unknown[]) => void,
  onChange: () => void,
  staleTime = 0,
): () => void {
  const unsub = queryRef.subscribe(
    state => {
      if (state.status === 'success') onSuccess(state.data as unknown[])
      onChange()
    },
    { staleTime },
  )
  const initial = queryRef.getSnapshot()
  if (initial?.status === 'success') onSuccess(initial.data as unknown[])
  return unsub
}

/**
 * Root backed by a single find or get query. For get roots the single item is
 * normalized to a one-element array with a cached identity — downstream change
 * detection compares row array refs, so the wrapper must be stable across reads.
 */
class SingleQueryRoot<
  S extends Schema = AnySchema,
  TParams = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TQuery = Record<string, unknown>,
> implements RootSource {
  #queryRef: QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery>
  #unsub: () => void
  #isGet: boolean
  #lastGetData: unknown = undefined
  #lastGetDataAsArray: unknown[] = []

  constructor({
    queryRef,
    isGet,
    onRows,
    onChange,
    staleTime = 0,
  }: {
    queryRef: QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery>
    isGet: boolean
    onRows: (rows: unknown[]) => void
    onChange: () => void
    staleTime?: number
  }) {
    this.#queryRef = queryRef
    this.#isGet = isGet
    this.#unsub = subscribeAndSeed(
      queryRef,
      data => onRows(this.#asRows(data)),
      onChange,
      staleTime,
    )
  }

  #asRows(data: unknown): unknown[] {
    if (!this.#isGet) return data as unknown[]
    if (data === this.#lastGetData) return this.#lastGetDataAsArray
    this.#lastGetData = data
    this.#lastGetDataAsArray = data == null ? [] : [data]
    return this.#lastGetDataAsArray
  }

  snapshot(): RootSnapshot {
    const s = this.#queryRef.getSnapshot()
    if (!s || s.status === 'loading') return LOADING_ROOT
    if (s.status === 'error') {
      return { phase: 'error', rows: EMPTY_ROWS, isFetching: false, error: s.error }
    }
    return { phase: 'ready', rows: this.#asRows(s.data), isFetching: s.isFetching, error: null }
  }

  refetch(): void {
    this.#queryRef.refetch()
  }

  teardown(): void {
    this.#unsub()
  }
}

/**
 * Root backed by an accumulating sequence of page queries. Each loaded page is its
 * own `find` query in the QueryStore with its own `$skip + $limit` window; together
 * they form the accumulated rows. Refetching/realtime is per-page.
 */
class PagedQueryRoot<
  S extends Schema = AnySchema,
  TParams = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TQuery = Record<string, unknown>,
> implements RootSource {
  #makePageRef: (pageIndex: number) => QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery>
  #onRows: (rows: unknown[]) => void
  #onChange: () => void
  #pageSize: number
  #returnTotal: boolean

  #pageRefs: Array<QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery>> = []
  #pageUnsubs: Array<() => void> = []
  #staleTime = 0
  #isLoadingMore = false
  #loadMoreError: Error | null = null
  // Sticky `hasMore`: only flips to false when we've observed a partial page. Stays true
  // while `loadMore()` is in flight so the UI's "Load more" button doesn't flicker.
  #hasMoreSticky = true
  // Cache of per-page data refs and the concatenated array — identity is stable for
  // useSyncExternalStore. Recomputed only when at least one page's data ref changes.
  #lastPageDataRefs: unknown[] = []
  #lastAllPagesData: unknown[] = []
  // Memoized pagination object — stable identity is required by useSyncExternalStore.
  #lastPagination: RelationalPaginationState | null = null

  constructor({
    pageSize,
    returnTotal,
    makePageRef,
    onRows,
    onChange,
    staleTime = 0,
  }: {
    pageSize: number
    returnTotal: boolean
    makePageRef: (pageIndex: number) => QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery>
    onRows: (rows: unknown[]) => void
    onChange: () => void
    staleTime?: number
  }) {
    this.#pageSize = pageSize
    this.#returnTotal = returnTotal
    this.#makePageRef = makePageRef
    this.#onRows = onRows
    this.#onChange = onChange
    this.#staleTime = staleTime
    this.#setupPage(0)
  }

  #setupPage(pageIndex: number): void {
    const queryRef = this.#makePageRef(pageIndex)
    this.#pageRefs.push(queryRef)
    const unsub = subscribeAndSeed(
      queryRef,
      data => {
        const pageData = data ?? []
        // A page that returned fewer rows than requested is the last page. Update the
        // sticky flag — but only when no `loadMore()` is in flight so we don't briefly
        // toggle the UI as pages arrive in unexpected orders.
        if (!this.#isLoadingMore) {
          this.#hasMoreSticky = pageData.length >= this.#pageSize
        }
        this.#onRows(this.#allPagesData())
      },
      this.#onChange,
      this.#staleTime,
    )
    this.#pageUnsubs.push(unsub)
  }

  /**
   * Append the next page to the accumulator. No-op when a load is already in flight,
   * when the previous page indicated no more rows, or when the first page hasn't
   * resolved yet.
   */
  loadMore(): void {
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
    // and updating hasMore. Notify now so the UI flips to "loading more" synchronously.
    this.#onChange()

    // Watch the page we just created to reset the in-flight flag on settle.
    const pageRef = this.#pageRefs[this.#pageRefs.length - 1]!
    const onSettle = pageRef.subscribe(state => {
      if (state.status === 'success') {
        const data = (state.data ?? []) as unknown[]
        this.#hasMoreSticky = data.length >= this.#pageSize
        this.#isLoadingMore = false
        this.#loadMoreError = null
        onSettle()
        this.#onChange()
      } else if (state.status === 'error') {
        this.#isLoadingMore = false
        this.#loadMoreError = state.error
        // Keep hasMore truthy so the UI can offer a retry via loadMore again. Drop the
        // failed page so a future loadMore retries the same skip rather than skipping past.
        this.#hasMoreSticky = true
        this.#pageRefs.pop()
        const popped = this.#pageUnsubs.pop()
        popped?.()
        onSettle()
        this.#onChange()
      }
    })
  }

  snapshot(): RootSnapshot {
    if (this.#pageRefs.length === 0) return LOADING_ROOT

    const pageStates: QueryState<unknown, TMeta>[] = []
    for (const ref of this.#pageRefs) {
      const s = ref.getSnapshot()
      if (!s) return LOADING_ROOT
      pageStates.push(s)
    }
    // Surface the first page error.
    for (const s of pageStates) {
      if (s.status === 'error') {
        return { phase: 'error', rows: EMPTY_ROWS, isFetching: false, error: s.error }
      }
    }
    // The first page must have succeeded once before we present data. Follow-up pages
    // may still be loading: the accumulated rows cover what's been read so far, and
    // `isLoadingMore` signals the in-flight load.
    if (pageStates[0]!.status === 'loading') return LOADING_ROOT

    return {
      phase: 'ready',
      rows: this.#allPagesData(),
      isFetching: pageStates.some(s => s.isFetching),
      error: null,
    }
  }

  /** Memoized pagination block for the relational snapshot. */
  pagination(): RelationalPaginationState {
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
    const next: RelationalPaginationState = { hasMore, isLoadingMore, loadMoreError, totalCount }
    this.#lastPagination = next
    return next
  }

  /**
   * Refetch from page 0. Pages 1+ are dropped — they may now be invalid (the dataset
   * shifted). Page 0 stays so the existing UI doesn't blank out; the QueryStore
   * re-fetches it in place.
   */
  refetch(): void {
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
    this.#onChange()
  }

  teardown(): void {
    for (const unsub of this.#pageUnsubs) {
      unsub()
    }
    this.#pageUnsubs.length = 0
    this.#pageRefs.length = 0
  }

  /**
   * Total count from the first page's meta if `returnTotal: true` was set. Returns
   * `undefined` when the adapter didn't supply a total (e.g. Feathers `total: -1`).
   */
  #computeTotalCount(): number | undefined {
    if (!this.#returnTotal) return undefined
    const first = this.#pageRefs[0]
    if (!first) return undefined
    const s = first.getSnapshot()
    if (!s || s.status !== 'success') return undefined
    const meta = s.meta as { total?: number } | undefined
    if (!meta || typeof meta.total !== 'number' || meta.total < 0) return undefined
    return meta.total
  }

  /** Concatenate the data of all loaded pages. Stable identity across calls. */
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
}

// ---------------------------------------------------------------------------
// Relational assembly (pure)
// ---------------------------------------------------------------------------

/**
 * Pure relational assembly. Given root rows, the query AST, the schema, and a map of
 * already-gathered relation data (one entry per dotted relation key), produce the
 * denormalized tree. This module never reads live query state — the caller gathers
 * a coherent snapshot of every relation's data first and passes it in.
 */

/**
 * Resolved data for one relation key, gathered from the live sub-queries before
 * assembly runs.
 *
 * - `none` — relation has no source values (or no relationship definition).
 * - `fanIn` — single-hop relation resolved with one IN(...) query.
 * - `junction` — two-hop relation: junction rows plus destination rows.
 * - `perParent` — windowed relation resolved with one query per parent, keyed by
 *   `sourceValueKey(parentValue)`.
 */
type AssembledRelationData =
  | { kind: 'none' }
  | { kind: 'fanIn'; items: unknown[] }
  | { kind: 'junction'; items: unknown[]; junctionItems: unknown[] }
  | { kind: 'perParent'; byParent: Map<string, unknown[]> }

/**
 * Dedupe + sort + stable-encode a set of key values. The encoded key is what relation
 * subs compare to detect "same source set, nothing to re-fetch" — every sync path must
 * produce it identically or subscriptions churn.
 */
function sourceSet(raw: (string | number)[]): { values: (string | number)[]; key: string } {
  const values = [...new Set(raw)].sort()
  return { values, key: JSON.stringify(values) }
}

/** Collect the deduped, sorted values of `fields` across parents, with the stable key. */
function uniqueSourceValues(
  parentData: unknown[],
  fields: string[],
): { values: (string | number)[]; key: string } {
  return sourceSet(
    parentData
      .map(item => getFieldValue(item, fields))
      .filter((v): v is string | number => v !== undefined),
  )
}

/**
 * Read a list-of-ids field for `'embedded'` relations. The parent record is expected to
 * carry an array of `string | number` at `fields[0]`; non-array or missing values become
 * `undefined` so callers can treat them as "no edges from this parent". Compound keys are
 * not supported here — embedded relations are by definition single-key id lists.
 */
function getFieldValueAsList(item: unknown, fields: string[]): (string | number)[] | undefined {
  if (fields.length !== 1) return undefined
  const value = (item as Record<string, unknown>)[fields[0]!]
  if (!Array.isArray(value)) return undefined
  return value.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
}

/** Stable key for a parent source value (used by per-parent windowed relations). */
function sourceValueKey(value: string | number): string {
  return JSON.stringify(value)
}

interface RelationIndex {
  byKey?: Map<string | number, unknown>
  listByKey?: Map<string | number, unknown[]>
  junctionsByParent?: Map<string | number, unknown[]>
}

/**
 * Build per-relation lookup indexes over the gathered relation data so per-parent
 * matching during assembly is a map lookup instead of a linear scan — O(parents +
 * relation rows) per assembly pass rather than O(parents × relation rows).
 *
 * - `byKey` maps a dest-key value to the first matching entity ('one'/'embedded'/junction dest).
 * - `listByKey` groups entities by dest-key value in result order ('many').
 * - `junctionsByParent` groups junction rows by the parent-side join value (two-hop).
 */
function buildIndexes(
  ast: QueryAST,
  parentKey: string | null,
  relationships: Record<string, RelationshipDef>,
  relationData: Map<string, AssembledRelationData>,
): Map<string, RelationIndex> {
  const indexes = new Map<string, RelationIndex>()

  for (const relName of Object.keys(ast.related)) {
    const relDef = relationships[relName]
    if (!relDef) continue

    const key = parentKey ? `${parentKey}.${relName}` : relName
    const rel = relationData.get(key)
    // Per-parent data is already keyed by parent; 'none' has nothing to index.
    if (!rel || rel.kind === 'none' || rel.kind === 'perParent') continue

    if (rel.kind === 'junction') {
      const byKey = firstMatchIndex(rel.items, relDef.destField)
      const junctionsByParent = new Map<string | number, unknown[]>()
      for (const j of rel.junctionItems) {
        const p = getFieldValue(j, relDef.via!.destField)
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
      indexes.set(relName, { byKey: firstMatchIndex(rel.items, relDef.destField) })
    } else {
      const listByKey = new Map<string | number, unknown[]>()
      for (const entity of rel.items) {
        const k = getFieldValue(entity, relDef.destField)
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

// First match wins — mirrors a linear scan's short-circuit semantics.
function firstMatchIndex(items: unknown[], destField: string[]): Map<string | number, unknown> {
  const byKey = new Map<string | number, unknown>()
  for (const entity of items) {
    const k = getFieldValue(entity, destField)
    if (k !== undefined && !byKey.has(k)) byKey.set(k, entity)
  }
  return byKey
}

/**
 * Assemble the denormalized tree: for each root row, attach each declared relation's
 * matching rows (recursing into nested relations). Relations override same-named
 * fields on the parent — this is load-bearing for `embed`, where the parent's id-list
 * field expands into the materialized entities under the same key.
 */
function assembleRelations(
  items: unknown[],
  ast: QueryAST,
  schema: Schema,
  relationData: Map<string, AssembledRelationData>,
  parentKey: string | null = null,
): unknown[] {
  const relationships = schema.relationships?.[ast.service] ?? {}
  const indexes = buildIndexes(ast, parentKey, relationships, relationData)

  return items.map(item => {
    const result = { ...(item as object) } as Record<string, unknown>

    for (const [relName, relAST] of Object.entries(ast.related)) {
      const key = parentKey ? `${parentKey}.${relName}` : relName
      const relDef = relationships[relName]
      if (!relDef) continue

      const rel = relationData.get(key)
      const index = indexes.get(relName)
      const hasNested = Object.keys(relAST.related).length > 0

      let matchedItems: unknown[]

      if (rel?.kind === 'perParent') {
        const sourceValue = getFieldValue(item, relDef.sourceField)
        matchedItems =
          sourceValue === undefined ? [] : (rel.byParent.get(sourceValueKey(sourceValue)) ?? [])
      } else if (relDef.cardinality === 'embedded') {
        const sourceList = getFieldValueAsList(item, relDef.sourceField)
        matchedItems = []
        if (sourceList) {
          // Walk the parent's id list (preserves the server-chosen order) and look up
          // each id against the materialised dest set.
          for (const id of sourceList) {
            const found = index?.byKey?.get(id)
            if (found) matchedItems.push(found)
          }
        }
      } else if (relDef.via) {
        // Two-hop many: walk this parent's junction rows, then collect dest items
        // keyed by the junction's outgoing FK.
        const parentJoinValue = getFieldValue(item, relDef.via.sourceField)
        const junctions =
          parentJoinValue === undefined ? undefined : index?.junctionsByParent?.get(parentJoinValue)
        matchedItems = []
        if (junctions) {
          for (const j of junctions) {
            const destId = getFieldValue(j, relDef.sourceField)
            if (destId === undefined) continue
            const found = index?.byKey?.get(destId)
            if (found) matchedItems.push(found)
          }
        }
      } else if (relDef.cardinality === 'one') {
        const sourceValue = getFieldValue(item, relDef.sourceField)
        const found = sourceValue === undefined ? null : (index?.byKey?.get(sourceValue) ?? null)
        result[relName] = found
        if (hasNested && found) {
          const assembled = assembleRelations([found], relAST, schema, relationData, key)
          result[relName] = assembled[0] ?? null
        }
        continue
      } else {
        // Single-hop many — every entity whose dest key matches this parent.
        const sourceValue = getFieldValue(item, relDef.sourceField)
        matchedItems = sourceValue === undefined ? [] : (index?.listByKey?.get(sourceValue) ?? [])
      }

      if (hasNested && matchedItems.length > 0) {
        matchedItems = assembleRelations(matchedItems, relAST, schema, relationData, key)
      }
      result[relName] = matchedItems
    }

    return result
  })
}
