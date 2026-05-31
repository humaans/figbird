import type { Adapter, QueryResponse } from '../adapters/adapter.js'
import type { AnySchema, Schema } from './schema.js'
import type { QueryRef } from './queryRef.js'
import type {
  ElementType,
  Event,
  FindQueryConfig,
  InferMutationData,
  ItemMatcher,
  MutationDescriptor,
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

  #realtime: Set<string> = new Set()
  #listeners: Map<string, Set<(state: QueryState<unknown, TMeta>) => void>> = new Map()
  #globalListeners: Set<(state: Map<string, ServiceState<TMeta>>) => void> = new Set()

  #state: Map<string, ServiceState<TMeta>> = new Map()
  #serviceNamesByQueryId: Map<string, string> = new Map()

  #eventQueue: QueuedEvent[] = []
  #eventBatchProcessingTimer: ReturnType<typeof setTimeout> | null = null
  #eventBatchProcessingInterval: number | undefined = 100

  constructor({
    adapter,
    eventBatchProcessingInterval = 100,
  }: {
    adapter: Adapter<TParams, TMeta, TQuery>
    eventBatchProcessingInterval?: number | undefined
  }) {
    this.#adapter = adapter
    this.#eventBatchProcessingInterval = eventBatchProcessingInterval
  }

  // Public store API
  /** Returns the entire store state map keyed by service name. */
  getState(): Map<string, ServiceState<TMeta>> {
    return this.#state
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
    const { serviceName, method } = desc
    const updaters: Record<string, (item: unknown) => void> = {
      create: item => this.#processEvent(serviceName, { type: 'created', item }),
      update: item => this.#processEvent(serviceName, { type: 'updated', item }),
      patch: item => this.#processEvent(serviceName, { type: 'patched', item }),
      remove: item => this.#processEvent(serviceName, { type: 'removed', item }),
    }

    // Convert named params to args array for the adapter
    const args = this.#buildMutationArgs(desc)

    return this.#adapter.mutate(serviceName, method, args).then((item: unknown) => {
      updaters[method]?.(item)
      return item as InferMutationData<S, D>
    })
  }

  // Query lifecycle
  async #queue(queryId: string): Promise<void> {
    this.#fetching({ queryId })
    try {
      const result = await this.#fetch(queryId)
      this.#fetched({ queryId, result })
    } catch (err) {
      this.#fetchFailed({ queryId, error: err instanceof Error ? err : new Error(String(err)) })
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
    })
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

    const { serviceName } = query.desc

    // check if already subscribed to the events of this service
    if (this.#realtime.has(serviceName)) {
      return
    }

    if (!this.#adapter.subscribe) {
      return // Real-time not supported by this adapter
    }

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

  #processEvent(serviceName: string, event: Event): void {
    this.#eventQueue.push({
      serviceName,
      type: event.type,
      items: Array.isArray(event.item) ? event.item : [event.item],
    })

    this.#processQueuedEvents()
  }

  #queueEvent(serviceName: string, event: Event): void {
    this.#eventQueue.push({
      serviceName,
      type: event.type,
      items: Array.isArray(event.item) ? event.item : [event.item],
    })

    if (!this.#eventBatchProcessingTimer) {
      // process all events in a short interval as a batch later
      if (this.#eventBatchProcessingInterval) {
        this.#eventBatchProcessingTimer = setTimeout(() => {
          this.#processQueuedEvents()
          this.#eventBatchProcessingTimer = null
        }, this.#eventBatchProcessingInterval)
      } else {
        // batching is disabled, process each event immediately
        this.#processQueuedEvents()
      }
    }
  }

  #processQueuedEvents(): void {
    if (this.#eventQueue.length === 0) {
      return
    }

    const eventsByService = groupQueuedEvents(this.#eventQueue)
    const getId = (item: unknown) => this.#adapter.getId(item)
    const isItemStale = (curr: unknown, next: unknown) => this.#adapter.isItemStale(curr, next)

    for (const [serviceName, events] of Object.entries(eventsByService)) {
      this.#transactOverServiceByName(serviceName, (service, touch) => {
        const appliedEvents = applyEventsToService({
          service,
          events,
          getId,
          isItemStale,
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
          })
        }
      })

      // Refetch refetchable queries if needed
      this.#refetchRefetchableQueries(serviceName)
    }

    this.#eventQueue = []
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
    { silent = false } = {},
  ): void {
    const modifiedQueries = new Set<string>()

    // Modify fn to track changes
    const touch = (queryId: string) => modifiedQueries.add(queryId)

    mutate(this.#state, touch)

    if (!silent && modifiedQueries.size > 0) {
      for (const queryId of modifiedQueries) {
        this.#invokeListeners(queryId)
      }
      this.#invokeGlobalListeners()
    }
  }

  #transactOverService(
    queryId: string,
    fn: (
      service: ServiceState<TMeta>,
      query?: Query<unknown, TMeta, unknown>,
      touch?: (queryId: string) => void,
    ) => void,
    options?: { silent?: boolean },
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
    { silent = false } = {},
  ): void {
    if (serviceName) {
      // initialise the service structure if needed
      if (!this.getState().get(serviceName)) {
        this.getState().set(serviceName, createServiceState())
      }

      this.#updateState(
        (state, touch) => {
          const service = state.get(serviceName)
          if (service) {
            fn(service, touch)
          }
        },
        { silent },
      )
    }
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
  events,
  getId,
  isItemStale,
}: {
  service: ServiceState<TMeta>
  events: QueuedEvent[]
  getId: (item: unknown) => ItemId | undefined
  isItemStale: (curr: unknown, next: unknown) => boolean
}): QueuedEvent[] {
  const appliedEvents: QueuedEvent[] = []
  for (const event of events) {
    const { type, items } = event
    for (const item of items) {
      if (type === 'created') {
        const itemId = getId(item)
        if (itemId !== undefined) {
          service.entities.set(itemId, item)
          appliedEvents.push(event)
        }
      } else if (type === 'updated' || type === 'patched') {
        const itemId = getId(item)
        if (itemId !== undefined) {
          const currItem = service.entities.get(itemId)
          if (!currItem || !isItemStale(currItem, item)) {
            service.entities.set(itemId, item)
            appliedEvents.push(event)
          }
        }
      } else if (type === 'removed') {
        const itemId = getId(item)
        if (itemId !== undefined) {
          service.entities.delete(itemId)
          appliedEvents.push(event)
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
}: {
  service: ServiceState<TMeta>
  appliedEvents: QueuedEvent[]
  touch: (queryId: string) => void
  getId: (item: unknown) => ItemId | undefined
  itemAdded: (meta: TMeta) => TMeta
  itemRemoved: (meta: TMeta) => TMeta
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

        if (type === 'removed') {
          matches = false
        } else {
          matches = query.filterItem(item)
        }

        const hasItem = itemQueryIndex.has(queryId)
        if (hasItem && !matches) {
          // remove
          const query = service.queries.get(queryId)!
          const nextState: QueryState<unknown, TMeta> =
            query.desc.method === 'get' && query.state.status === 'success'
              ? {
                  status: 'loading' as const,
                  data: null,
                  meta: itemRemoved(query.state.meta),
                  isFetching: false,
                  error: null,
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
        }
      }
    }
  }
}
