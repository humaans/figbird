import type { Adapter, QueryResponse } from '../adapters/adapter.js'
import type { AnySchema, Schema } from './schema.js'
import type { QueryRef } from './queryRef.js'
import { FigbirdEventEmitter, type MutationMethod } from './events.js'
import { MutationTracker } from './mutationTracker.js'
import {
  classifyQueryNode,
  isServerMaintained,
  type StoredQueryClass,
} from './queryClassification.js'
import type {
  ElementType,
  Event,
  FindQueryConfig,
  InferMutationData,
  ItemMatcher,
  MutationDescriptor,
  ProcessedRealtimeEvent,
  Query,
  QueryConfig,
  QueryDescriptor,
  QueryState,
  QueuedEvent,
  ServiceState,
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
    events,
    mutations,
    reconcileCooldown = 2000,
    visibility,
  }: {
    adapter: Adapter<TParams, TMeta, TQuery>
    eventBatchInterval?: number | undefined
    events?: FigbirdEventEmitter
    mutations?: MutationTracker
    /**
     * Minimum interval (ms) between event-driven refetches of one query — burst
     * safety for server-window/server-authoritative reconciliation. The first
     * event refetches immediately (leading edge); further events within the
     * window coalesce into one guaranteed trailing refetch. `0` disables.
     */
    reconcileCooldown?: number
    /** Visibility source for hidden-tab gating. Defaults to `document`. */
    visibility?: VisibilitySource
  }) {
    this.#adapter = adapter
    this.#localOperators = new Set(adapter.customOperators ?? [])
    this.#eventBatchInterval = eventBatchInterval
    this.#events = events ?? new FigbirdEventEmitter()
    this.#mutations = mutations ?? new MutationTracker()
    this.#reconcileCooldown = reconcileCooldown
    this.#visibility = visibility ?? documentVisibility()
    this.#visibility.onChange(() => this.#drainDeferredReconciles())
    this.#adapter.subscribeToReconnect?.(() => this.#refetchActiveQueries())
  }

  // Public store API
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

      const classification: StoredQueryClass =
        desc.method === 'get'
          ? 'get'
          : classifyQueryNode(
              (desc.params as { query?: Record<string, unknown> } | undefined)?.query,
              {
                server: (config as { server?: boolean }).server,
                allPages: (config as { allPages?: boolean }).allPages,
                localOperators: this.#localOperators,
              },
            )

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

    const updaters: Record<string, (item: unknown) => void> = {
      create: item => this.#processEvent(serviceName, { type: 'created', item }),
      update: item => this.#processEvent(serviceName, { type: 'updated', item }),
      patch: item => this.#processEvent(serviceName, { type: 'patched', item }),
      remove: item => this.#processEvent(serviceName, { type: 'removed', item }),
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
        onSuccess: item => updaters[method]?.(item),
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
    if (config.server) return null
    const q = (query.desc.params as { query?: Record<string, unknown> } | undefined)?.query
    // allPages: true neutralizes window filters in classification — windows are
    // computed locally below; anything else non-local still goes to the server.
    if (
      classifyQueryNode(q, { allPages: true, localOperators: this.#localOperators }) !==
      'local-exact'
    ) {
      return null
    }

    const { filters, sort, limit, skip } = splitWindow(q)
    const match = config.matcher
      ? (config.matcher(filters) as (item: unknown) => boolean)
      : (this.#adapter.matcher(filters as TQuery | undefined) as (item: unknown) => boolean)
    let rows = [...service.entities.values()].filter(match)
    if (sort) rows = sortRowsLocally(rows, sort)
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
          state:
            query.state.status === 'error'
              ? {
                  status: 'loading' as const,
                  data: null,
                  meta: query.state.meta,
                  isFetching: true,
                  error: null,
                }
              : query.state.status === 'success'
                ? { ...query.state, isFetching: true }
                : {
                    status: query.state.status,
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

    const touched = this.#transactOverService(queryId, (service, query) => {
      if (!query) return

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
      const findConfig = query.config as FindQueryConfig<unknown, unknown>
      if (
        query.desc.method === 'find' &&
        findConfig.allPages &&
        isUnfilteredFindQuery(query.desc.params)
      ) {
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
    })
    this.#notify(touched)

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
    return this.#adapter.peekId ? this.#adapter.peekId(item) : undefined
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
    const type =
      method === 'create'
        ? 'created'
        : method === 'remove'
          ? 'removed'
          : method === 'update'
            ? 'updated'
            : 'patched'
    this.#processEvent(serviceName, { type, item })
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

    // Server-maintained queries never merge events locally either — they refetch.
    if (isServerMaintained(classification)) {
      return () => false
    }

    const query = (desc.params as Record<string, unknown>)?.query || undefined
    if (config.matcher) {
      return config.matcher(query as TQueryType | undefined) as ItemMatcher<ElementType<T>>
    }
    return this.#adapter.matcher(query as TQuery | undefined) as ItemMatcher<ElementType<T>>
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

type ItemId = string | number

function createServiceState<TMeta = Record<string, unknown>>(): ServiceState<TMeta> {
  return {
    entities: new Map(),
    queries: new Map(),
    itemQueryIndex: new Map(),
  }
}

function getQueryItems<TMeta = Record<string, unknown>>(
  query: Query<unknown, TMeta, unknown>,
): unknown[] {
  return Array.isArray(query.state.data)
    ? query.state.data
    : query.state.data
      ? [query.state.data]
      : []
}

function addQueryToItemIndex<TMeta>(
  service: ServiceState<TMeta>,
  itemId: ItemId,
  queryId: string,
): void {
  if (!service.itemQueryIndex.has(itemId)) {
    service.itemQueryIndex.set(itemId, new Set())
  }
  service.itemQueryIndex.get(itemId)!.add(queryId)
}

function removeQueryFromItemIndex<TMeta>({
  service,
  query,
  queryId,
  getId,
}: {
  service: ServiceState<TMeta>
  query: Query<unknown, TMeta, unknown>
  queryId: string
  getId: (item: unknown) => ItemId | undefined
}): void {
  for (const item of getQueryItems(query)) {
    const id = getId(item)
    if (id !== undefined && service.itemQueryIndex.has(id)) {
      service.itemQueryIndex.get(id)!.delete(queryId)
    }
  }
}

// Deliberately loose, unlike the strictly-keyed entity cache: get descriptors often
// carry numeric ids as strings (route params) while entities use numbers. The server
// performs the same coercion when resolving a get.
function isSameId(a: ItemId, b: ItemId): boolean {
  return String(a) === String(b)
}

function createItemRemovedError(itemId: ItemId): Error {
  const error = new Error(`Item ${String(itemId)} has been removed`)
  error.name = 'ItemRemoved'
  return error
}

// `$sort` doesn't affect which rows are fetched, so a sorted-but-unfiltered
// allPages query still proves the complete row set.
function isUnfilteredFindQuery(params: unknown): boolean {
  const q = (params as { query?: Record<string, unknown> } | undefined)?.query
  return !q || Object.keys(q).every(key => key === '$sort')
}

/** Split window operators off a query so the rest can feed the local matcher. */
function splitWindow(q: Record<string, unknown> | undefined): {
  filters: Record<string, unknown> | undefined
  sort: Record<string, number> | undefined
  limit: number | undefined
  skip: number
} {
  if (!q) return { filters: undefined, sort: undefined, limit: undefined, skip: 0 }
  const { $sort, $limit, $skip, ...filters } = q
  return {
    filters: Object.keys(filters).length > 0 ? filters : undefined,
    sort: $sort as Record<string, number> | undefined,
    limit: $limit as number | undefined,
    skip: ($skip as number | undefined) ?? 0,
  }
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === undefined || a === null) return -1
  if (b === undefined || b === null) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

function sortRowsLocally(rows: unknown[], sort: Record<string, number>): unknown[] {
  const entries = Object.entries(sort)
  return [...rows].sort((a, b) => {
    for (const [field, direction] of entries) {
      const cmp = compareValues(
        (a as Record<string, unknown>)[field],
        (b as Record<string, unknown>)[field],
      )
      if (cmp !== 0) return direction === -1 ? -cmp : cmp
    }
    return 0
  })
}

function groupQueuedEvents(events: QueuedEvent[]): Record<string, QueuedEvent[]> {
  const eventsByService: Record<string, QueuedEvent[]> = {}
  for (const event of events) {
    if (!eventsByService[event.serviceName]) {
      eventsByService[event.serviceName] = []
    }
    eventsByService[event.serviceName]!.push(event)
  }
  return eventsByService
}

function applyEventsToService<TMeta>({
  service,
  serviceName,
  events,
  getId,
  isItemStale,
  processedEvents,
}: {
  service: ServiceState<TMeta>
  serviceName: string
  events: QueuedEvent[]
  getId: (item: unknown) => ItemId | undefined
  isItemStale: (curr: unknown, next: unknown) => boolean
  processedEvents: ProcessedRealtimeEvent[]
}): void {
  for (const event of events) {
    const { type, items } = event
    for (const item of items) {
      if (type === 'created') {
        const itemId = getId(item)
        if (itemId !== undefined) {
          const previousItem = service.entities.get(itemId) ?? null
          service.entities.set(itemId, item)
          processedEvents.push({ serviceName, type, item, previousItem, itemId })
        }
      } else if (type === 'updated' || type === 'patched') {
        const itemId = getId(item)
        if (itemId !== undefined) {
          const currItem = service.entities.get(itemId)
          if (!currItem || !isItemStale(currItem, item)) {
            service.entities.set(itemId, item)
            processedEvents.push({
              serviceName,
              type,
              item,
              previousItem: currItem ?? null,
              itemId,
            })
          }
        }
      } else if (type === 'removed') {
        const itemId = getId(item)
        if (itemId !== undefined) {
          const previousItem = service.entities.get(itemId) ?? null
          service.entities.delete(itemId)
          processedEvents.push({ serviceName, type, item, previousItem, itemId })
        }
      }
    }
  }
}

function updateQueriesFromEvents<TMeta>({
  service,
  appliedItems,
  touch,
  getId,
  itemAdded,
  itemRemoved,
  serverMaintainedQueriesToRefetch,
}: {
  service: ServiceState<TMeta>
  appliedItems: ProcessedRealtimeEvent[]
  touch: (queryId: string) => void
  getId: (item: unknown) => ItemId | undefined
  itemAdded: (meta: TMeta) => TMeta
  itemRemoved: (meta: TMeta) => TMeta
  serverMaintainedQueriesToRefetch: Set<string>
}): void {
  for (const { type, item, itemId } of appliedItems) {
    if (!service.itemQueryIndex.has(itemId)) {
      service.itemQueryIndex.set(itemId, new Set())
    }
    const itemQueryIndex = service.itemQueryIndex.get(itemId)!

    for (const [queryId, query] of service.queries) {
      let matches: boolean

      if (query.config.realtime !== 'merge') {
        continue
      }

      if (query.desc.method === 'find' && query.config.fetchPolicy === 'network-only') {
        continue
      }

      if (isServerMaintained(query.classification)) {
        serverMaintainedQueriesToRefetch.add(queryId)
        continue
      }

      if (type === 'removed') {
        matches = false
      } else {
        matches = query.filterItem(item)
      }

      const hasItem = itemQueryIndex.has(queryId)
      if (hasItem && !matches) {
        // remove
        const query = service.queries.get(queryId)!
        // A get query whose item was removed reaches a terminal, refetchable error
        // state (the resource no longer exists — same as a server NotFound). It must
        // not park in 'loading': nothing would ever complete that fetch, and
        // relational consumers would serve the stale previous snapshot forever.
        const nextState: QueryState<unknown, TMeta> =
          query.desc.method === 'get' && query.state.status === 'success'
            ? {
                status: 'error' as const,
                data: null,
                meta: itemRemoved(query.state.meta),
                isFetching: false,
                error: createItemRemovedError(itemId),
              }
            : query.state.status === 'success'
              ? {
                  ...query.state,
                  meta: itemRemoved(query.state.meta),
                  data: (query.state.data as unknown[]).filter((x: unknown) => getId(x) !== itemId),
                }
              : query.state
        service.queries.set(queryId, {
          ...query,
          state: nextState,
        })
        itemQueryIndex.delete(queryId)
        touch(queryId)
      } else if (hasItem && matches) {
        // update
        service.queries.set(queryId, {
          ...query,
          state:
            query.state.status === 'success'
              ? {
                  ...query.state,
                  data:
                    query.desc.method === 'get'
                      ? item
                      : (query.state.data as unknown[]).map((x: unknown) =>
                          getId(x) === itemId ? item : x,
                        ),
                }
              : query.state,
        })
        touch(queryId)
      } else if (matches && query.desc.method === 'find' && query.state.data) {
        service.queries.set(queryId, {
          ...query,
          state:
            query.state.status === 'success'
              ? {
                  ...query.state,
                  meta: itemAdded(query.state.meta),
                  data: (query.state.data as unknown[]).concat(item),
                }
              : query.state,
        })
        itemQueryIndex.add(queryId)
        touch(queryId)
      } else if (
        matches &&
        type === 'created' &&
        query.desc.method === 'get' &&
        isSameId(query.desc.resourceId, itemId)
      ) {
        // The resource behind a get query reappeared (realtime re-create, or an
        // optimistic remove rolling back). Restore the query from the event instead
        // of leaving it in the removed-error state until a manual refetch.
        service.queries.set(queryId, {
          ...query,
          state: {
            status: 'success' as const,
            data: item,
            meta: query.state.meta,
            isFetching: false,
            error: null,
          },
        })
        itemQueryIndex.add(queryId)
        touch(queryId)
      }
    }
  }
}
