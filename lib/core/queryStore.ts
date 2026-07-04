import type { Adapter, QueryResponse } from '../adapters/adapter.js'
import type { AnySchema, Schema } from './schema.js'
import type { QueryRef } from './queryRef.js'
import { FigbirdEventEmitter, type MutationMethod } from './events.js'
import { isServerMaintainedFindQuery } from './queryClassification.js'
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

  #realtime: Set<string> = new Set()
  #listeners: Map<string, Set<(state: QueryState<unknown, TMeta>) => void>> = new Map()
  #globalListeners: Set<(state: Map<string, ServiceState<TMeta>>) => void> = new Set()
  #processedEventListeners: Set<(event: ProcessedRealtimeEvent) => void> = new Set()

  #state: Map<string, ServiceState<TMeta>> = new Map()
  #serviceNamesByQueryId: Map<string, string> = new Map()

  #eventQueue: QueuedEvent[] = []
  #eventBatchProcessingTimer: ReturnType<typeof setTimeout> | null = null
  #eventBatchProcessingInterval: number | undefined = 100
  #processingEventQueue = false
  // Query ids whose listener notification has been deferred to the next microtask
  // (see #scheduleDeferredNotify). Null when nothing is scheduled.
  #deferredNotifyQueryIds: Set<string> | null = null

  constructor({
    adapter,
    eventBatchProcessingInterval = 100,
    events,
  }: {
    adapter: Adapter<TParams, TMeta, TQuery>
    eventBatchProcessingInterval?: number | undefined
    events?: FigbirdEventEmitter
  }) {
    this.#adapter = adapter
    this.#eventBatchProcessingInterval = eventBatchProcessingInterval
    this.#events = events ?? new FigbirdEventEmitter()
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

      this.#transactOverService(
        queryId,
        service => {
          service.queries.set(queryId, {
            queryId,
            desc,
            config: config as QueryConfig<unknown, unknown>,
            pending: !config.skip,
            dirty: false,
            filterItem: this.#createItemFilter<unknown, unknown>(
              desc,
              config as QueryConfig<unknown, unknown>,
            ) as (item: unknown) => boolean,
            state: {
              status: 'loading' as const,
              data: null,
              meta: this.#adapter.emptyMeta(),
              isFetching: !config.skip,
              error: null,
            },
          })
        },
        { silent: true },
      )
    }
  }

  /**
   * Subscribe to a query state by id. Triggers fetches if needed.
   * Returns an unsubscribe function.
   */
  subscribe<T>(queryId: string, fn: (state: QueryState<T, TMeta>) => void): () => void {
    const q = this.#getQuery(queryId)
    if (!q) return () => {}

    if (
      q.pending ||
      (q.state.status === 'success' && q.config.fetchPolicy === 'swr' && !q.state.isFetching) ||
      (q.state.status === 'error' && !q.state.isFetching)
    ) {
      this.#queue(queryId)
    }

    const removeListener = this.#addListener(queryId, fn)

    this.#subscribeToRealtime(queryId)

    const shouldVacuumByDefault =
      q.config.fetchPolicy === 'network-only' || Boolean(q.config.matcher)
    return ({ vacuum = shouldVacuumByDefault }: { vacuum?: boolean } = {}) => {
      removeListener()
      if (vacuum && this.#listenerCount(queryId) === 0) {
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

  /** Refetch a specific query by id. */
  refetch(queryId: string): void {
    const q = this.#getQuery(queryId)
    if (!q) return

    if (!q.state.isFetching) {
      this.#queue(queryId)
    } else {
      // Mark as dirty to refetch after current fetch completes
      this.#transactOverService(
        queryId,
        (service, query) => {
          service.queries.set(queryId, {
            ...query!,
            dirty: true,
          })
        },
        { silent: true },
      )
    }
  }

  /** Perform a service mutation and update the store from the result. */
  mutate<D extends MutationDescriptor>(desc: D): Promise<InferMutationData<S, D>> {
    const { serviceName, method, optimistic } = desc
    const id = method !== 'create' ? desc.id : undefined
    const isOptimistic = optimistic !== undefined && optimistic !== false
    const optimisticItem = isOptimistic ? this.#resolveOptimisticItem(desc) : null
    const restoreItem =
      isOptimistic && method !== 'create' && id !== undefined
        ? this.#getEntity(serviceName, id)
        : null
    const startedAt = Date.now()
    this.#events.emit({
      kind: 'mutate:start',
      serviceName,
      method,
      ...(id !== undefined ? { id } : {}),
      optimistic: isOptimistic,
    })

    if (isOptimistic && optimisticItem !== null) {
      if (method === 'create') {
        // Optimistic items are tracked (and rolled back) by id. Without one, the
        // synthetic created event is silently dropped by the entity cache — warn so
        // the no-op is diagnosable instead of mystifying.
        const items = Array.isArray(optimisticItem) ? optimisticItem : [optimisticItem]
        if (items.some(item => this.#adapter.getId(item) === undefined)) {
          console.warn(
            `figbird: optimistic create on service "${serviceName}" has item(s) without an id ` +
              'and will not be applied to the cache. Optimistic creates need a client-generated ' +
              'id so the item can be tracked and rolled back — pass one explicitly via ' +
              '`optimistic: { id, ...data }`.',
          )
        }
      }
      this.#applyMutationEvent(serviceName, method, optimisticItem)
    }

    const updaters: Record<string, (item: unknown) => void> = {
      create: item => this.#processEvent(serviceName, { type: 'created', item }),
      update: item => this.#processEvent(serviceName, { type: 'updated', item }),
      patch: item => this.#processEvent(serviceName, { type: 'patched', item }),
      remove: item => this.#processEvent(serviceName, { type: 'removed', item }),
    }

    // Convert named params to args array for the adapter
    const args = this.#buildMutationArgs(desc)

    return this.#adapter.mutate(serviceName, method, args).then(
      (item: unknown) => {
        updaters[method]?.(item)
        this.#events.emit({
          kind: 'mutate:end',
          serviceName,
          method,
          durationMs: Date.now() - startedAt,
          ...(id !== undefined ? { id } : {}),
          optimistic: isOptimistic,
        })
        return item as InferMutationData<S, D>
      },
      (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err))
        if (isOptimistic) {
          this.#rollbackOptimistic(serviceName, method, id, optimisticItem, restoreItem)
          this.#events.emit({
            kind: 'mutate:rollback',
            serviceName,
            method,
            ...(id !== undefined ? { id } : {}),
          })
        }
        this.#events.emit({
          kind: 'mutate:error',
          serviceName,
          method,
          durationMs: Date.now() - startedAt,
          error,
          ...(id !== undefined ? { id } : {}),
          optimistic: isOptimistic,
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
      const findConfig = config as FindQueryConfig<unknown, unknown>
      return findConfig.allPages
        ? this.#adapter.findAll(desc.serviceName, desc.params as TParams)
        : this.#adapter.find(desc.serviceName, desc.params as TParams)
    }
  }

  #fetching({ queryId }: { queryId: string }): void {
    // This is the only listener-notifying transition reachable synchronously from
    // a React render (useQuery → suspensePromise → root/relation setup → subscribe
    // → #queue → here); everything past `await #fetch` is already async. Deferring
    // the notification (not the state write — the fetch still starts synchronously
    // and warm reads are unaffected) keeps other subscribed components from being
    // updated mid-render.
    this.#transactOverService(
      queryId,
      (service, query) => {
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
      },
      { defer: true },
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

    this.#transactOverService(queryId, (service, query) => {
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

    if (shouldRefetch && this.#listenerCount(queryId) > 0) {
      this.#queue(queryId)
    }
  }

  #fetchFailed({ queryId, error }: { queryId: string; error: Error }): void {
    let shouldRefetch = false

    this.#transactOverService(queryId, (service, query) => {
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
      if (this.#eventBatchProcessingInterval) {
        this.#eventBatchProcessingTimer = setTimeout(() => {
          this.#eventBatchProcessingTimer = null
          this.#processQueuedEvents()
        }, this.#eventBatchProcessingInterval)
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

          const modifiedQueries = this.#transactOverServiceByName(
            serviceName,
            (service, touch) => {
              const appliedEvents = applyEventsToService({
                service,
                serviceName,
                events,
                getId,
                isItemStale,
                processedEvents,
              })

              // Update queries only for non-stale items
              if (appliedEvents.length > 0) {
                updateQueriesFromEvents({
                  service,
                  appliedEvents,
                  touch,
                  getId,
                  itemAdded: meta => this.#adapter.itemAdded(meta),
                  itemRemoved: meta => this.#adapter.itemRemoved(meta),
                  serverMaintainedQueriesToRefetch,
                })
              }
            },
            { silent: true },
          )

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
          // Server-maintained queries can't merge events locally: refetch active ones,
          // mark inactive cached ones pending so their next subscription reconciles.
          for (const queryId of serverMaintainedQueriesToRefetch) {
            if (this.#listenerCount(queryId) > 0) {
              this.refetch(queryId)
            } else {
              this.#markQueryPending(queryId)
            }
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
        this.refetch(query.queryId)
      }
    }
  }

  #refetchActiveQueries(): void {
    for (const service of this.getState().values()) {
      for (const query of service.queries.values()) {
        if (
          !query.config.skip &&
          query.config.realtime !== 'disabled' &&
          this.#listenerCount(query.queryId) > 0
        ) {
          this.refetch(query.queryId)
        }
      }
    }
  }

  #markQueryPending(queryId: string): void {
    this.#transactOverService(
      queryId,
      (service, query) => {
        if (!query) return

        service.queries.set(queryId, {
          ...query,
          pending: true,
        })
      },
      { silent: true },
    )
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

  #updateState(
    mutate: (state: Map<string, ServiceState<TMeta>>, touch: (queryId: string) => void) => void,
    { silent = false, defer = false } = {},
  ): Set<string> {
    const modifiedQueries = new Set<string>()

    // Modify fn to track changes
    const touch = (queryId: string) => modifiedQueries.add(queryId)

    mutate(this.#state, touch)

    if (!silent && modifiedQueries.size > 0) {
      if (defer) {
        this.#scheduleDeferredNotify(modifiedQueries)
      } else {
        for (const queryId of modifiedQueries) {
          this.#invokeListeners(queryId)
        }
        this.#invokeGlobalListeners()
      }
    }

    return modifiedQueries
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

  #transactOverService(
    queryId: string,
    fn: (
      service: ServiceState<TMeta>,
      query?: Query<unknown, TMeta, unknown>,
      touch?: (queryId: string) => void,
    ) => void,
    options?: { silent?: boolean; defer?: boolean },
  ): void {
    const serviceName = this.#serviceNamesByQueryId.get(queryId)
    if (!serviceName) return

    this.#transactOverServiceByName(
      serviceName,
      (service, touch) => {
        fn(service, service.queries.get(queryId), touch)
        touch(queryId)
      },
      options,
    )
  }

  #transactOverServiceByName(
    serviceName: string,
    fn: (service: ServiceState<TMeta>, touch: (queryId: string) => void) => void,
    { silent = false, defer = false } = {},
  ): Set<string> {
    if (!serviceName) return new Set()

    // initialise the service structure if needed
    if (!this.getState().get(serviceName)) {
      this.getState().set(serviceName, createServiceState())
    }

    return this.#updateState(
      (state, touch) => {
        const service = state.get(serviceName)
        if (service) {
          fn(service, touch)
        }
      },
      { silent, defer },
    )
  }

  #vacuum({ queryId }: { queryId: string }): void {
    this.#transactOverService(
      queryId,
      (service, query) => {
        if (query) {
          if (query.state.data) {
            const getId = (item: unknown) => this.#adapter.getId(item)
            removeQueryFromItemIndex({ service, query, queryId, getId })
          }
          service.queries.delete(queryId)
          this.#serviceNamesByQueryId.delete(queryId)
        }
      },
      { silent: true },
    )
  }

  // Internal helpers
  #createItemFilter<T, TQueryType>(
    desc: QueryDescriptor,
    config: QueryConfig<T, TQueryType>,
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
    if (desc.method === 'find' && isServerMaintainedFindQuery(desc, config)) {
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
}): QueuedEvent[] {
  const appliedEvents: QueuedEvent[] = []
  for (const event of events) {
    const { type, items } = event
    for (const item of items) {
      if (type === 'created') {
        const itemId = getId(item)
        if (itemId !== undefined) {
          const previousItem = service.entities.get(itemId) ?? null
          service.entities.set(itemId, item)
          appliedEvents.push(event)
          processedEvents.push({ serviceName, type, item, previousItem, itemId })
        }
      } else if (type === 'updated' || type === 'patched') {
        const itemId = getId(item)
        if (itemId !== undefined) {
          const currItem = service.entities.get(itemId)
          if (!currItem || !isItemStale(currItem, item)) {
            service.entities.set(itemId, item)
            appliedEvents.push(event)
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
          appliedEvents.push(event)
          processedEvents.push({ serviceName, type, item, previousItem, itemId })
        }
      }
    }
  }

  return appliedEvents
}

function updateQueriesFromEvents<TMeta>({
  service,
  appliedEvents,
  touch,
  getId,
  itemAdded,
  itemRemoved,
  serverMaintainedQueriesToRefetch,
}: {
  service: ServiceState<TMeta>
  appliedEvents: QueuedEvent[]
  touch: (queryId: string) => void
  getId: (item: unknown) => ItemId | undefined
  itemAdded: (meta: TMeta) => TMeta
  itemRemoved: (meta: TMeta) => TMeta
  serverMaintainedQueriesToRefetch: Set<string>
}): void {
  for (const { type, items } of appliedEvents) {
    for (const item of items) {
      const itemId = getId(item)
      if (itemId === undefined) continue

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

        if (query.desc.method === 'find' && isServerMaintainedFindQuery(query.desc, query.config)) {
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
                    data: (query.state.data as unknown[]).filter(
                      (x: unknown) => getId(x) !== itemId,
                    ),
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
}
