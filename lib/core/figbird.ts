import type { AnySchema, Schema } from '../schema/types.js'
import type { Adapter, EventType, Response } from '../types.js'
import { hashObject } from './hash.js'

/**
 * Internal event representation
 */
export interface Event {
  type: EventType
  item: unknown
}

/**
 * Queued event for batch processing
 */
export interface QueuedEvent {
  serviceName: string
  type: EventType
  items: unknown[]
}

export type QueryStatus = 'idle' | 'loading' | 'success' | 'error'

/**
 * Query state representation
 */
export interface QueryState<T> {
  data: T | null
  meta: Record<string, unknown>
  status: QueryStatus
  isFetching: boolean
  error: Error | null
}

/**
 * Internal query representation
 */
export interface Query {
  queryId: string
  desc: QueryDescriptor
  config: QueryConfig
  pending: boolean
  dirty: boolean
  filterItem: (item: unknown) => boolean
  state: QueryState<unknown>
}

/**
 * Service state in the store
 */
export interface ServiceState {
  entities: Map<string | number, unknown>
  queries: Map<string, Query>
  itemQueryIndex: Map<string | number, Set<string>>
}

/**
 * Query descriptor
 */
export interface QueryDescriptor {
  serviceName: string
  method: 'get' | 'find'
  resourceId?: string | number
  params?: unknown
}

/**
 * Query configuration
 */
export interface QueryConfig {
  skip?: boolean
  realtime?: 'merge' | 'refetch' | 'disabled'
  fetchPolicy?: 'swr' | 'cache-first' | 'network-only'
  allPages?: boolean
  matcher?: <T>(query: unknown) => (item: T) => boolean
}

/**
 * Combined config for internal use
 */
export interface CombinedConfig extends QueryDescriptor, QueryConfig {
  [key: string]: unknown
}

/**
 * Item matcher function type
 */
export type ItemMatcher<T> = (item: T) => boolean

/**
    Usage:

    const adapter = new FeathersAdapter({ feathers })
    const figbird = new Figbird({ adapter })

    const q = figbird.query({ serviceName: 'notes', method: 'find' })

    // Execute query and begin listening for realtime updates
    const unsub = q.subscribe(state => console.log(state.status, state.data))

    // Get current query state synchronously
    q.getSnapshot()

    // Stop listening to updates while preserving the query state and data in cache.
    // The query state can be recovered by creating a new query with the same parameters.
    // Multiple queries can safely reference the same cached state.
    unsub()
*/
export class Figbird<S extends Schema = AnySchema> {
  adapter: Adapter<unknown, unknown> | null = null
  queryStore: QueryStore
  schema?: S

  constructor({
    adapter,
    eventBatchProcessingInterval,
    schema,
  }: {
    adapter: Adapter<unknown, unknown>
    eventBatchProcessingInterval?: number
    schema?: S
  }) {
    this.adapter = adapter
    this.schema = schema
    this.queryStore = new QueryStore({
      adapter,
      eventBatchProcessingInterval,
    })
  }

  getState(): Map<string, ServiceState> {
    return this.queryStore.getState()
  }

  query<T>(desc: QueryDescriptor, config?: QueryConfig): QueryRef<T> {
    return new QueryRef<T>({
      desc,
      config: config || {},
      queryStore: this.queryStore,
    })
  }

  mutate<T = unknown>({
    serviceName,
    method,
    args,
  }: {
    serviceName: string
    method: string
    args: unknown[]
  }): Promise<T> {
    return this.queryStore.mutate({ serviceName, method, args })
  }

  subscribeToStateChanges(fn: (state: Map<string, ServiceState>) => void): () => void {
    return this.queryStore.subscribeToStateChanges(fn)
  }
}

/**
 * A helper to split the properties into a query descriptor `desc` (including 'params')
 * and figbird-specific query configuration `config`
 */
export function splitConfig(combinedConfig: CombinedConfig): {
  desc: QueryDescriptor
  config: QueryConfig
} {
  const {
    serviceName,
    method,
    resourceId,
    allPages,
    skip,
    realtime = 'merge',
    fetchPolicy = 'swr',
    matcher,
    ...params // pass through params
  } = combinedConfig

  // query descriptor, describes the shape
  // of the query and is passed to the adapter
  const desc: QueryDescriptor = {
    serviceName,
    method,
    resourceId,
    params,
  }

  // figbird specific config options that
  // drive the query lifecycle
  let config: QueryConfig = {
    skip,
    realtime,
    fetchPolicy,
    allPages,
    matcher,
  }

  return { desc, config }
}

// a lightweight query reference object to make it easy
// subscribe to state changes and read query data
// this is only a ref and does not contain state itself, it instead
// references all the state from the shared figbird query state
class QueryRef<T> {
  #queryId: string
  #desc: QueryDescriptor
  #config: QueryConfig
  #queryStore: QueryStore

  constructor({
    desc,
    config,
    queryStore,
  }: {
    desc: QueryDescriptor
    config: QueryConfig
    queryStore: QueryStore
  }) {
    this.#queryId = `q/${hashObject({ desc, config })}`
    this.#desc = desc
    this.#config = config
    this.#queryStore = queryStore
  }

  details(): { queryId: string; desc: QueryDescriptor; config: QueryConfig } {
    return {
      queryId: this.#queryId,
      desc: this.#desc,
      config: this.#config,
    }
  }

  hash(): string {
    return this.#queryId
  }

  subscribe(fn: (state: QueryState<T>) => void): () => void {
    this.#queryStore.materialize(this)
    return this.#queryStore.subscribe<T>(this.#queryId, fn)
  }

  getSnapshot(): QueryState<T> | undefined {
    this.#queryStore.materialize(this)
    return this.#queryStore.getQueryState<T>(this.#queryId)
  }

  refetch(): void {
    this.#queryStore.materialize(this)
    return this.#queryStore.refetch(this.#queryId)
  }
}

class QueryStore {
  #adapter: Adapter<unknown, unknown>

  #realtime: Set<string> = new Set()
  #listeners: Map<string, Set<(state: QueryState<unknown>) => void>> = new Map()
  #globalListeners: Set<(state: Map<string, ServiceState>) => void> = new Set()

  #state: Map<string, ServiceState> = new Map()
  #serviceNamesByQueryId: Map<string, string> = new Map()

  #eventQueue: QueuedEvent[] = []
  #eventBatchProcessingTimer: ReturnType<typeof setTimeout> | null = null
  #eventBatchProcessingInterval: number = 100

  constructor({
    adapter,
    eventBatchProcessingInterval = 100,
  }: {
    adapter: Adapter<unknown, unknown>
    eventBatchProcessingInterval?: number
  }) {
    this.#adapter = adapter
    this.#eventBatchProcessingInterval = eventBatchProcessingInterval
  }

  #getQuery(queryId: string): Query | undefined {
    const serviceName = this.#serviceNamesByQueryId.get(queryId)
    if (serviceName) {
      const service = this.getState().get(serviceName)
      if (service) {
        return service.queries.get(queryId)
      }
    }
    return undefined
  }

  getQueryState<T>(queryId: string): QueryState<T> | undefined {
    return this.#getQuery(queryId)?.state as QueryState<T> | undefined
  }

  materialize<T>(queryRef: QueryRef<T>): void {
    const { queryId, desc, config } = queryRef.details()

    if (!this.#getQuery(queryId)) {
      this.#serviceNamesByQueryId.set(queryId, desc.serviceName)

      this.#transactOverService(
        queryId,
        service => {
          service.queries.set(queryId, {
            queryId,
            desc,
            config,
            pending: !config.skip,
            dirty: false,
            filterItem: this.#createItemFilter<unknown>(desc, config) as (item: unknown) => boolean,
            state: config.skip
              ? {
                  data: null,
                  meta: {},
                  status: 'idle',
                  isFetching: false,
                  error: null,
                }
              : {
                  data: null,
                  meta: {},
                  status: 'loading',
                  isFetching: true,
                  error: null,
                },
          })
        },
        { silent: true },
      )
    }
  }

  #createItemFilter<T>(desc: QueryDescriptor, config: QueryConfig): ItemMatcher<T> {
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

    const query = (desc.params as Record<string, unknown>)?.query || null
    if (config.matcher) {
      return config.matcher(query)
    }
    return this.#adapter.matcher(query) as ItemMatcher<T>
  }

  #addListener<T>(queryId: string, fn: (state: QueryState<T>) => void): () => void {
    if (!this.#listeners.has(queryId)) {
      this.#listeners.set(queryId, new Set())
    }
    this.#listeners.get(queryId)!.add(fn as (state: QueryState<unknown>) => void)
    return () => {
      const listeners = this.#listeners.get(queryId)
      if (listeners) {
        listeners.delete(fn as (state: QueryState<unknown>) => void)
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

  #addGlobalListener(fn: (state: Map<string, ServiceState>) => void): () => void {
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

  subscribe<T>(queryId: string, fn: (state: QueryState<T>) => void): () => void {
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

    const shouldVacuumByDefault = q.config.fetchPolicy === 'network-only'
    return ({ vacuum = shouldVacuumByDefault }: { vacuum?: boolean } = {}) => {
      removeListener()
      if (vacuum && this.#listenerCount(queryId) === 0) {
        this.#vacuum({ queryId })
      }
    }
  }

  subscribeToStateChanges(fn: (state: Map<string, ServiceState>) => void): () => void {
    return this.#addGlobalListener(fn)
  }

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

  async #queue(queryId: string): Promise<void> {
    this.#fetching({ queryId })
    try {
      const result = await this.#fetch(queryId)
      this.#fetched({ queryId, result })
    } catch (err) {
      this.#fetchFailed({ queryId, error: err instanceof Error ? err : new Error(String(err)) })
    }
  }

  #fetch(queryId: string): Promise<Response<unknown>> {
    const query = this.#getQuery(queryId)
    if (!query) {
      return Promise.reject(new Error('Query not found'))
    }

    const { serviceName, method, resourceId, params } = query.desc
    const { allPages } = query.config

    if (method === 'get') {
      return this.#adapter.get(serviceName, resourceId!, params)
    } else if (allPages) {
      return this.#adapter.findAll(serviceName, params)
    } else {
      return this.#adapter.find(serviceName, params)
    }
  }

  mutate<T = unknown>({
    serviceName,
    method,
    args,
  }: {
    serviceName: string
    method: string
    args: unknown[]
  }): Promise<T> {
    const updaters: Record<string, (item: unknown) => void> = {
      create: item => this.#processEvent(serviceName, { type: 'created', item }),
      update: item => this.#processEvent(serviceName, { type: 'updated', item }),
      patch: item => this.#processEvent(serviceName, { type: 'patched', item }),
      remove: item => this.#processEvent(serviceName, { type: 'removed', item }),
    }

    return this.#adapter.mutate(serviceName, method, args).then((item: unknown) => {
      updaters[method]?.(item)
      return item as T
    })
  }

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

    // Group events by service
    const eventsByService: Record<string, QueuedEvent[]> = {}
    for (const event of this.#eventQueue) {
      if (!eventsByService[event.serviceName]) {
        eventsByService[event.serviceName] = []
      }
      eventsByService[event.serviceName]!.push(event)
    }

    const getId = (item: unknown) => this.#adapter.getId(item)
    const isItemStale = (curr: unknown, next: unknown) => this.#adapter.isItemStale(curr, next)

    for (const [serviceName, events] of Object.entries(eventsByService)) {
      this.#transactOverServiceByName(serviceName, (service, touch) => {
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

        // Update queries only for non-stale items
        if (appliedEvents.length > 0) {
          this.#updateQueriesFromEvents(service, appliedEvents, touch)
        }
      })

      // Refetch refetchable queries if needed
      this.#refetchRefetchableQueries(serviceName)
    }

    this.#eventQueue = []
  }

  #updateQueriesFromEvents(
    service: ServiceState,
    appliedEvents: QueuedEvent[],
    touch: (queryId: string) => void,
  ): void {
    const getId = (item: unknown) => this.#adapter.getId(item)
    const itemAdded = (meta: Record<string, unknown>) => this.#adapter.itemAdded(meta)
    const itemRemoved = (meta: Record<string, unknown>) => this.#adapter.itemRemoved(meta)
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
            service.queries.set(queryId, {
              ...query,
              state: {
                ...query.state,
                meta: itemRemoved(query.state.meta),
                data:
                  query.desc.method === 'get'
                    ? null
                    : (query.state.data as unknown[]).filter((x: unknown) => getId(x) !== itemId),
              },
            })
            itemQueryIndex.delete(queryId)
            touch(queryId)
          } else if (hasItem && matches) {
            // update
            service.queries.set(queryId, {
              ...query,
              state: {
                ...query.state,
                data:
                  query.desc.method === 'get'
                    ? item
                    : (query.state.data as unknown[]).map((x: unknown) =>
                        getId(x) === itemId ? item : x,
                      ),
              },
            })
            touch(queryId)
          } else if (matches && query.desc.method === 'find' && query.state.data) {
            service.queries.set(queryId, {
              ...query,
              state: {
                ...query.state,
                meta: itemAdded(query.state.meta),
                data: (query.state.data as unknown[]).concat(item),
              },
            })
            itemQueryIndex.add(queryId)
            touch(queryId)
          }
        }
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

  getState(): Map<string, ServiceState> {
    return this.#state
  }

  #updateState(
    mutate: (state: Map<string, ServiceState>, touch: (queryId: string) => void) => void,
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
    fn: (service: ServiceState, query?: Query, touch?: (queryId: string) => void) => void,
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
    fn: (service: ServiceState, touch: (queryId: string) => void) => void,
    { silent = false } = {},
  ): void {
    if (serviceName) {
      // initialise the service structure if needed
      if (!this.getState().get(serviceName)) {
        this.getState().set(serviceName, {
          entities: new Map(),
          queries: new Map(),
          itemQueryIndex: new Map(),
        })
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

  #fetching({ queryId }: { queryId: string }): void {
    this.#transactOverService(queryId, (service, query) => {
      if (!query) return

      service.queries.set(queryId, {
        ...query,
        pending: false,
        dirty: false,
        state:
          query.state.status === 'error'
            ? { ...query.state, isFetching: true, status: 'loading', error: null }
            : { ...query.state, isFetching: true },
      })
    })
  }

  #fetched({ queryId, result }: { queryId: string; result: Response<unknown> }): void {
    let shouldRefetch = false

    this.#transactOverService(queryId, (service, query) => {
      if (!query) return

      const { data, meta } = result
      const items = Array.isArray(data) ? data : [data]
      const getId = (item: unknown) => this.#adapter.getId(item)

      for (const item of items) {
        const itemId = getId(item)
        if (itemId !== undefined) {
          service.entities.set(itemId, item)
          if (!service.itemQueryIndex.has(itemId)) {
            service.itemQueryIndex.set(itemId, new Set())
          }
          service.itemQueryIndex.get(itemId)!.add(queryId)
        }
      }

      shouldRefetch = query.dirty

      service.queries.set(queryId, {
        ...query,
        state: {
          data,
          meta: meta || {},
          status: 'success',
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
        ...query,
        state: {
          data: null,
          meta: {},
          status: 'error',
          isFetching: false,
          error,
        },
      })
    })

    if (shouldRefetch && this.#listenerCount(queryId) > 0) {
      this.#queue(queryId)
    }
  }

  #vacuum({ queryId }: { queryId: string }): void {
    this.#transactOverService(
      queryId,
      (service, query) => {
        if (query) {
          if (query.state.data) {
            const getId = (item: unknown) => this.#adapter.getId(item)
            for (const item of getItems(query)) {
              const id = getId(item)
              if (id !== undefined && service.itemQueryIndex.has(id)) {
                service.itemQueryIndex.get(id)!.delete(queryId)
              }
            }
          }
          service.queries.delete(queryId)
          this.#serviceNamesByQueryId.delete(queryId)
        }
      },
      { silent: true },
    )
  }
}

function getItems(query: Query): unknown[] {
  return Array.isArray(query.state.data)
    ? query.state.data
    : query.state.data
      ? [query.state.data]
      : []
}
