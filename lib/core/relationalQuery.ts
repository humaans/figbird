import { hashObject } from './hash.js'
import type { MatcherContext, PageSource } from '../adapters/adapter.js'
import { cursorQueryCanKeepPrefix, cursorQueryInputsUnchanged } from './cursorMaintenance.js'
import type { QueryAST } from './queryBuilder.js'
import { planRelation, planRootPagination, rootAllPages } from './queryClassification.js'
import type { QueryRef } from './queryRef.js'
import type { QueryLifecycleConfig } from './queryIdentity.js'
import type {
  ProcessedProjectionEvent,
  ProcessedCacheEvent,
  QueryConfig,
  QueryDescriptor,
  QueryGraphRef,
  ServiceState,
} from './queryTypes.js'
import {
  PagedQueryRoot,
  SingleQueryRoot,
  subscribeAndSeed,
  type PaginatedRootSource,
  type InspectedPagination,
  type RelationalPaginationState,
  type RootMetadata,
  type RootSource,
} from './queryRoots.js'
import {
  createRelationAssembler,
  getFieldValueAsList,
  relationKey,
  sourceSet,
  sourceValueKey,
  uniqueSourceValues,
  type AssembledRelationData,
} from './relationalAssembly.js'
import {
  collectRelationalFilterDependencies,
  collectRelationalFilterPaths,
  hasRelationalFilter,
  materializeRelationalFilterItem,
  shouldRefetchRelationalFilterQuery,
} from './relationalFilters.js'
import type { AnySchema, RelationshipDef, Schema } from './schema.js'
import { resolveServicePath } from './schema.js'
import { validateStaleTime } from './staleTime.js'

export type { RelationalPaginationState } from './queryRoots.js'

// This module is organised top-down: the consumer-facing RelationalQueryRef first,
// followed by its relation-subscription machinery. Root query execution lives in
// queryRoots.ts and the pure assembly pass lives in relationalAssembly.ts.

// Above this many parents, a windowed relation's per-parent queries are almost
// certainly the wrong shape (N requests for one screen) — warn and point at embed.
const WINDOWED_RELATION_FANOUT_WARN_THRESHOLD = 10

/**
 * The narrow contract the relational engine needs from a Figbird instance. Keeping
 * this structural (rather than importing the Figbird class) avoids a circular
 * dependency and states exactly what the engine relies on.
 */
export interface RelationalQueryHost<TParams, TMeta extends Record<string, unknown>, TQuery> {
  adapter: {
    matcher(
      query: TQuery | undefined,
      options?: unknown,
      context?: MatcherContext,
    ): (item: unknown) => boolean
    pageSource?(serviceName: string): PageSource<TParams, TMeta> | undefined
  }
  queryStore: {
    isObservabilityActive(): boolean
    subscribeToProcessedEvents(fn: (event: ProcessedCacheEvent) => void): () => void
    subscribeToProjectionSettlements(fn: (event: ProcessedProjectionEvent) => void): () => void
    ensureRealtimeSubscription(serviceName: string): () => void
    reapplyQuery(queryId: string, mutationLaneKeys: ReadonlySet<string>): void
  }
  getState(): Map<string, ServiceState<TMeta>>
  /** Returns a QueryRef; typed loosely here and re-typed once at the engine's seam. */
  queryDesc(
    desc: QueryDescriptor,
    config?: QueryConfig<unknown, unknown> & QueryLifecycleConfig,
  ): unknown
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
 * - `junction` — the first hop of a two-hop relation: the junction query itself.
 *   The destination is an ordinary fan-in whose "parents" are the junction rows,
 *   stored under `` `${key}#dest` `` (missing while the junction settles, `empty`
 *   when it resolved to zero edges) and re-synced from every junction success.
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
      sourceKey: string
      queryRef: QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery>
      unsub: () => void
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
type GatherResult = {
  kind: 'ready' | 'loading' | 'error'
  error: Error | null
  isFetching: boolean
  /** Data refs keyed for change detection (includes junction/per-parent sub-keys). */
  dataRefs: Map<string, unknown[] | null>
  /** Ready node data shaped for the pure assembly pass. */
  assembly: Map<string, AssembledRelationData>
}

type RelationalListener =
  | { source: 'subscriber'; staleTime: number }
  | { source: 'prefetch'; staleTime: number; adoptableUntil: number | null }
  | { source: 'prepare'; staleTime: number; preparationGeneration: number }

type PreparedAdoption =
  | { kind: 'idle'; adoptedThrough: number }
  | { kind: 'wave'; generation: number }

export interface InspectedRelationalQuery {
  key: string
  name?: string
  service: string
  ast: QueryAST
  pagination?: InspectedPagination
  /** Current assembled result when the relational query has settled successfully. */
  data?: unknown
  /** Mounted consumers, excluding internal prepare/prefetch pins. */
  subscriberCount?: number
  prefetchCount?: number
  prepareCount?: number
  nodes: Array<{
    path: string
    role?: 'junction'
    queryId: string
  }>
}

/** Internal escape hatch for consumers that need a custom root query boundary. */
export interface RelationalRootOverride {
  descriptor: QueryDescriptor
  config?: QueryConfig<unknown, unknown> & QueryLifecycleConfig
}

interface RelationalQueryOptions {
  defaultStaleTime?: number
  root?: RelationalRootOverride
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
  #host: RelationalQueryHost<TParams, TMeta, TQuery>
  #ast: QueryAST
  #schema: S
  #queryId: string
  #nextGraphRun = 1
  #graphRunId: string | null = null
  #graphCompletionScheduled = false

  // The root data source — a single find/get query, or a page accumulator for
  // `.paginate()` builders. `#pagedRoot` aliases the same object when paginated so
  // pagination-specific calls (loadMore, pagination block) don't need casts.
  #root: RootSource | null = null
  #pagedRoot: PaginatedRootSource | null = null

  // Per-relation state, keyed by dotted relation path (e.g. "comments" or
  // "comments.reactions"). A relation is "synced" once its entry exists here — even a
  // kind:'empty' entry counts, so loading detection doesn't hang on empty relations.
  #relationSubs: Map<string, RelationSub<S, TParams, TMeta, TQuery>> = new Map()
  #listeners: Map<(state: RelationalQueryState<T>) => void, RelationalListener> = new Map()
  #nextPreparationGeneration = 0
  #preparedAdoption: PreparedAdoption = { kind: 'idle', adoptedThrough: 0 }
  #processedEventUnsub: (() => void) | null = null
  #relationalFilterRefetchQueued = false
  // Strictest active subscriber freshness tolerance — applied to newly-created
  // internal subscriptions. Existing subscriptions are prodded through ensureFresh()
  // when each subscriber joins, so late strict readers are honored too.
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
  // The previous relation input is merged node-by-node with a partial gather. This
  // keeps an unresolved leaf stale without rolling back unrelated optimistic edges.
  #lastRelationAssembly: Map<string, AssembledRelationData> | null = null
  #lastGatherWasPartial = false
  #assembleRelations: ReturnType<typeof createRelationAssembler> | null = null

  // Suspense-support state. The promise is created lazily when suspensePromise() is
  // first called and resolves/rejects on the first transition to success/error. Once
  // settled, no new promise is created for this qRef instance — a cold start happens
  // exactly once.
  #suspensePromise: Promise<void> | null = null
  #resolveSuspense: (() => void) | null = null
  #rejectSuspense: ((error: Error) => void) | null = null
  #suspenseSettled = false
  // A Suspense read materializes and fetches the graph before React can commit its
  // subscription. The first committed listener claims that fetch instead of treating
  // the just-resolved data as stale and immediately repeating the whole graph.
  #coldStartAwaitingSubscriber = false

  // Relation keys that already produced a fan-out warning — warn once per relation,
  // not on every sync pass.
  #fanOutWarnedKeys: Set<string> = new Set()

  #onEvict: (() => void) | null = null
  #defaultStaleTime: number
  #name: string | undefined
  #rootOverride: RelationalRootOverride | null

  constructor(
    host: RelationalQueryHost<TParams, TMeta, TQuery>,
    ast: QueryAST,
    schema: S,
    onEvict?: () => void,
    options?: RelationalQueryOptions,
  ) {
    this.#host = host
    this.#ast = ast
    this.#schema = schema
    this.#queryId = `rq/${hashObject(options?.root ? { ast, root: options.root } : ast)}`
    this.#onEvict = onEvict ?? null
    this.#defaultStaleTime = options?.defaultStaleTime ?? 0
    this.#rootOverride = options?.root ?? null
  }

  /** Returns internal details of this query reference (for debugging/testing). */
  details(): { queryId: string; ast: QueryAST; name?: string } {
    return {
      queryId: this.#queryId,
      ast: this.#ast,
      ...(this.#name ? { name: this.#name } : {}),
    }
  }

  /** Attach best-effort display metadata. It is never part of query identity. */
  setDisplayName(name: string | undefined): void {
    if (name && !this.#name) {
      this.#name = name
    }
  }

  /** Stable devtools projection for the store-level queries backing this ref. */
  inspect(): InspectedRelationalQuery {
    const nodes: InspectedRelationalQuery['nodes'] = []
    for (const queryId of this.#root?.queryIds() ?? []) {
      nodes.push({ path: '(root)', queryId })
    }
    for (const [path, sub] of this.#relationSubs) {
      switch (sub.kind) {
        case 'empty':
          break
        case 'fanIn':
          nodes.push({
            path: path.endsWith('#dest') ? path.slice(0, -'#dest'.length) : path,
            queryId: sub.queryRef.details().queryId,
          })
          break
        case 'junction':
          nodes.push({ path, role: 'junction', queryId: sub.queryRef.details().queryId })
          break
        case 'perParent':
          for (const child of sub.children.values()) {
            nodes.push({ path, queryId: child.queryRef.details().queryId })
          }
          break
      }
    }
    const snapshot = this.getSnapshot()
    const listenerMetadata = [...this.#listeners.values()]
    return {
      key: this.#queryId,
      ...(this.#name ? { name: this.#name } : {}),
      service: this.#ast.service,
      ast: this.#ast,
      ...(this.#pagedRoot ? { pagination: this.#pagedRoot.inspectPagination() } : {}),
      ...(snapshot.status === 'success' ? { data: snapshot.data } : {}),
      subscriberCount: listenerMetadata.filter(({ source }) => source === 'subscriber').length,
      prefetchCount: listenerMetadata.filter(({ source }) => source === 'prefetch').length,
      prepareCount: listenerMetadata.filter(({ source }) => source === 'prepare').length,
      nodes,
    }
  }

  /** Returns a stable hash representing the query AST. */
  hash(): string {
    return this.#queryId
  }

  /**
   * The builder kind this ref was interned from — how consumers (the hooks' result
   * projection) learn a ref is paginated without reaching back into the builder.
   */
  kind(): QueryAST['kind'] {
    return this.#ast.kind
  }

  /** Adapter-neutral metadata for the root query, excluding relation-only updates. */
  rootMetadata(): RootMetadata {
    return this.#root?.metadata() ?? { pageInfo: undefined, total: undefined, revision: undefined }
  }

  /**
   * The host returns adapter-typed refs; the engine re-types them once here at its
   * only construction seam instead of casting at every call site.
   */
  #query(
    desc: QueryDescriptor,
    config: QueryConfig<unknown, unknown> & QueryLifecycleConfig,
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
    options?: {
      staleTime?: number | undefined
      /** @internal Identifies non-UI pins in devtools. */
      source?: 'subscriber' | 'prepare' | 'prefetch'
    },
  ): () => void {
    const source = options?.source ?? 'subscriber'
    const staleTime =
      options?.staleTime === undefined
        ? this.#defaultStaleTime
        : validateStaleTime(options.staleTime, 'query(): staleTime')
    const listener: RelationalListener =
      source === 'prepare'
        ? {
            source,
            staleTime,
            preparationGeneration: ++this.#nextPreparationGeneration,
          }
        : source === 'prefetch'
          ? { source, staleTime, adoptableUntil: Date.now() + staleTime }
          : { source, staleTime }
    // Preparation makes one freshness decision for the destination's initial React
    // commit. Every subscriber in that synchronous wave adopts it; later mounts use
    // their own staleTime even if the router keeps the preparation pinned.
    const adoptsPreparation = source === 'subscriber' && this.#claimPreparedAdoption()
    const adoptsPrefetch = source === 'prepare' && this.#claimPrefetch()
    const claimsColdStart = this.#coldStartAwaitingSubscriber
    this.#listeners.set(fn, listener)
    this.#staleTime = this.#currentStaleTime()

    if (!this.#root) {
      this.#setupRoot()
    } else {
      this.#root.setStaleTime(this.#staleTime)
      if (claimsColdStart) {
        // React StrictMode may subscribe, unsubscribe, and resubscribe in one turn.
        // Keep the claim window open through that commit so neither subscription
        // mistakes the Suspense fetch for stale data.
        queueMicrotask(() => {
          this.#coldStartAwaitingSubscriber = false
        })
      } else if (!adoptsPreparation) {
        // Adopt the speculative read once, but still retry errors and pending
        // invalidations. An explicit preparation staleTime takes precedence.
        this.#ensureFresh(adoptsPrefetch && options?.staleTime === undefined ? Infinity : staleTime)
      }
    }

    // Don't call fn synchronously - useSyncExternalStore will call getSnapshot() instead

    return () => {
      this.#listeners.delete(fn)
      this.#staleTime = this.#currentStaleTime()
      this.#root?.setStaleTime(this.#staleTime)

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

  #currentStaleTime(): number {
    if (this.#listeners.size === 0) return 0
    let staleTime = Infinity
    for (const listener of this.#listeners.values()) {
      staleTime = Math.min(staleTime, listener.staleTime)
    }
    return staleTime
  }

  #claimPreparedAdoption(): boolean {
    const adoption = this.#preparedAdoption
    const adoptedThrough = adoption.kind === 'wave' ? adoption.generation : adoption.adoptedThrough
    let newestActive = adoptedThrough
    for (const listener of this.#listeners.values()) {
      if (listener.source === 'prepare') {
        newestActive = Math.max(newestActive, listener.preparationGeneration)
      }
    }

    if (newestActive > adoptedThrough) {
      this.#preparedAdoption = { kind: 'wave', generation: newestActive }
      queueMicrotask(() => {
        const current = this.#preparedAdoption
        if (current.kind === 'wave' && current.generation === newestActive) {
          this.#preparedAdoption = { kind: 'idle', adoptedThrough: newestActive }
        }
      })
    }

    return this.#preparedAdoption.kind === 'wave'
  }

  #claimPrefetch(): boolean {
    const now = Date.now()
    let claimed = false
    for (const listener of this.#listeners.values()) {
      if (listener.source === 'prefetch' && listener.adoptableUntil !== null) {
        claimed ||= now < listener.adoptableUntil
        listener.adoptableUntil = null
      }
    }
    return claimed
  }

  #beginGraphRun(): string | null {
    if (!this.#host.queryStore.isObservabilityActive()) {
      this.#graphRunId = null
      return null
    }
    const runId = `${this.#queryId}:${this.#nextGraphRun++}`
    this.#graphRunId = runId
    return runId
  }

  #graph(path: string, role?: QueryGraphRef['role']): QueryGraphRef | undefined {
    if (!this.#graphRunId) return undefined
    return {
      operationId: this.#queryId,
      runId: this.#graphRunId,
      path,
      ...(role ? { role } : {}),
    }
  }

  #ensureFresh(staleTime: number): void {
    if (!this.#graphRunId) this.#beginGraphRun()
    this.#root?.ensureFresh(staleTime, this.#graph('(root)'))
    for (const sub of this.#relationSubs.values()) {
      this.#ensureRelationSubFresh(sub, staleTime)
    }
    this.#scheduleGraphRunCompletion(this.getSnapshot())
  }

  #ensureRelationSubFresh(sub: RelationSub<S, TParams, TMeta, TQuery>, staleTime: number): void {
    switch (sub.kind) {
      case 'empty':
        return
      case 'fanIn':
        sub.queryRef.ensureFresh({ staleTime, graph: this.#graph(this.#pathForSub(sub)) })
        return
      case 'junction':
        sub.queryRef.ensureFresh({
          staleTime,
          graph: this.#graph(this.#pathForSub(sub), 'junction'),
        })
        return
      case 'perParent':
        for (const child of sub.children.values()) {
          child.queryRef.ensureFresh({ staleTime, graph: this.#graph(this.#pathForSub(sub)) })
        }
    }
  }

  #pathForSub(target: RelationSub<S, TParams, TMeta, TQuery>): string {
    for (const [path, sub] of this.#relationSubs) {
      if (sub === target) return path.endsWith('#dest') ? path.slice(0, -'#dest'.length) : path
    }
    return '(unknown)'
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

    const gathered = this.#gatherRelationData()
    if (gathered.kind === 'loading' && this.#lastSnapshot?.status !== 'success') {
      return this.#fetchingSnapshot()
    }
    if (gathered.kind === 'error' && this.#lastSnapshot?.status !== 'success') {
      return this.#errorSnapshot(gathered.error!)
    }

    const assembly = this.#mergeRelationAssembly(gathered.assembly)
    const becameComplete = this.#lastGatherWasPartial && gathered.kind === 'ready'
    const isFetching = root.isFetching || gathered.isFetching
    const error =
      gathered.kind === 'error'
        ? gathered.error
        : gathered.kind === 'loading' && this.#lastSnapshot?.status === 'success'
          ? this.#lastSnapshot.error
          : null

    // Decide whether the assembled output could have changed. Reassemble if root data
    // or any relation data ref has changed. This is what lets realtime events on
    // relation services propagate into the assembled view: a new matching comment
    // mutates the comments query's data ref → we reassemble → the new comment appears
    // under the right issue.
    let inputsChanged =
      becameComplete ||
      this.#lastRootData !== root.rows ||
      this.#lastRelationData.size !== gathered.dataRefs.size
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
      this.#lastSnapshot.error === error &&
      this.#lastSnapshot.isFetching === isFetching
    ) {
      return this.#wrap(this.#lastSnapshot)
    }

    const data =
      !inputsChanged && this.#lastSnapshot?.status === 'success'
        ? this.#lastSnapshot.data
        : this.#assemble(root.rows, assembly)

    this.#lastRootData = root.rows
    this.#lastRelationData = gathered.dataRefs
    this.#lastRelationAssembly = assembly
    this.#lastGatherWasPartial = gathered.kind !== 'ready'
    this.#lastSnapshot = {
      status: 'success',
      data,
      error,
      isFetching,
    }

    return this.#wrap(this.#lastSnapshot)
  }

  /**
   * While the root is fetching but we already have a successful snapshot, keep it on
   * screen. Relation loading is handled node-by-node in #gatherRelationData instead.
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

  #mergeRelationAssembly(
    current: Map<string, AssembledRelationData>,
  ): Map<string, AssembledRelationData> {
    if (!this.#lastRelationAssembly) return current
    const merged = new Map(this.#lastRelationAssembly)
    for (const [key, value] of current) merged.set(key, value)
    return merged
  }

  #assemble(rootRows: unknown[], assembly: Map<string, AssembledRelationData>): T {
    this.#assembleRelations ??= createRelationAssembler(this.#ast, this.#schema)
    const assembled = this.#assembleRelations(rootRows, assembly)
    return this.#ast.kind !== 'paginate' && this.#ast.cardinality === 'one'
      ? ((assembled[0] ?? null) as T)
      : (assembled as unknown as T)
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
   * Walk the query AST collecting every relation's current data. Loading and errors
   * are aggregate state, not short-circuits: ready siblings and parent edges remain
   * available for assembly while one leaf settles. The caller overlays this partial
   * assembly onto the previous one, giving relational queries node-level SWR rather
   * than rolling the entire graph back.
   */
  #gatherRelationData(
    ast: QueryAST = this.#ast,
    parentKey: string | null = null,
    acc: {
      kind: GatherResult['kind']
      error: Error | null
      isFetching: boolean
      dataRefs: Map<string, unknown[] | null>
      assembly: Map<string, AssembledRelationData>
    } = {
      kind: 'ready',
      error: null,
      isFetching: false,
      dataRefs: new Map(),
      assembly: new Map(),
    },
  ): GatherResult {
    const loading = () => {
      if (acc.kind === 'ready') acc.kind = 'loading'
      acc.isFetching = true
    }
    const failed = (error: Error) => {
      acc.kind = 'error'
      acc.error ??= error
    }
    const relationships = this.#schema.relationships?.[ast.service] ?? {}
    for (const [relName, relAST] of Object.entries(ast.related)) {
      const key = relationKey(parentKey, relName)
      const sub = this.#relationSubs.get(key)

      if (!relationships[relName]) {
        // Missing relationship definition was warned about in sync, which parks an
        // 'empty' sub so rendering doesn't block on it.
        if (sub) {
          acc.dataRefs.set(key, null)
          acc.assembly.set(key, { kind: 'none' })
        }
        continue
      }

      // Relations are synced lazily from parent success; a declared relation whose
      // sub doesn't exist yet simply hasn't been reached — the snapshot is loading.
      if (!sub) {
        acc.dataRefs.set(key, null)
        loading()
        continue
      }

      switch (sub.kind) {
        case 'empty': {
          // No parent rows ⇒ no nested subs exist either; nothing to recurse into.
          acc.dataRefs.set(key, null)
          acc.assembly.set(key, { kind: 'none' })
          break
        }
        case 'fanIn': {
          const s = sub.queryRef.getSnapshot()
          if (!s || s.status === 'loading') {
            acc.dataRefs.set(key, null)
            loading()
            continue
          }
          if (s.status === 'error') {
            acc.dataRefs.set(key, null)
            failed(s.error)
            continue
          }
          acc.isFetching ||= s.isFetching
          acc.dataRefs.set(key, s.data as unknown[])
          acc.assembly.set(key, { kind: 'fanIn', items: s.data as unknown[] })
          this.#gatherRelationData(relAST, key, acc)
          break
        }
        case 'junction': {
          const js = sub.queryRef.getSnapshot()
          if (!js || js.status === 'loading') {
            acc.dataRefs.set(`${key}#junction`, null)
            acc.dataRefs.set(key, null)
            loading()
            continue
          }
          if (js.status === 'error') {
            acc.dataRefs.set(`${key}#junction`, null)
            acc.dataRefs.set(key, null)
            failed(js.error)
            continue
          }
          acc.isFetching ||= js.isFetching
          acc.dataRefs.set(`${key}#junction`, js.data as unknown[])

          // The destination is a fan-in over the junction rows, living at its own key.
          const destSub = this.#relationSubs.get(`${key}#dest`)
          if (destSub?.kind === 'empty') {
            acc.dataRefs.set(key, null)
            acc.assembly.set(key, {
              kind: 'junction',
              items: [],
              junctionItems: js.data as unknown[],
            })
            break
          }
          if (!destSub) {
            acc.dataRefs.set(key, null)
            acc.assembly.set(key, this.#pendingJunctionAssembly(key, js.data as unknown[]))
            loading()
            continue
          }
          if (destSub.kind !== 'fanIn') break
          const ds = destSub.queryRef.getSnapshot()
          if (!ds || ds.status === 'loading') {
            acc.dataRefs.set(key, null)
            acc.assembly.set(key, this.#pendingJunctionAssembly(key, js.data as unknown[]))
            loading()
            continue
          }
          if (ds.status === 'error') {
            acc.dataRefs.set(key, null)
            acc.assembly.set(key, this.#pendingJunctionAssembly(key, js.data as unknown[]))
            failed(ds.error)
            continue
          }
          acc.isFetching ||= ds.isFetching
          acc.dataRefs.set(key, ds.data as unknown[])
          acc.assembly.set(key, {
            kind: 'junction',
            items: ds.data as unknown[],
            junctionItems: js.data as unknown[],
          })
          this.#gatherRelationData(relAST, key, acc)
          break
        }
        case 'perParent': {
          acc.dataRefs.set(key, null)
          const previous = this.#lastRelationAssembly?.get(key)
          const byParent = new Map<string, unknown[]>()
          for (const [childKey, child] of sub.children) {
            const s = child.queryRef.getSnapshot()
            if (!s || s.status === 'loading') {
              acc.dataRefs.set(`${key}#parent:${childKey}`, null)
              const stale = previous?.kind === 'perParent' ? previous.byParent.get(childKey) : null
              if (stale) byParent.set(childKey, stale)
              loading()
              continue
            }
            if (s.status === 'error') {
              acc.dataRefs.set(`${key}#parent:${childKey}`, null)
              const stale = previous?.kind === 'perParent' ? previous.byParent.get(childKey) : null
              if (stale) byParent.set(childKey, stale)
              failed(s.error)
              continue
            }
            acc.isFetching ||= s.isFetching
            acc.dataRefs.set(`${key}#parent:${childKey}`, s.data as unknown[])
            byParent.set(childKey, s.data as unknown[])
          }
          acc.assembly.set(key, { kind: 'perParent', byParent })
          this.#gatherRelationData(relAST, key, acc)
          break
        }
      }
    }

    return acc
  }

  #pendingJunctionAssembly(key: string, junctionItems: unknown[]): AssembledRelationData {
    const previous = this.#lastRelationAssembly?.get(key)
    return {
      kind: 'junction',
      items: previous?.kind === 'junction' ? previous.items : [],
      junctionItems,
    }
  }

  /**
   * Refetch the whole graph. The root and every currently materialized relation leaf
   * are independent store queries, so refreshing only the root can leave relation-only
   * server changes invisible (especially for snapshot queries).
   */
  refetch(): void {
    this.#beginGraphRun()
    this.#root?.refetch(this.#graph('(root)'))
    const seen = new Set<QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery>>()
    for (const sub of this.#relationSubs.values()) {
      switch (sub.kind) {
        case 'empty':
          break
        case 'fanIn':
          if (!seen.has(sub.queryRef)) {
            seen.add(sub.queryRef)
            sub.queryRef.refetch({ graph: this.#graph(this.#pathForSub(sub)) })
          }
          break
        case 'junction':
          if (!seen.has(sub.queryRef)) {
            seen.add(sub.queryRef)
            sub.queryRef.refetch({
              graph: this.#graph(this.#pathForSub(sub), 'junction'),
            })
          }
          break
        case 'perParent':
          for (const child of sub.children.values()) {
            if (seen.has(child.queryRef)) continue
            seen.add(child.queryRef)
            child.queryRef.refetch({ graph: this.#graph(this.#pathForSub(sub)) })
          }
          break
      }
    }
    this.#scheduleGraphRunCompletion(this.getSnapshot())
  }

  /** Append the next page (paginated queries only; no-op otherwise). */
  loadMore(): void {
    this.#beginGraphRun()
    this.#pagedRoot?.loadMore(this.#graph('(root)'))
    this.#scheduleGraphRunCompletion(this.getSnapshot())
  }

  #setupRoot(): void {
    this.#beginGraphRun()
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
      const pageSource = this.#host.adapter.pageSource?.(serviceName)
      const paginationPlan = planRootPagination(pageSource !== undefined, Boolean(this.#ast.server))
      const sequential = paginationPlan.kind === 'sequential'
      const cursorRealtime =
        sequential &&
        pageSource?.cursorStability === 'ordering' &&
        !this.#ast.server &&
        !this.#ast.snapshot &&
        cursorQueryCanKeepPrefix(this.#ast.query)
          ? {
              subscribe: (fn: (event: ProcessedCacheEvent) => void) =>
                this.#host.queryStore.subscribeToProcessedEvents(event => {
                  if (event.serviceName === serviceName) fn(event)
                }),
              canKeepPrefix: (event: ProcessedCacheEvent) =>
                !this.#ast.server &&
                (event.type === 'patched' || event.type === 'updated') &&
                event.previousItem !== null &&
                cursorQueryInputsUnchanged(this.#ast.query, event.previousItem, event.item),
            }
          : undefined
      const rootGraph = this.#graph('(root)')
      this.#pagedRoot = new PagedQueryRoot<S, TParams, TMeta, TQuery>({
        pageSize,
        includeTotal: Boolean(this.#ast.includeTotal),
        sequential,
        realtime: this.#ast.snapshot
          ? 'manual'
          : sequential && !cursorRealtime
            ? 'reconcile'
            : this.#ast.server
              ? 'reconcile'
              : 'merge-or-reconcile',
        staleTime: this.#staleTime,
        ...(rootGraph ? { graph: rootGraph } : {}),
        makePageRef: (pageIndex, after) =>
          this.#query(
            sequential
              ? {
                  serviceName,
                  method: 'find',
                  params: { query: this.#ast.query },
                  page: {
                    limit: pageSize,
                    ...(after !== undefined ? { after } : {}),
                    includeTotal: Boolean(this.#ast.includeTotal) && pageIndex === 0,
                  },
                }
              : {
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
              realtime: sequential
                ? cursorRealtime
                  ? 'disabled'
                  : !this.#ast.snapshot && pageIndex === 0
                    ? 'refetch'
                    : 'disabled'
                : this.#realtimeMode,
              fetchPolicy: 'swr',
              ...(paginationPlan.server ? { server: true } : {}),
              ...matcherConfig,
            },
          ),
        onRows,
        onChange,
        ...(cursorRealtime ? { cursorRealtime } : {}),
      })
      this.#root = this.#pagedRoot
      this.#scheduleGraphRunCompletion(this.getSnapshot())
      return
    }

    const rootDesc: QueryDescriptor = this.#rootOverride
      ? this.#rootOverride.descriptor
      : this.#ast.kind === 'get'
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

    const rootGraph = this.#graph('(root)')
    this.#root = new SingleQueryRoot<S, TParams, TMeta, TQuery>({
      queryRef: this.#query(rootDesc, {
        realtime: this.#realtimeMode,
        fetchPolicy: 'swr',
        // .all() fetches every page (rootAllPages — shared with explain()); when
        // unfiltered, success marks the service fully materialized.
        ...(rootAllPages(this.#ast.kind) ? { allPages: true } : {}),
        ...(this.#ast.kind !== 'get' ? matcherConfig : {}),
        ...(this.#ast.server ? { server: true } : {}),
        ...this.#rootOverride?.config,
      }),
      isGet: this.#ast.kind === 'get',
      onRows,
      onChange,
      staleTime: this.#staleTime,
      ...(rootGraph ? { graph: rootGraph } : {}),
    })
    this.#scheduleGraphRunCompletion(this.getSnapshot())
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
      const key = relationKey(parentKey, relName)
      const relDef = relationships[relName]
      if (!relDef) {
        console.warn(`Relationship "${relName}" not found for service "${ast.service}"`)
        // Mark as synced with no query so loading detection doesn't hang.
        if (!this.#relationSubs.has(key)) {
          this.#relationSubs.set(key, { kind: 'empty', sourceKey: '' })
        }
      } else {
        // The strategy is decided in one place (planRelation) — explain() reads
        // the same plan, so what it reports is what runs here.
        const { strategy } = planRelation(relDef, relAST.query)
        if (strategy === 'junction') {
          this.#syncJunctionRelation(parentData, relDef, relAST, key)
        } else if (strategy === 'perParent') {
          this.#syncWindowedManyRelation(parentData, relDef, relAST, key)
        } else {
          this.#syncFanInRelation(parentData, relDef, relAST, key)
        }
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
   * IN(...) query on `destField` keyed by the parents' source values. Also the second
   * hop of two-hop relations: the junction sync re-enters here with the junction rows
   * as `parentData`, the sub stored at `` `${subKey}#dest` `` but nested relations
   * still keyed under the relation's own `nestedKey`.
   */
  #syncFanInRelation(
    parentData: unknown[],
    relDef: RelationshipDef,
    relAST: QueryAST,
    subKey: string,
    nestedKey: string = subKey,
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

    const existing = this.#relationSubs.get(subKey)
    if (
      (existing?.kind === 'fanIn' || existing?.kind === 'empty') &&
      existing.sourceKey === sourceKey
    ) {
      // Already synced for this exact set of source values. Still need to recurse into
      // nested relations in case this relation's data already resolved and its own
      // children need to be synced.
      if (existing.kind === 'fanIn') {
        this.#syncNestedFromSnapshot(existing.queryRef, relAST, nestedKey)
      }
      return
    }

    // Dispose old subscription (if source values changed or entry didn't exist)
    if (existing) this.#disposeRelationSub(existing, subKey)

    if (values.length === 0) {
      this.#relationSubs.set(subKey, { kind: 'empty', sourceKey })
      return
    }

    const queryRef = this.#buildRelationQueryRef(relDef.destService, relDef, relAST, values)
    const unsub = subscribeAndSeed(
      queryRef,
      data => this.#syncNested(data, relAST, nestedKey),
      () => this.#notifyListeners(),
      this.#staleTime,
      this.#graph(nestedKey),
    )

    this.#relationSubs.set(subKey, { kind: 'fanIn', sourceKey, queryRef, unsub })
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

    if (existing && existing.kind !== 'perParent') this.#disposeRelationSub(existing, key)

    if (uniqueValues.length === 0) {
      if (existing?.kind === 'perParent') this.#disposeRelationSub(existing, key)
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

    const entry: Extract<
      RelationSub<S, TParams, TMeta, TQuery>,
      { kind: 'perParent' }
    > = existing?.kind === 'perParent'
      ? existing
      : { kind: 'perParent', sourceKey: newSourceKey, children: new Map() }
    entry.sourceKey = newSourceKey
    const previousChildren = entry.children
    entry.children = new Map()
    this.#relationSubs.set(key, entry)

    for (const sourceValue of uniqueValues) {
      const childKey = sourceValueKey(sourceValue)
      const retained = previousChildren.get(childKey)
      if (retained) {
        entry.children.set(childKey, retained)
        continue
      }
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
        { staleTime: this.#staleTime, graph: this.#graph(key) },
      )

      entry.children.set(childKey, { queryRef, unsub, sourceValue })
    }

    for (const [childKey, child] of previousChildren) {
      if (!entry.children.has(childKey)) child.unsub()
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

    // Same parent set: the junction is already up to date. Phase 2 re-syncs from its
    // current snapshot — the fan-in's own sourceKey check makes it a no-op when the
    // dest set hasn't changed, and it recurses into nested relations either way.
    if (existing?.kind === 'junction' && existing.sourceKey === junctionSourceKey) {
      this.#syncDestFromJunction(existing.queryRef, relDef, relAST, key)
      return
    }

    // Dispose previous subs — both junction and dest — before rebuilding.
    if (existing) this.#disposeRelationSub(existing, key)

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
            [via.destField]: { $in: uniqueParentIds },
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

    // Phase 2 is the shared fan-in reconcile with the junction rows as parents: the
    // dest sub lives at `${key}#dest` and its nested relations key under `key`.
    const unsub = subscribeAndSeed(
      junctionRef,
      junctionItems => this.#syncFanInRelation(junctionItems, relDef, relAST, `${key}#dest`, key),
      () => this.#notifyListeners(),
      this.#staleTime,
      this.#graph(key, 'junction'),
    )
    this.#relationSubs.set(key, {
      kind: 'junction',
      sourceKey: junctionSourceKey,
      queryRef: junctionRef,
      unsub,
    })
  }

  /** Phase 2 from the junction's current snapshot, for an already-live junction sub. */
  #syncDestFromJunction(
    junctionRef: QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery>,
    relDef: RelationshipDef,
    relAST: QueryAST,
    key: string,
  ): void {
    const s = junctionRef.getSnapshot()
    if (s?.status === 'success') {
      this.#syncFanInRelation(s.data as unknown[], relDef, relAST, `${key}#dest`, key)
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
    relDef: RelationshipDef,
    relAST: QueryAST,
    uniqueValues: (string | number)[],
  ): QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery> {
    const hasExplicitSort = '$sort' in relAST.query || '$sort' in (relDef.query ?? {})
    // A fully materialized service can answer filtered finds locally only when their
    // order is deterministic. These relation shapes do not expose destination-query
    // order (assembly follows the parent id list / junction rows, or selects one), so
    // an internal key sort is semantics-preserving and unlocks an immediate cache hit.
    // Direct `many` keeps backend order unless the consumer supplied one.
    const deterministicSort =
      !hasExplicitSort &&
      (relDef.cardinality === 'one' || relDef.cardinality === 'embedded' || Boolean(relDef.via))
        ? { $sort: { [relDef.destField]: 1 } }
        : {}
    const query = {
      ...relAST.query,
      ...deterministicSort,
      [relDef.destField]: { $in: uniqueValues },
      ...(relDef.query || {}),
    }

    // allPages comes from the shared fetch plan (see planRelation): un-windowed
    // relations drain every page so the IN(...) set isn't truncated; an explicit
    // window is the consumer's intent and stays server-maintained.
    const { allPages } = planRelation(relDef, relAST.query)

    return this.#query(
      {
        serviceName: resolveServicePath(this.#schema, destService),
        method: 'find',
        params: { query },
      },
      {
        realtime: this.#realtimeMode,
        fetchPolicy: 'swr',
        ...(allPages ? { allPages: true } : {}),
        ...(relAST.server ? { server: true } : {}),
      },
    )
  }

  #buildSingleParentRelationQueryRef(
    destService: string,
    relDef: { destField: string; query?: Record<string, unknown> },
    relAST: QueryAST,
    sourceValue: string | number,
  ): QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery> {
    const query = {
      ...relAST.query,
      [relDef.destField]: sourceValue,
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

  /**
   * Tear down one relation sub. `key` is the sub's map key when known — a junction
   * disposed by key takes its `${key}#dest` fan-in with it. (`#cleanup` iterates the
   * whole map without keys instead: every dest entry is disposed exactly once there
   * through its own map entry.)
   */
  #disposeRelationSub(sub: RelationSub<S, TParams, TMeta, TQuery>, key?: string): void {
    switch (sub.kind) {
      case 'empty':
        return
      case 'fanIn':
        sub.unsub()
        return
      case 'junction': {
        sub.unsub()
        if (key) {
          const destKey = `${key}#dest`
          const dest = this.#relationSubs.get(destKey)
          if (dest) {
            this.#disposeRelationSub(dest, destKey)
            this.#relationSubs.delete(destKey)
          }
        }
        return
      }
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
    const paths = collectRelationalFilterPaths(this.#schema, this.#ast.service, this.#ast.query)
    const dependencies = collectRelationalFilterDependencies(this.#schema, this.#ast, paths)
    if (dependencies.length === 0) return

    const releaseDependencies = dependencies.map(dependency =>
      this.#host.queryStore.ensureRealtimeSubscription(dependency.serviceName),
    )

    const affectsFilter = (event: ProcessedCacheEvent) =>
      shouldRefetchRelationalFilterQuery(
        this.#schema,
        this.#host.getState(),
        this.#ast,
        paths,
        dependencies,
        event,
      )

    const unsubscribeEvents = this.#host.queryStore.subscribeToProcessedEvents(event => {
      if (!affectsFilter(event)) return
      if (event.mode !== 'server') {
        const laneKeys =
          event.mode === 'optimistic' ? new Set([event.mutationLaneKey]) : new Set<string>()
        for (const queryId of this.#root?.queryIds() ?? []) {
          this.#host.queryStore.reapplyQuery(queryId, laneKeys)
        }
        return
      }
      this.#queueRelationalFilterRefetch()
    })
    const unsubscribeSettlements = this.#host.queryStore.subscribeToProjectionSettlements(event => {
      if (affectsFilter(event)) this.#queueRelationalFilterRefetch()
    })
    this.#processedEventUnsub = () => {
      unsubscribeEvents()
      unsubscribeSettlements()
      for (const release of releaseDependencies) release()
    }
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
      const match = this.#host.adapter.matcher(query as TQuery | undefined, undefined, {
        serviceName: resolveServicePath(this.#schema, ast.service),
      })
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
    for (const listener of this.#listeners.keys()) {
      listener(snapshot)
    }
    this.#scheduleGraphRunCompletion(snapshot)
  }

  #scheduleGraphRunCompletion(snapshot: RelationalQueryState<T>): void {
    if (!this.#graphRunId || snapshot.isFetching || this.#graphCompletionScheduled) return
    const runId = this.#graphRunId
    this.#graphCompletionScheduled = true
    queueMicrotask(() => {
      this.#graphCompletionScheduled = false
      if (this.#graphRunId !== runId) return
      const current = this.getSnapshot()
      if (!current.isFetching) this.#graphRunId = null
    })
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
   * Called by React hooks when a suspense-started render is abandoned before commit.
   * No subscriber ever attaches in that path, so the listener-count eviction can't
   * fire. Deferring by a microtask (the same trick subscribe teardown uses) lets any
   * component that *did* commit cancel the eviction by holding a subscription; after
   * eviction, a retry interns a fresh ref and cold-starts.
   */
  releaseColdStart(): void {
    if (this.#suspenseSettled && this.#listeners.size === 0) {
      this.#scheduleCleanup()
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
      if (!this.#root) {
        this.#coldStartAwaitingSubscriber = this.#listeners.size === 0
        this.#setupRoot()
      }
      // If we've already reached a terminal state synchronously, settle immediately.
      this.#settleSuspense(this.getSnapshot())
    }
    return this.#suspensePromise
  }

  /** @internal Release readers and pending Suspense work when the instance closes. */
  dispose(): void {
    this.#rejectSuspense?.(new Error('figbird: instance has been disposed'))
    this.#listeners.clear()
    this.#cleanup()
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
    this.#lastRelationAssembly = null
    this.#lastGatherWasPartial = false
    this.#assembleRelations = null
    this.#staleTime = 0
    if (this.#preparedAdoption.kind === 'wave') {
      this.#preparedAdoption = {
        kind: 'idle',
        adoptedThrough: this.#preparedAdoption.generation,
      }
    }
    // Evict from the figbird-level cache so a subsequent query rebuilds a fresh ref.
    // Reset the suspense promise state too — a fresh cold-start will need a fresh promise.
    this.#suspensePromise = null
    this.#resolveSuspense = null
    this.#rejectSuspense = null
    this.#suspenseSettled = false
    this.#coldStartAwaitingSubscriber = false
    this.#onEvict?.()
  }
}

/**
 * Combine several refs' cold-start promises into one aggregate suspension for a
 * multi-query hook. Calling `suspensePromise()` on each ref materializes its root, so
 * every fetch starts before the aggregate is thrown — the parallelism a multi-query
 * hook exists for. If the set fails, every started ref is released once the whole set
 * has settled, deferred a tick so a committed subscriber (or an error render that
 * releases errored refs itself) wins the race. That defer-so-a-committer-can-cancel
 * ordering is the same contract as `releaseColdStart`/`#scheduleCleanup` — owned here,
 * next to that contract, so hooks don't re-encode it with their own timers.
 */
export function suspensePromiseAll(
  refs: readonly { suspensePromise(): Promise<void>; releaseColdStart(): void }[],
): Promise<unknown> {
  const promises = refs.map(ref => ref.suspensePromise())
  const aggregate = Promise.all(promises)
  void aggregate.catch(() => {
    void Promise.allSettled(promises).then(() => {
      setTimeout(() => {
        for (const ref of refs) ref.releaseColdStart()
      }, 0)
    })
  })
  return aggregate
}
