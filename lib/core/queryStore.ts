import type { Adapter, QueryResponse } from '../adapters/adapter.js'
import type { AnySchema, Schema } from './schema.js'
import type { QueryRef } from './queryRef.js'
import { FigbirdEventEmitter, type MutationMethod } from './events.js'
import { MutationTracker } from './mutationTracker.js'
import { sortRowsLocally } from './sort.js'
import {
  addQueryToItemIndex,
  applyEventsToService,
  createServiceState,
  groupQueuedEvents,
  isUnfilteredFindQuery,
  removeQueryFromItemIndex,
  splitWindow,
  updateQueriesFromEvents,
} from './windowMaintenance.js'
import { classifyStoredQuery, type StoredQueryClass } from './queryClassification.js'
import {
  queryOfParams,
  type ElementType,
  type Event,
  type FindQueryConfig,
  type GetQueryConfig,
  type InferMutationData,
  type ItemMatcher,
  type MutationDescriptor,
  type ProcessedRealtimeEvent,
  type Query,
  type QueryConfig,
  type QueryDescriptor,
  type QueryState,
  type QueuedEvent,
  type ServiceState,
} from './queryTypes.js'

/**
 * Where the store learns whether the tab is visible. Injectable for tests and
 * non-browser environments; the default reads `document.visibilityState`.
 */
export interface VisibilitySource {
  isHidden(): boolean
  /** Notify on visibility changes. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void
}

/** The realtime event type a mutation verb produces. */
const MUTATION_EVENT_TYPE = {
  create: 'created',
  update: 'updated',
  patch: 'patched',
  remove: 'removed',
} as const satisfies Record<MutationMethod, Event['type']>

function documentVisibility(): VisibilitySource {
  return {
    isHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
    onChange: listener => {
      if (typeof document === 'undefined') return () => {}
      document.addEventListener('visibilitychange', listener)
      return () => document.removeEventListener('visibilitychange', listener)
    },
  }
}

/**
 * Internal query store managing entities, queries, and subscriptions.
 */
export class QueryStore<
  S extends Schema = AnySchema,
  TParams = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TQuery = Record<string, unknown>,
> {
  #adapter: Adapter<TParams, TMeta, TQuery>
  #events: FigbirdEventEmitter
  #mutations: MutationTracker

  #realtime: Set<string> = new Set()
  #listeners: Map<string, Set<(state: QueryState<unknown, TMeta>) => void>> = new Map()
  #globalListeners: Set<(state: Map<string, ServiceState<TMeta>>) => void> = new Set()
  #processedEventListeners: Set<(event: ProcessedRealtimeEvent) => void> = new Set()

  #state: Map<string, ServiceState<TMeta>> = new Map()
  #serviceNamesByQueryId: Map<string, string> = new Map()

  // Reconciliation gate state (see #requestReconcile): per-query cooldown windows
  // with trailing timers, and the set of reconciliations deferred while hidden.
  #reconcileCooldown: number
  #visibility: VisibilitySource
  #reconcileWindows: Map<
    string,
    { lastAt: number; trailing: ReturnType<typeof setTimeout> | null }
  > = new Map()
  #deferredWhileHidden: Set<string> = new Set()

  // Custom operator names the adapter evaluates locally — extends classification's
  // locally-evaluable operator set (see FeathersAdapterOptions.operators).
  #localOperators: ReadonlySet<string>
  #defaultSort: Record<string, number> | undefined

  #eventQueue: QueuedEvent[] = []
  #eventBatchProcessingTimer: ReturnType<typeof setTimeout> | null = null
  #eventBatchInterval: number | undefined = 100
  #processingEventQueue = false
  // Query ids whose listener notification has been deferred to the next microtask
  // (see #scheduleDeferredNotify). Null when nothing is scheduled.
  #deferredNotifyQueryIds: Set<string> | null = null

  constructor({
    adapter,
    eventBatchInterval = 100,
    reconcileCooldown = 2000,
    visibility,
    defaultSort,
  }: {
    adapter: Adapter<TParams, TMeta, TQuery>
    eventBatchInterval?: number | undefined
    /**
     * Minimum interval (ms) between event-driven refetches of one query — burst
     * safety for server-window/server-authoritative reconciliation. The first
     * event refetches immediately (leading edge); further events within the
     * window coalesce into one guaranteed trailing refetch. `0` disables.
     */
    reconcileCooldown?: number
    /** Visibility source for hidden-tab gating. Defaults to `document`. */
    visibility?: VisibilitySource
    /**
     * The backend's implicit ordering for queries without `$sort` (e.g.
     * `{ createdAt: -1, id: -1 }`). Lets window maintenance place realtime items
     * into unsorted windows locally instead of refetching. Must mirror the
     * server's actual default order — divergence shows up as misplaced rows
     * until the next fetch.
     */
    defaultSort?: Record<string, number>
  }) {
    this.#adapter = adapter
    this.#localOperators = new Set(adapter.customOperators ?? [])
    this.#defaultSort = defaultSort
    this.#eventBatchInterval = eventBatchInterval
    this.#events = new FigbirdEventEmitter()
    this.#mutations = new MutationTracker()
    this.#reconcileCooldown = reconcileCooldown
    this.#visibility = visibility ?? documentVisibility()
    this.#visibility.onChange(() => this.#drainDeferredReconciles())
    this.#adapter.subscribeToReconnect?.(() => this.#refetchActiveQueries())
  }

  // Public store API
  /** The instance's observability event emitter — the store is its single owner. */
  get events(): FigbirdEventEmitter {
    return this.#events
  }

  /** The instance's in-flight mutation tracker — the store is its single owner. */
  get mutations(): MutationTracker {
    return this.#mutations
  }

  /** Returns the entire store state map keyed by service name. */
  getState(): Map<string, ServiceState<TMeta>> {
    return this.#state
  }

  /** Returns the state for a specific service by name. */
  getServiceState(serviceName: string): ServiceState<TMeta> | undefined {
    return this.#state.get(serviceName)
  }

  /** Returns the current state for a query by id, if present. */
  getQueryState<T>(queryId: string): QueryState<T, TMeta> | undefined {
    return this.#getQuery(queryId)?.state as QueryState<T, TMeta> | undefined
  }

  /**
   * Ensures that backing state exists for the given QueryRef by creating
   * service/query structures on first use.
   */
  materialize<T, TQueryType>(queryRef: QueryRef<T, TQueryType, S, TParams, TMeta, TQuery>): void {
    const { queryId, desc, config } = queryRef.details()

    if (!this.#getQuery(queryId)) {
      this.#serviceNamesByQueryId.set(queryId, desc.serviceName)

      const classification = classifyStoredQuery(desc.method, queryOfParams(desc.params), {
        server: (config as { server?: boolean }).server,
        allPages: (config as { allPages?: boolean }).allPages,
        localOperators: this.#localOperators,
      })

      this.#transactOverService(queryId, service => {
        service.queries.set(queryId, {
          queryId,
          desc,
          config: config as QueryConfig<unknown, unknown>,
          classification,
          pending: !config.skip,
          dirty: false,
          filterItem: this.#createItemFilter<unknown, unknown>(
            desc,
            config as QueryConfig<unknown, unknown>,
            classification,
          ) as (item: unknown) => boolean,
          state: {
            status: 'loading' as const,
            data: null,
            meta: this.#adapter.emptyMeta(),
            isFetching: !config.skip,
            error: null,
          },
        })
      })
    }
  }

  /**
   * Subscribe to a query state by id. Triggers fetches if needed.
   * Returns an unsubscribe function.
   */
  subscribe<T>(
    queryId: string,
    fn: (state: QueryState<T, TMeta>) => void,
    options: { staleTime?: number | undefined } = {},
  ): () => void {
    const q = this.#getQuery(queryId)
    if (!q) return () => {}

    // `staleTime` is the subscriber's freshness tolerance, not part of query identity —
    // two readers with different tolerances share one entry, and the most demanding one
    // naturally keeps it freshest. Default 0 revalidates on every (re)subscribe.
    const staleTime = options.staleTime ?? 0
    const isFresh =
      staleTime > 0 && q.fetchedAt !== undefined && Date.now() - q.fetchedAt < staleTime
    if (
      q.pending ||
      (q.state.status === 'success' &&
        q.config.fetchPolicy === 'swr' &&
        !q.state.isFetching &&
        !isFresh) ||
      (q.state.status === 'error' && !q.state.isFetching)
    ) {
      this.#queue(queryId)
    }

    const removeListener = this.#addListener(queryId, fn)

    this.#subscribeToRealtime(queryId)

    const shouldVacuum = q.config.fetchPolicy === 'network-only' || Boolean(q.config.matcher)
    return () => {
      removeListener()
      if (shouldVacuum && this.#listenerCount(queryId) === 0) {
        this.#vacuum({ queryId })
      }
    }
  }

  /** Subscribe to any store state changes across all services. */
  subscribeToStateChanges(fn: (state: Map<string, ServiceState<TMeta>>) => void): () => void {
    return this.#addGlobalListener(fn)
  }

  /**
   * Subscribe to realtime events after they've been applied to the entity cache.
   * Used internally for relational-filter invalidation; each event carries the
   * previous entity so listeners can detect which fields changed.
   */
  subscribeToProcessedEvents(fn: (event: ProcessedRealtimeEvent) => void): () => void {
    this.#processedEventListeners.add(fn)
    return () => {
      this.#processedEventListeners.delete(fn)
    }
  }

  /**
   * Ensure a realtime subscription exists for a service even before any query
   * against it is subscribed. Used by relational-filter invalidation, which needs
   * events from dependency services the consumer never queries directly.
   */
  ensureRealtimeSubscription(serviceName: string): void {
    this.#subscribeToRealtimeService(serviceName)
  }

  /** Number of active subscribers for a query — powers figbird.inspect(). */
  getSubscriberCount(queryId: string): number {
    return this.#listenerCount(queryId)
  }

  /** Refetch a specific query by id. */
  refetch(queryId: string): void {
    const q = this.#getQuery(queryId)
    if (!q) return

    if (!q.state.isFetching) {
      this.#queue(queryId)
    } else {
      // Mark as dirty to refetch after current fetch completes
      this.#transactOverService(queryId, (service, query) => {
        service.queries.set(queryId, {
          ...query!,
          dirty: true,
        })
      })
    }
  }

  /** Perform a service mutation and update the store from the result. */
  mutate<D extends MutationDescriptor>(desc: D): Promise<InferMutationData<S, D>> {
    const { serviceName, method, optimistic } = desc
    // For creates, track by the client-generated id — this is what lets
    // `useMutating({ id })` cover the create→navigate→act-before-ack window.
    const id = method !== 'create' ? desc.id : this.#peekId(desc.data)
    const isOptimistic = optimistic !== undefined && optimistic !== false
    const optimisticItem = isOptimistic ? this.#resolveOptimisticItem(desc) : null
    const restoreItem =
      isOptimistic && method !== 'create' && id !== undefined
        ? this.#getEntity(serviceName, id)
        : null

    // The id contract: an optimistic create must carry a client-generated id the
    // server will accept. Identity is what everything downstream is built on —
    // React keys, realtime echo dedup, navigation, child-row foreign keys — and
    // an optimistic item without a real id has none. Confirmed creates
    // (non-optimistic) are the mode for server-assigned ids: await the create,
    // the server's item carries its identity.
    if (isOptimistic && method === 'create' && optimisticItem !== null) {
      const items: unknown[] = Array.isArray(optimisticItem) ? optimisticItem : [optimisticItem]
      if (items.some(item => this.#peekId(item) === undefined)) {
        throw new Error(
          `figbird: optimistic creates on "${serviceName}" need a client-generated id the ` +
            'server will accept (e.g. crypto.randomUUID()) — provide one in the data, or use ' +
            'a confirmed create to wait for the server-assigned id.',
        )
      }
    }

    // Convert named params to args array for the adapter
    const args = this.#buildMutationArgs(desc)

    return this.#trackMutation(
      { serviceName, method, ...(id !== undefined ? { id } : {}), optimistic: isOptimistic },
      () => {
        if (isOptimistic && optimisticItem !== null) {
          // patch/update on an entity that is not in the cache: the merged optimistic
          // item has no id and nothing displays it — skip silently (the server response
          // updates the cache as usual). Applying it would just warn and no-op.
          const skipUncached =
            (method === 'patch' || method === 'update') &&
            restoreItem === null &&
            this.#peekId(optimisticItem) === undefined
          if (!skipUncached) {
            this.#applyMutationEvent(serviceName, method, optimisticItem)
          }
        }
        return this.#adapter.mutate(serviceName, method, args)
      },
      {
        // Apply the cache update before ending the tracker entry, so by the time a
        // `useMutating` subscriber sees "not busy" the data is already in the cache.
        onSuccess: item => this.#applyMutationEvent(serviceName, method, item),
        onError: (_error, mutationId) => {
          if (isOptimistic) {
            this.#rollbackOptimistic(serviceName, method, id, optimisticItem, restoreItem)
            this.#events.emit({
              kind: 'mutate:rollback',
              mutationId,
              serviceName,
              method,
              ...(id !== undefined ? { id } : {}),
            })
          }
        },
      },
    ) as Promise<InferMutationData<S, D>>
  }

  /**
   * Call a custom (non-CRUD) service method — the mutation path for everything
   * beyond create/update/patch/remove (`archive`, `sendReminder`, ...). The result
   * shape is unknown to figbird, so no cache update is applied; the call still
   * flows through the mutation tracker and the `mutate:*` observability events so
   * `useMutating` and devtools see it. No `id` is recorded — custom method args
   * are positional and opaque.
   */
  call(serviceName: string, method: string, args: unknown[]): Promise<unknown> {
    return this.#trackMutation({ serviceName, method, optimistic: false }, () =>
      this.#adapter.mutate(serviceName, method, args),
    )
  }

  /**
   * Shared mutation lifecycle around `run()` (which performs any optimistic apply
   * and the adapter call, synchronously in that order). The tracker entry is
   * registered synchronously — not via the deferred events channel — so
   * `figbird.mutating` snapshots are correct at any moment (see MutationTracker),
   * and it registers *before* `run()` so an optimistic apply never notifies
   * subscribers while the tracker still reads "not busy". On settle, the
   * `onSuccess`/`onError` hooks fire before the tracker entry ends, so by the time
   * a `useMutating` subscriber sees "not busy" the cache already reflects the
   * outcome. Errors are normalized to `Error` and rethrown.
   */
  #trackMutation<T>(
    entry: { serviceName: string; method: string; id?: string | number; optimistic: boolean },
    run: () => Promise<T>,
    hooks?: {
      onSuccess?: (result: T) => void
      onError?: (error: Error, mutationId: number) => void
    },
  ): Promise<T> {
    const { serviceName, method, id, optimistic } = entry
    const idField = id !== undefined ? { id } : {}
    const startedAt = Date.now()
    const mutationId = this.#mutations.start({ serviceName, method, ...idField })
    this.#events.emit({
      kind: 'mutate:start',
      mutationId,
      serviceName,
      method,
      ...idField,
      optimistic,
    })
    return run().then(
      result => {
        hooks?.onSuccess?.(result)
        this.#mutations.end(mutationId)
        this.#events.emit({
          kind: 'mutate:end',
          mutationId,
          serviceName,
          method,
          durationMs: Date.now() - startedAt,
          ...idField,
          optimistic,
        })
        return result
      },
      (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err))
        hooks?.onError?.(error, mutationId)
        this.#mutations.end(mutationId)
        this.#events.emit({
          kind: 'mutate:error',
          mutationId,
          serviceName,
          method,
          durationMs: Date.now() - startedAt,
          error,
          ...idField,
          optimistic,
        })
        throw error
      },
    )
  }

  // Query lifecycle
  async #queue(queryId: string): Promise<void> {
    this.#fetching({ queryId })
    const query = this.#getQuery(queryId)
    const startedAt = query ? Date.now() : undefined
    if (query) {
      this.#events.emit({
        kind: 'fetch:start',
        serviceName: query.desc.serviceName,
        method: query.desc.method,
        queryId,
        ...(query.desc.method === 'get' ? { resourceId: query.desc.resourceId } : {}),
        params: query.desc.params,
      })
    }
    try {
      const result = await this.#fetch(queryId)
      this.#fetched({ queryId, result })
      const q = this.#getQuery(queryId)
      if (q && startedAt !== undefined) {
        const data = result.data
        const itemCount = Array.isArray(data) ? data.length : data ? 1 : 0
        this.#events.emit({
          kind: 'fetch:end',
          serviceName: q.desc.serviceName,
          method: q.desc.method,
          queryId,
          durationMs: Date.now() - startedAt,
          itemCount,
        })
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.#fetchFailed({ queryId, error })
      const q = this.#getQuery(queryId)
      if (q && startedAt !== undefined) {
        this.#events.emit({
          kind: 'fetch:error',
          serviceName: q.desc.serviceName,
          method: q.desc.method,
          queryId,
          durationMs: Date.now() - startedAt,
          error,
        })
      }
    }
  }

  #fetch(queryId: string): Promise<QueryResponse<unknown, TMeta | undefined>> {
    const query = this.#getQuery(queryId)
    if (!query) {
      return Promise.reject(new Error('Query not found'))
    }

    const { desc, config } = query

    if (desc.method === 'get') {
      const local = this.#tryLocalGet(query)
      if (local) return Promise.resolve(local)
      return this.#adapter.get(desc.serviceName, desc.resourceId, desc.params as TParams)
    } else {
      const local = this.#tryLocalFind(query)
      if (local) return Promise.resolve(local)
      const findConfig = config as FindQueryConfig<unknown, unknown>
      return findConfig.allPages
        ? this.#adapter.findAll(desc.serviceName, desc.params as TParams)
        : this.#adapter.find(desc.serviceName, desc.params as TParams)
    }
  }

  /**
   * Answer a get locally when the service is fully materialized (an `.all()` query
   * succeeded): the entity cache is the complete row set, so a present entity is
   * the answer with no roundtrip — realtime events, the reconnect sweep, and
   * complete-set fetch diffs keep it fresh, the same soundness argument local finds
   * rely on. Conditions (`.get(id).where(...)`) evaluate locally too when they're
   * locally decidable — same matcher, same custom-operator registry as finds.
   *
   * Falls through to the server whenever the local answer would be an *error*: a
   * missing entity or a present entity failing the predicate. Completeness makes a
   * local not-found sound in principle, but those cases are rare, a roundtrip there
   * is cheap, and the server's error carries the adapter's real error shape (which
   * apps match on) rather than a synthesized one. Non-local conditions (`$regex`),
   * `network-only`, and `.server()` reads always go out.
   */
  #tryLocalGet(
    query: Query<unknown, TMeta, unknown>,
  ): QueryResponse<unknown, TMeta | undefined> | null {
    const desc = query.desc
    if (desc.method !== 'get') return null
    // Gets with non-local conditions stored as 'server-authoritative' at
    // materialize time (see classifyStoredQuery) — never answered locally.
    if (query.classification !== 'get') return null
    const service = this.#state.get(desc.serviceName)
    if (!service?.materialized) return null

    const config = query.config as GetQueryConfig<unknown, unknown>
    if (config.server) return null
    if (config.fetchPolicy === 'network-only') return null

    const entity = service.entities.get(desc.resourceId)
    if (entity === undefined) return null

    const q = queryOfParams(desc.params)
    if (q && Object.keys(q).length > 0) {
      // classification === 'get' guarantees the conditions are locally evaluable.
      if (!this.#resolveMatcher(config, q)(entity)) return null
    }

    return { data: entity } as QueryResponse<unknown, TMeta | undefined>
  }

  /**
   * Answer a find locally when the service is fully materialized (an `.all()` query
   * succeeded): filter the entity cache with the adapter matcher, then sort and slice
   * any window client-side. Windowed queries against a materialized service classify
   * server-window, so realtime events refetch them — and the "refetch" lands here,
   * recomputing from the local set with no network.
   *
   * Returns null (fall through to the network) for: non-materialized services, the
   * materialization root itself, `.server()` queries, and predicates the local matcher
   * cannot decide ($select, $regex, custom operators).
   */
  #tryLocalFind(
    query: Query<unknown, TMeta, unknown>,
  ): QueryResponse<unknown, TMeta | undefined> | null {
    const service = this.#state.get(query.desc.serviceName)
    if (!service?.materialized) return null
    if (service.materialized.queryId === query.queryId) return null

    const config = query.config as FindQueryConfig<unknown, unknown>
    // Honor the documented fetchPolicy contract ("always fetch on mount"), same
    // as #tryLocalGet — a materialized cache doesn't override an explicit opt-out.
    if (config.fetchPolicy === 'network-only') return null
    // Stored classification is the single source of truth: authoritative reasons
    // ($select, $regex, custom operators, .server()) survive allPages-neutralization,
    // while window filters don't — windows are computed locally below. So
    // 'server-authoritative' is exactly "not locally answerable".
    if (query.classification === 'server-authoritative') return null

    const q = queryOfParams(query.desc.params)
    const { filters, sort, limit, skip } = splitWindow(q)
    const match = this.#resolveMatcher(config, filters)
    let rows = [...service.entities.values()].filter(match)
    const effectiveSort = sort ?? this.#defaultSort
    if (effectiveSort) rows = sortRowsLocally(rows, effectiveSort)
    const total = rows.length
    const data = rows.slice(skip, limit !== undefined ? skip + limit : undefined)
    // Synthesized find envelope, mirroring the common { total, limit, skip } shape.
    return {
      data,
      meta: { total, limit: limit ?? total, skip },
    } as unknown as QueryResponse<unknown, TMeta>
  }

  #fetching({ queryId }: { queryId: string }): void {
    // This is the only listener-notifying transition reachable synchronously from
    // a React render (useQuery → suspensePromise → root/relation setup → subscribe
    // → #queue → here); everything past `await #fetch` is already async. Deferring
    // the notification (not the state write — the fetch still starts synchronously
    // and warm reads are unaffected) keeps other subscribed components from being
    // updated mid-render.
    this.#scheduleDeferredNotify(
      this.#transactOverService(queryId, (service, query) => {
        if (!query) return

        service.queries.set(queryId, {
          ...query,
          pending: false,
          dirty: false,
          // error and loading states both restart as a clean loading state.
          state:
            query.state.status === 'success'
              ? { ...query.state, isFetching: true }
              : {
                  status: 'loading' as const,
                  data: null,
                  meta: query.state.meta,
                  isFetching: true,
                  error: null,
                },
        })
      }),
    )
  }

  #fetched({
    queryId,
    result,
  }: {
    queryId: string
    result: QueryResponse<unknown, TMeta | undefined>
  }): void {
    let shouldRefetch = false
    const processedEvents: ProcessedRealtimeEvent[] = []
    const serverMaintainedQueriesToRefetch = new Set<string>()

    const serviceName = this.#serviceNamesByQueryId.get(queryId)
    const touched = this.#transactOverServiceByName(serviceName ?? '', (service, touch) => {
      const query = service.queries.get(queryId)
      if (!query) return
      touch(queryId)

      // A complete-set fetch (unfiltered allPages — the materialization condition)
      // is authoritative for the whole service: snapshot the entity cache before
      // applying the result so it can be diffed below and the changes propagated
      // to every other query the same way realtime events are. `.server()` fetches
      // don't diff — a server-authoritative query refetching in response to diff
      // events must not itself produce diff events, or two of them could cycle.
      const findConfig = query.config as FindQueryConfig<unknown, unknown>
      const isCompleteSet =
        query.desc.method === 'find' &&
        Boolean(findConfig.allPages) &&
        isUnfilteredFindQuery(query.desc.params)
      const previousEntities =
        isCompleteSet && !findConfig.server ? new Map(service.entities) : null

      const data = result.data
      const meta = (result as { meta?: TMeta }).meta
      const getId = (item: unknown) => this.#adapter.getId(item)
      const nextItemIds = new Set<string | number>()
      const getFreshItem = (item: unknown) => {
        const itemId = getId(item)
        if (itemId === undefined) {
          return item
        }

        const currItem = service.entities.get(itemId)
        if (!currItem || !this.#adapter.isItemStale(currItem, item)) {
          return item
        }

        if (query.desc.method === 'find' && !query.filterItem(currItem)) {
          return undefined
        }

        return currItem
      }
      const freshData = Array.isArray(data)
        ? data.reduce<unknown[]>((acc, item) => {
            const freshItem = getFreshItem(item)
            if (freshItem !== undefined) {
              acc.push(freshItem)
            }
            return acc
          }, [])
        : getFreshItem(data)
      const freshItems = Array.isArray(freshData) ? freshData : [freshData]

      for (const item of freshItems) {
        const itemId = getId(item)
        if (itemId !== undefined) {
          nextItemIds.add(itemId)
          service.entities.set(itemId, item)
          addQueryToItemIndex(service, itemId, queryId)
        }
      }

      for (const [itemId, queryIds] of service.itemQueryIndex) {
        if (!nextItemIds.has(itemId)) {
          queryIds.delete(queryId)
        }
      }

      shouldRefetch = query.dirty

      // A successful unfiltered allPages fetch (`.all()` with no filters) means the
      // complete row set is now local: mark the service materialized so matcher-
      // decidable finds are answered from the cache (see #tryLocalFind). A *filtered*
      // allPages fetch is complete only for its own filter — it must not materialize
      // the service.
      if (isCompleteSet) {
        service.materialized = { queryId, fetchedAt: Date.now() }
      }

      service.queries.set(queryId, {
        ...query,
        fetchedAt: Date.now(),
        state: {
          status: 'success' as const,
          data: freshData,
          meta: meta || this.#adapter.emptyMeta(),
          isFetching: false,
          error: null,
        },
      })

      // Diff the complete set against the pre-fetch cache and apply the changes as
      // synthetic events. Without this, queries answered locally from the cache
      // (see #tryLocalFind) would never observe changes a root refetch brought in —
      // rows created or removed out-of-band would be invisible to them forever.
      // The fetched query itself is excluded: its state was just set from the result.
      if (previousEntities) {
        for (const [itemId, previousItem] of previousEntities) {
          if (!nextItemIds.has(itemId)) {
            service.entities.delete(itemId)
            processedEvents.push({
              serviceName: query.desc.serviceName,
              type: 'removed',
              item: previousItem,
              previousItem,
              itemId,
            })
          }
        }
        for (const itemId of nextItemIds) {
          const item = service.entities.get(itemId)!
          const previousItem = previousEntities.get(itemId)
          if (!previousItem) {
            processedEvents.push({
              serviceName: query.desc.serviceName,
              type: 'created',
              item,
              previousItem: null,
              itemId,
            })
          } else if (previousItem !== item) {
            processedEvents.push({
              serviceName: query.desc.serviceName,
              type: 'updated',
              item,
              previousItem,
              itemId,
            })
          }
        }
        if (processedEvents.length > 0) {
          updateQueriesFromEvents({
            service,
            appliedItems: processedEvents,
            touch,
            getId,
            itemAdded: meta => this.#adapter.itemAdded(meta),
            itemRemoved: meta => this.#adapter.itemRemoved(meta),
            serverMaintainedQueriesToRefetch,
            excludeQueryId: queryId,
            defaultSort: this.#defaultSort,
          })
        }
      }
    })
    this.#notify(touched)

    if (processedEvents.length > 0) {
      // Same follow-ups as the realtime event path: reconcile queries that can't
      // merge locally and surface the changes to relational-filter invalidation.
      // Unlike realtime events, diffs don't trigger `realtime: 'refetch'` queries —
      // a refetch-on-diff that itself diffs would cycle. The set never contains
      // queryId itself: updateQueriesFromEvents skips excludeQueryId.
      for (const id of serverMaintainedQueriesToRefetch) {
        this.#requestReconcile(id)
      }
      for (const event of processedEvents) {
        this.#emitProcessedEvent(event)
      }
    }

    if (shouldRefetch && this.#listenerCount(queryId) > 0) {
      this.#queue(queryId)
    }
  }

  #fetchFailed({ queryId, error }: { queryId: string; error: Error }): void {
    let shouldRefetch = false

    const touched = this.#transactOverService(queryId, (service, query) => {
      if (!query) return

      shouldRefetch = query.dirty

      service.queries.set(queryId, {
        ...query!,
        state: {
          status: 'error' as const,
          data: null,
          meta: this.#adapter.emptyMeta(),
          isFetching: false,
          error,
        },
      })
    })
    this.#notify(touched)

    if (shouldRefetch && this.#listenerCount(queryId) > 0) {
      this.#queue(queryId)
    }
  }

  // Realtime event handling
  #subscribeToRealtime(queryId: string): void {
    const query = this.#getQuery(queryId)
    if (!query) return

    this.#subscribeToRealtimeService(query.desc.serviceName)
  }

  #subscribeToRealtimeService(serviceName: string): void {
    // check if already subscribed to the events of this service
    if (this.#realtime.has(serviceName)) return
    if (!this.#adapter.subscribe) return // Real-time not supported by this adapter

    const created = (item: unknown) => this.#queueEvent(serviceName, { type: 'created', item })
    const updated = (item: unknown) => this.#queueEvent(serviceName, { type: 'updated', item })
    const patched = (item: unknown) => this.#queueEvent(serviceName, { type: 'patched', item })
    const removed = (item: unknown) => this.#queueEvent(serviceName, { type: 'removed', item })

    this.#adapter.subscribe(serviceName, {
      created,
      updated,
      patched,
      removed,
    })
    this.#realtime.add(serviceName)
  }

  #emitRealtimeForItems(serviceName: string, type: Event['type'], items: unknown[]): void {
    for (const item of items) {
      this.#events.emit({
        kind: 'realtime',
        serviceName,
        type,
        itemId: this.#adapter.getId(item),
      })
    }
  }

  /** Push an event onto the queue and emit the observability signal for its items. */
  #enqueueEvent(serviceName: string, event: Event): void {
    const items = Array.isArray(event.item) ? event.item : [event.item]
    this.#eventQueue.push({
      serviceName,
      type: event.type,
      items,
    })
    this.#emitRealtimeForItems(serviceName, event.type, items)
  }

  /** Apply an event immediately — used for mutation results and optimistic writes. */
  #processEvent(serviceName: string, event: Event): void {
    this.#enqueueEvent(serviceName, event)
    this.#processQueuedEvents()
  }

  /** Queue a realtime event for batched processing. */
  #queueEvent(serviceName: string, event: Event): void {
    this.#enqueueEvent(serviceName, event)

    if (!this.#eventBatchProcessingTimer && !this.#processingEventQueue) {
      // process all events in a short interval as a batch later
      if (this.#eventBatchInterval) {
        this.#eventBatchProcessingTimer = setTimeout(() => {
          this.#eventBatchProcessingTimer = null
          this.#processQueuedEvents()
        }, this.#eventBatchInterval)
      } else {
        // batching is disabled, process each event immediately
        this.#processQueuedEvents()
      }
    }
  }

  #processQueuedEvents(): void {
    if (this.#processingEventQueue || this.#eventQueue.length === 0) {
      return
    }

    this.#processingEventQueue = true
    try {
      const getId = (item: unknown) => this.#adapter.getId(item)
      const isItemStale = (curr: unknown, next: unknown) => this.#adapter.isItemStale(curr, next)

      while (this.#eventQueue.length > 0) {
        const eventsByService = groupQueuedEvents(this.#eventQueue)
        this.#eventQueue = []

        const touchedQueryIds = new Set<string>()
        const followups: Array<{
          serviceName: string
          serverMaintainedQueriesToRefetch: Set<string>
          processedEvents: ProcessedRealtimeEvent[]
        }> = []

        // Apply every service's events before notifying anyone — the batch is the
        // atomicity unit for observers. Notifying per service would let a relational
        // query spanning services A and B compute a wasted intermediate snapshot
        // after A's events but before B's, and non-React subscribers would observe
        // the intermediate state.
        for (const [serviceName, events] of Object.entries(eventsByService)) {
          const serverMaintainedQueriesToRefetch = new Set<string>()
          const processedEvents: ProcessedRealtimeEvent[] = []

          const modifiedQueries = this.#transactOverServiceByName(serviceName, (service, touch) => {
            applyEventsToService({
              service,
              serviceName,
              events,
              getId,
              isItemStale,
              processedEvents,
            })

            // Update queries only for the items actually applied to the entity
            // cache — stale-skipped items never reach query state.
            if (processedEvents.length > 0) {
              updateQueriesFromEvents({
                service,
                appliedItems: processedEvents,
                touch,
                getId,
                itemAdded: meta => this.#adapter.itemAdded(meta),
                itemRemoved: meta => this.#adapter.itemRemoved(meta),
                serverMaintainedQueriesToRefetch,
                defaultSort: this.#defaultSort,
              })
            }
          })

          for (const queryId of modifiedQueries) {
            touchedQueryIds.add(queryId)
          }
          followups.push({ serviceName, serverMaintainedQueriesToRefetch, processedEvents })
        }

        // Notify once per batch, after all services have applied.
        for (const queryId of touchedQueryIds) {
          this.#invokeListeners(queryId)
        }
        if (touchedQueryIds.size > 0) {
          this.#invokeGlobalListeners()
        }

        for (const {
          serviceName,
          serverMaintainedQueriesToRefetch,
          processedEvents,
        } of followups) {
          // Server-maintained queries can't merge events locally: reconcile active
          // ones through the gate (cooldown + hidden-tab deferral); the gate marks
          // inactive cached ones pending so their next subscription reconciles.
          for (const queryId of serverMaintainedQueriesToRefetch) {
            this.#requestReconcile(queryId)
          }

          for (const event of processedEvents) {
            this.#emitProcessedEvent(event)
          }

          // Refetch refetchable queries if needed
          this.#refetchRefetchableQueries(serviceName)
        }
      }
    } finally {
      this.#processingEventQueue = false
    }
  }

  #emitProcessedEvent(event: ProcessedRealtimeEvent): void {
    for (const listener of this.#processedEventListeners) {
      try {
        listener(event)
      } catch {
        // Internal invalidation listeners should not break the event loop.
      }
    }
  }

  #refetchRefetchableQueries(serviceName: string): void {
    const service = this.getState().get(serviceName)
    if (!service) return

    for (const query of service.queries.values()) {
      if (query.config.realtime === 'refetch' && this.#listenerCount(query.queryId) > 0) {
        this.#requestReconcile(query.queryId)
      }
    }
  }

  /**
   * The reconciliation gate. Every EVENT-DRIVEN refetch (server-window /
   * server-authoritative queries reacting to realtime events, `realtime:
   * 'refetch'` queries, and the reconnect sweep) passes through here — manual
   * `refetch()`, first fetches, and SWR revalidation do not.
   *
   * Correctness contract: a reconciliation may be delayed and coalesced, never
   * dropped — the trailing refetch (or the drain-on-visible) always lands on
   * the latest server state after the last relevant event.
   *
   * - Hidden tab → defer: mark the query pending (truthful in `inspect()`) and
   *   reconcile once when the tab becomes visible. Local-exact merges are
   *   unaffected — only network reconciliation pauses.
   * - Cooldown: the first event in a window refetches immediately (leading
   *   edge — isolated changes stay as fast as today); further events within
   *   `reconcileCooldown` coalesce into one guaranteed trailing refetch.
   */
  #requestReconcile(queryId: string, { force = false }: { force?: boolean } = {}): void {
    if (!force && this.#listenerCount(queryId) === 0) {
      this.#markQueryPending(queryId)
      return
    }

    if (this.#visibility.isHidden()) {
      this.#deferredWhileHidden.add(queryId)
      this.#markQueryPending(queryId)
      return
    }

    if (this.#reconcileCooldown <= 0) {
      this.refetch(queryId)
      return
    }

    const now = Date.now()
    const window = this.#reconcileWindows.get(queryId)

    if (!window || now - window.lastAt >= this.#reconcileCooldown) {
      this.#reconcileWindows.set(queryId, { lastAt: now, trailing: window?.trailing ?? null })
      this.refetch(queryId)
      return
    }

    if (window.trailing) return // the pending trailing refetch already covers this

    const timer = setTimeout(
      () => {
        const current = this.#reconcileWindows.get(queryId)
        if (current) current.trailing = null
        if (!this.#getQuery(queryId)) {
          this.#reconcileWindows.delete(queryId)
          return
        }
        // Re-enter the gate: the window has expired so this fires leading-edge,
        // unless the tab went hidden or the last subscriber left in the meantime.
        this.#requestReconcile(queryId)
      },
      window.lastAt + this.#reconcileCooldown - now,
    )
    // Never keep a Node process alive for a pending reconciliation.
    ;(timer as { unref?: () => void }).unref?.()
    window.trailing = timer
  }

  /** On becoming visible, reconcile everything that deferred while hidden. */
  #drainDeferredReconciles(): void {
    if (this.#visibility.isHidden() || this.#deferredWhileHidden.size === 0) return
    const deferred = Array.from(this.#deferredWhileHidden)
    this.#deferredWhileHidden.clear()
    for (const queryId of deferred) {
      if (!this.#getQuery(queryId)) continue
      this.#requestReconcile(queryId)
    }
  }

  #clearReconcileState(queryId: string): void {
    const window = this.#reconcileWindows.get(queryId)
    if (window?.trailing) clearTimeout(window.trailing)
    this.#reconcileWindows.delete(queryId)
    this.#deferredWhileHidden.delete(queryId)
  }

  /**
   * Manually refetch cached queries — the escape hatch for changes figbird cannot
   * observe: custom methods on services without realtime events, out-of-band writes,
   * eventless integrations. Scoped to one service, or the whole store when called
   * with no argument.
   *
   * Manual intent is never gated: active queries refetch immediately (no reconcile
   * cooldown, no hidden-tab deferral); inactive cached queries are marked pending so
   * their next subscriber refetches; a materialized `.all()` root refetches even
   * with no subscribers, since local reads depend on its completeness.
   */
  refetchQueries(serviceName?: string): void {
    for (const [name, service] of this.getState()) {
      if (serviceName !== undefined && name !== serviceName) continue
      for (const query of service.queries.values()) {
        if (query.config.skip) continue
        const active = this.#listenerCount(query.queryId) > 0
        const isMaterializedRoot = query.queryId === service.materialized?.queryId
        if (active || isMaterializedRoot) {
          this.#queue(query.queryId)
        } else {
          this.#markQueryPending(query.queryId)
        }
      }
    }
  }

  #refetchActiveQueries(): void {
    for (const service of this.getState().values()) {
      // Materialization roots reconcile even with no subscribers — every local read
      // depends on their completeness, and events may have been missed while offline.
      if (service.materialized) {
        this.#requestReconcile(service.materialized.queryId, { force: true })
      }
      for (const query of service.queries.values()) {
        if (query.queryId === service.materialized?.queryId) continue
        if (
          !query.config.skip &&
          query.config.realtime !== 'disabled' &&
          this.#listenerCount(query.queryId) > 0
        ) {
          this.#requestReconcile(query.queryId)
        }
      }
    }
  }

  #markQueryPending(queryId: string): void {
    this.#transactOverService(queryId, (service, query) => {
      if (!query) return

      service.queries.set(queryId, {
        ...query,
        pending: true,
      })
    })
  }

  // Optimistic mutation support
  #getEntity(serviceName: string, id: string | number): unknown {
    return this.#state.get(serviceName)?.entities.get(id) ?? null
  }

  /**
   * Resolve the synthetic item to apply optimistically. Falls back to the request body
   * (create) or a merge of `data` onto the cached item (update/patch). For remove there
   * is no explicit item — `null` is returned and the caller treats it as a delete.
   */
  /** Warn-free id read — presence checks on payloads that may lack ids. */
  #peekId(item: unknown): string | number | undefined {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined
    return this.#adapter.peekId(item)
  }

  #resolveOptimisticItem(desc: MutationDescriptor): unknown {
    const { optimistic } = desc
    if (optimistic !== undefined && optimistic !== true && optimistic !== false) {
      return optimistic
    }
    if (desc.method === 'create') {
      return desc.data
    }
    if (desc.method === 'remove') {
      return null
    }
    const cached = this.#getEntity(desc.serviceName, desc.id)
    const cachedRecord = (cached && typeof cached === 'object' ? cached : {}) as Record<
      string,
      unknown
    >
    return { ...cachedRecord, ...(desc.data as Record<string, unknown>) }
  }

  #applyMutationEvent(serviceName: string, method: MutationMethod, item: unknown): void {
    this.#processEvent(serviceName, { type: MUTATION_EVENT_TYPE[method], item })
  }

  #rollbackOptimistic(
    serviceName: string,
    method: MutationMethod,
    id: string | number | undefined,
    optimisticItem: unknown,
    restoreItem: unknown,
  ): void {
    if (method === 'create') {
      // Drop the optimistically-created item.
      const optimisticId =
        optimisticItem && typeof optimisticItem === 'object'
          ? this.#adapter.getId(optimisticItem)
          : undefined
      if (optimisticId !== undefined) {
        this.#processEvent(serviceName, {
          type: 'removed',
          item: optimisticItem,
        })
      }
      return
    }
    if (method === 'remove') {
      // Restore the previously-removed item if we still have its prior shape.
      if (restoreItem) {
        this.#processEvent(serviceName, { type: 'created', item: restoreItem })
      }
      return
    }
    if (id === undefined) return
    if (restoreItem) {
      this.#processEvent(serviceName, { type: 'patched', item: restoreItem })
    } else {
      // No prior snapshot — best-effort: drop the optimistic patch entirely.
      this.#processEvent(serviceName, { type: 'removed', item: { id } })
    }
  }

  // State management
  #getQuery(queryId: string): Query<unknown, TMeta, unknown> | undefined {
    const serviceName = this.#serviceNamesByQueryId.get(queryId)
    if (serviceName) {
      const service = this.getState().get(serviceName)
      if (service) {
        return service.queries.get(queryId)
      }
    }
    return undefined
  }

  /** Notify listeners of the touched queries synchronously, then global listeners. */
  #notify(queryIds: Set<string>): void {
    if (queryIds.size === 0) return
    for (const queryId of queryIds) {
      this.#invokeListeners(queryId)
    }
    this.#invokeGlobalListeners()
  }

  /**
   * Invoke listeners on the next microtask instead of synchronously, coalescing
   * repeated schedules. Used for transitions that can happen while React is
   * rendering: subscribing to a query can start a fetch synchronously (including
   * from `suspensePromise()` during render), and the resulting isFetching
   * transition must not fire other components' `onStoreChange` mid-render —
   * React warns with "Cannot update a component while rendering a different
   * component". Listeners read the *current* state when invoked, so deferring
   * never delivers a stale snapshot.
   */
  #scheduleDeferredNotify(queryIds: Set<string>): void {
    if (this.#deferredNotifyQueryIds) {
      for (const queryId of queryIds) {
        this.#deferredNotifyQueryIds.add(queryId)
      }
      return
    }
    this.#deferredNotifyQueryIds = new Set(queryIds)
    queueMicrotask(() => {
      const ids = this.#deferredNotifyQueryIds
      this.#deferredNotifyQueryIds = null
      if (!ids || ids.size === 0) return
      for (const queryId of ids) {
        this.#invokeListeners(queryId)
      }
      this.#invokeGlobalListeners()
    })
  }

  /**
   * Run `fn` over a query's service state, collecting touched query ids. Transactions
   * never notify — notification is an explicit follow-up at the call site
   * (`#notify` for synchronous delivery, `#scheduleDeferredNotify` for render-safe
   * deferral), so the policy is readable where it applies.
   */
  #transactOverService(
    queryId: string,
    fn: (service: ServiceState<TMeta>, query?: Query<unknown, TMeta, unknown>) => void,
  ): Set<string> {
    const serviceName = this.#serviceNamesByQueryId.get(queryId)
    if (!serviceName) return new Set()

    return this.#transactOverServiceByName(serviceName, (service, touch) => {
      fn(service, service.queries.get(queryId))
      touch(queryId)
    })
  }

  /** See #transactOverService — same contract, keyed by service name. */
  #transactOverServiceByName(
    serviceName: string,
    fn: (service: ServiceState<TMeta>, touch: (queryId: string) => void) => void,
  ): Set<string> {
    if (!serviceName) return new Set()

    // initialise the service structure if needed
    if (!this.getState().get(serviceName)) {
      this.getState().set(serviceName, createServiceState())
    }

    const modifiedQueries = new Set<string>()
    const touch = (queryId: string) => modifiedQueries.add(queryId)
    const service = this.#state.get(serviceName)
    if (service) {
      fn(service, touch)
    }
    return modifiedQueries
  }

  #vacuum({ queryId }: { queryId: string }): void {
    this.#clearReconcileState(queryId)
    this.#transactOverService(queryId, (service, query) => {
      if (query) {
        if (query.state.data) {
          const getId = (item: unknown) => this.#adapter.getId(item)
          removeQueryFromItemIndex({ service, query, queryId, getId })
        }
        service.queries.delete(queryId)
        this.#serviceNamesByQueryId.delete(queryId)
        if (service.materialized?.queryId === queryId) {
          delete service.materialized
        }
      }
    })
  }

  // Internal helpers
  #createItemFilter<T, TQueryType>(
    desc: QueryDescriptor,
    config: QueryConfig<T, TQueryType>,
    classification: StoredQueryClass,
  ): ItemMatcher<ElementType<T>> {
    // if this query is not using the realtime mode
    // we will never be merging events into the cache
    // and will never call the matcher, so to avoid
    // the issue where custom query filters or operators
    // cause the default matcher to throw an error without
    // additional configuration, let's avoid creating a matcher
    // altogether
    if (config.realtime !== 'merge') {
      return () => false
    }

    // Server-authoritative queries never merge events locally — they refetch, and
    // their predicates ($regex, unknown operators) would throw in the default
    // matcher anyway. Server-window predicates are locally evaluable by
    // construction (anything non-local classifies authoritative), and window
    // maintenance needs them to judge event membership — build the real matcher.
    if (classification === 'server-authoritative') {
      return () => false
    }

    return this.#resolveMatcher(config as QueryConfig<unknown, unknown>, queryOfParams(desc.params))
  }

  /**
   * The effective matcher for a query: the per-query `matcher` factory from config
   * wins, else the adapter's. The casts across the typed-factory/unknown-item
   * boundary live here and nowhere else.
   */
  #resolveMatcher(
    config: QueryConfig<unknown, unknown>,
    filters: Record<string, unknown> | undefined,
  ): (item: unknown) => boolean {
    return config.matcher
      ? (config.matcher(filters as never) as (item: unknown) => boolean)
      : (this.#adapter.matcher(filters as TQuery | undefined) as (item: unknown) => boolean)
  }

  /** Convert mutation descriptor to args array for adapter */
  #buildMutationArgs(desc: MutationDescriptor): unknown[] {
    switch (desc.method) {
      case 'create':
        return desc.params !== undefined ? [desc.data, desc.params] : [desc.data]
      case 'update':
      case 'patch':
        return desc.params !== undefined ? [desc.id, desc.data, desc.params] : [desc.id, desc.data]
      case 'remove':
        return desc.params !== undefined ? [desc.id, desc.params] : [desc.id]
    }
  }

  #addListener<T>(queryId: string, fn: (state: QueryState<T, TMeta>) => void): () => void {
    if (!this.#listeners.has(queryId)) {
      this.#listeners.set(queryId, new Set())
    }
    this.#listeners.get(queryId)!.add(fn as (state: QueryState<unknown, TMeta>) => void)
    return () => {
      const listeners = this.#listeners.get(queryId)
      if (listeners) {
        listeners.delete(fn as (state: QueryState<unknown, TMeta>) => void)
        if (listeners.size === 0) {
          this.#listeners.delete(queryId)
        }
      }
    }
  }

  #invokeListeners(queryId: string): void {
    const listeners = this.#listeners.get(queryId)
    if (listeners) {
      const state = this.getQueryState(queryId)
      if (state) {
        listeners.forEach(listener => listener(state))
      }
    }
  }

  #addGlobalListener(fn: (state: Map<string, ServiceState<TMeta>>) => void): () => void {
    this.#globalListeners.add(fn)
    return () => {
      this.#globalListeners.delete(fn)
    }
  }

  #invokeGlobalListeners(): void {
    const state = this.getState()
    this.#globalListeners.forEach(listener => listener(state))
  }

  #listenerCount(queryId: string): number {
    return this.#listeners.get(queryId)?.size || 0
  }
}
