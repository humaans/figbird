import type {
  Adapter,
  AdapterMeta,
  AdapterParams,
  AdapterQuery,
  QueryResponse,
} from '../adapters/adapter.js'
import { hashObject } from './hash.js'
import type { AnySchema, Schema, ServiceItem, ServiceNames } from './schema.js'

/**
 * Event types supported by Figbird
 */
export type EventType = 'created' | 'updated' | 'patched' | 'removed'

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
 * Query state representation - discriminated union for better type safety
 */
export type QueryState<T, TMeta = Record<string, unknown>> =
  | {
      status: 'idle' | 'loading'
      data: null
      meta: TMeta
      isFetching: boolean
      error: null
    }
  | {
      status: 'success'
      data: T
      meta: TMeta
      isFetching: boolean
      error: null
    }
  | {
      status: 'error'
      data: null
      meta: TMeta
      isFetching: boolean
      error: Error
    }

/**
 * Internal query representation
 */
export interface Query<T = unknown, TMeta = Record<string, unknown>> {
  queryId: string
  desc: QueryDescriptor
  config: QueryConfig<T>
  pending: boolean
  dirty: boolean
  filterItem: (item: T) => boolean
  state: QueryState<T, TMeta>
}

/**
 * Service state in the store
 */
export interface ServiceState<TMeta = Record<string, unknown>> {
  entities: Map<string | number, unknown>
  queries: Map<string, Query<unknown, TMeta>>
  itemQueryIndex: Map<string | number, Set<string>>
}

/**
 * Query descriptor for get operations
 */
export interface GetDescriptor {
  serviceName: string
  method: 'get'
  resourceId: string | number
  params?: unknown
}

/**
 * Query descriptor for find operations
 */
export interface FindDescriptor {
  serviceName: string
  method: 'find'
  params?: unknown
}

/**
 * Discriminated union of query descriptors
 */
export type QueryDescriptor = GetDescriptor | FindDescriptor

/**
 * Base query configuration shared by all query types
 */
interface BaseQueryConfig<TItem = unknown> {
  skip?: boolean
  realtime?: 'merge' | 'refetch' | 'disabled'
  fetchPolicy?: 'swr' | 'cache-first' | 'network-only'
  matcher?: (query: unknown) => (item: TItem) => boolean
}

/**
 * Configuration for get queries
 */
export type GetQueryConfig<TItem = unknown> = BaseQueryConfig<TItem>

/**
 * Configuration for find queries
 */
export interface FindQueryConfig<TItem = unknown> extends BaseQueryConfig<TItem> {
  allPages?: boolean
}

/**
 * Discriminated union of query configurations
 */
export type QueryConfig<TItem = unknown> = GetQueryConfig<TItem> | FindQueryConfig<TItem>

/**
 * Combined config for get operations
 * Combines the descriptor and config properties with index signature for extra params
 */
export type CombinedGetConfig<TItem = unknown> = GetDescriptor &
  GetQueryConfig<TItem> & {
    [key: string]: unknown
  }

/**
 * Combined config for find operations
 * Combines the descriptor and config properties with index signature for extra params
 */
export type CombinedFindConfig<TItem = unknown> = FindDescriptor &
  FindQueryConfig<TItem> & {
    [key: string]: unknown
  }

/**
 * Combined config for internal use
 */
export type CombinedConfig<TItem = unknown> = CombinedGetConfig<TItem> | CombinedFindConfig<TItem>

/**
 * Item matcher function type
 */
export type ItemMatcher<T> = (item: T) => boolean

/**
 * Helper type to infer data type from schema and query descriptor
 */
type InferQueryData<S extends Schema, D extends QueryDescriptor> = S extends AnySchema
  ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any
  : D extends { serviceName: infer N; method: 'find' }
    ? N extends ServiceNames<S>
      ? ServiceItem<S, N>[]
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        any
    : D extends { serviceName: infer N; method: 'get' }
      ? N extends ServiceNames<S>
        ? ServiceItem<S, N>
        : // eslint-disable-next-line @typescript-eslint/no-explicit-any
          any
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        any

/**
 * Helper type to infer data type from schema and mutation descriptor
 */
type InferMutationData<S extends Schema, D extends MutationDescriptor> = S extends AnySchema
  ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any
  : D extends { serviceName: infer N; method: 'create' }
    ? N extends ServiceNames<S>
      ? ServiceItem<S, N>
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        any
    : D extends { serviceName: infer N; method: 'update' }
      ? N extends ServiceNames<S>
        ? ServiceItem<S, N>
        : // eslint-disable-next-line @typescript-eslint/no-explicit-any
          any
      : D extends { serviceName: infer N; method: 'patch' }
        ? N extends ServiceNames<S>
          ? ServiceItem<S, N>
          : // eslint-disable-next-line @typescript-eslint/no-explicit-any
            any
        : D extends { serviceName: infer N; method: 'remove' }
          ? N extends ServiceNames<S>
            ? ServiceItem<S, N>
            : // eslint-disable-next-line @typescript-eslint/no-explicit-any
              any
          : // eslint-disable-next-line @typescript-eslint/no-explicit-any
            any

/**
 * Descriptor for mutation operations
 */
export interface MutationDescriptor {
  serviceName: string
  method: 'create' | 'update' | 'patch' | 'remove'
  args: unknown[]
}

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
export class Figbird<
  S extends Schema = AnySchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  A extends Adapter<any, any, any> = Adapter<
    unknown,
    Record<string, unknown>,
    Record<string, unknown>
  >,
> {
  adapter: A
  queryStore: QueryStore<S, AdapterParams<A>, AdapterMeta<A>, AdapterQuery<A>>
  schema: S | undefined

  constructor({
    adapter,
    eventBatchProcessingInterval,
    schema,
  }: {
    adapter: A
    eventBatchProcessingInterval?: number
    schema?: S
  }) {
    this.adapter = adapter
    this.schema = schema
    this.queryStore = new QueryStore<S, AdapterParams<A>, AdapterMeta<A>, AdapterQuery<A>>({
      adapter,
      eventBatchProcessingInterval: eventBatchProcessingInterval,
    })
  }

  getState(): Map<string, ServiceState<AdapterMeta<A>>> {
    return this.queryStore.getState()
  }

  query<D extends QueryDescriptor>(
    desc: D,
    config?: QueryConfig<InferQueryData<S, D>>,
  ): QueryRef<InferQueryData<S, D>, S, AdapterParams<A>, AdapterMeta<A>, AdapterQuery<A>> {
    return new QueryRef<InferQueryData<S, D>, S, AdapterParams<A>, AdapterMeta<A>, AdapterQuery<A>>(
      {
        desc,
        config: config || {},
        queryStore: this.queryStore,
      },
    )
  }

  mutate<D extends MutationDescriptor>(desc: D): Promise<InferMutationData<S, D>> {
    return this.queryStore.mutate(desc)
  }

  subscribeToStateChanges(
    fn: (state: Map<string, ServiceState<AdapterMeta<A>>>) => void,
  ): () => void {
    return this.queryStore.subscribeToStateChanges(fn)
  }
}

/**
 * A helper to split the properties into a query descriptor `desc` (including 'params')
 * and figbird-specific query configuration `config`
 */
export function splitConfig<TItem = unknown>(
  combinedConfig: CombinedConfig<TItem>,
): {
  desc: QueryDescriptor
  config: QueryConfig<TItem>
} {
  // Extract common properties with defaults
  const {
    serviceName,
    method,
    skip,
    realtime = 'merge',
    fetchPolicy = 'swr',
    matcher,
    ...rest
  } = combinedConfig

  if (method === 'get') {
    const { resourceId, ...params } = rest as CombinedGetConfig<TItem>

    const desc: GetDescriptor = {
      serviceName,
      method,
      resourceId,
      params,
    }

    const config: GetQueryConfig<TItem> = {
      ...(skip !== undefined && { skip }),
      realtime,
      fetchPolicy,
      ...(matcher !== undefined && { matcher }),
    }

    return { desc, config }
  } else {
    const { allPages, ...params } = rest as CombinedFindConfig<TItem>

    const desc: FindDescriptor = {
      serviceName,
      method,
      params,
    }

    const config: FindQueryConfig<TItem> = {
      ...(skip !== undefined && { skip }),
      realtime,
      fetchPolicy,
      ...(matcher !== undefined && { matcher }),
      ...(allPages !== undefined && { allPages }),
    }

    return { desc, config }
  }
}

// a lightweight query reference object to make it easy
// subscribe to state changes and read query data
// this is only a ref and does not contain state itself, it instead
// references all the state from the shared figbird query state
class QueryRef<
  T,
  S extends Schema = AnySchema, // Add S here
  TParams = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TQuery extends Record<string, unknown> = Record<string, unknown>,
> {
  #queryId: string
  #desc: QueryDescriptor
  #config: QueryConfig<T>
  #queryStore: QueryStore<S, TParams, TMeta, TQuery>

  constructor({
    desc,
    config,
    queryStore,
  }: {
    desc: QueryDescriptor
    config: QueryConfig<T>
    queryStore: QueryStore<S, TParams, TMeta, TQuery>
  }) {
    this.#queryId = `q/${hashObject({ desc, config })}`
    this.#desc = desc
    this.#config = config
    this.#queryStore = queryStore
  }

  details(): { queryId: string; desc: QueryDescriptor; config: QueryConfig<T> } {
    return {
      queryId: this.#queryId,
      desc: this.#desc,
      config: this.#config,
    }
  }

  hash(): string {
    return this.#queryId
  }

  subscribe(fn: (state: QueryState<T, TMeta>) => void): () => void {
    this.#queryStore.materialize(this)
    return this.#queryStore.subscribe<T>(this.#queryId, fn)
  }

  getSnapshot(): QueryState<T, TMeta> | undefined {
    this.#queryStore.materialize(this)
    return this.#queryStore.getQueryState<T>(this.#queryId)
  }

  refetch(): void {
    this.#queryStore.materialize(this)
    return this.#queryStore.refetch(this.#queryId)
  }
}

class QueryStore<
  S extends Schema = AnySchema,
  TParams = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TQuery extends Record<string, unknown> = Record<string, unknown>,
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

  #getQuery(queryId: string): Query<unknown, TMeta> | undefined {
    const serviceName = this.#serviceNamesByQueryId.get(queryId)
    if (serviceName) {
      const service = this.getState().get(serviceName)
      if (service) {
        return service.queries.get(queryId)
      }
    }
    return undefined
  }

  getQueryState<T>(queryId: string): QueryState<T, TMeta> | undefined {
    return this.#getQuery(queryId)?.state as QueryState<T, TMeta> | undefined
  }

  materialize<T>(queryRef: QueryRef<T, S, TParams, TMeta, TQuery>): void {
    const { queryId, desc, config } = queryRef.details()

    if (!this.#getQuery(queryId)) {
      this.#serviceNamesByQueryId.set(queryId, desc.serviceName)

      this.#transactOverService(
        queryId,
        service => {
          service.queries.set(queryId, {
            queryId,
            desc,
            config: config as QueryConfig<unknown>,
            pending: !config.skip,
            dirty: false,
            filterItem: this.#createItemFilter<unknown>(desc, config as QueryConfig<unknown>) as (
              item: unknown,
            ) => boolean,
            state: config.skip
              ? {
                  status: 'idle' as const,
                  data: null,
                  meta: this.#adapter.emptyMeta(),
                  isFetching: false,
                  error: null,
                }
              : {
                  status: 'loading' as const,
                  data: null,
                  meta: this.#adapter.emptyMeta(),
                  isFetching: true,
                  error: null,
                },
          })
        },
        { silent: true },
      )
    }
  }

  #createItemFilter<T>(desc: QueryDescriptor, config: QueryConfig<T>): ItemMatcher<T> {
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
    return this.#adapter.matcher(query as TQuery | null) as ItemMatcher<T>
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

    const shouldVacuumByDefault = q.config.fetchPolicy === 'network-only'
    return ({ vacuum = shouldVacuumByDefault }: { vacuum?: boolean } = {}) => {
      removeListener()
      if (vacuum && this.#listenerCount(queryId) === 0) {
        this.#vacuum({ queryId })
      }
    }
  }

  subscribeToStateChanges(fn: (state: Map<string, ServiceState<TMeta>>) => void): () => void {
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

  #fetch(queryId: string): Promise<QueryResponse<unknown, TMeta>> {
    const query = this.#getQuery(queryId)
    if (!query) {
      return Promise.reject(new Error('Query not found'))
    }

    const { desc, config } = query

    if (desc.method === 'get') {
      return this.#adapter.get(desc.serviceName, desc.resourceId, desc.params as TParams)
    } else {
      const findConfig = config as FindQueryConfig<unknown>
      return findConfig.allPages
        ? this.#adapter.findAll(desc.serviceName, desc.params as TParams)
        : this.#adapter.find(desc.serviceName, desc.params as TParams)
    }
  }

  mutate<D extends MutationDescriptor>(desc: D): Promise<InferMutationData<S, D>> {
    const { serviceName, method, args } = desc
    const updaters: Record<string, (item: unknown) => void> = {
      create: item => this.#processEvent(serviceName, { type: 'created', item }),
      update: item => this.#processEvent(serviceName, { type: 'updated', item }),
      patch: item => this.#processEvent(serviceName, { type: 'patched', item }),
      remove: item => this.#processEvent(serviceName, { type: 'removed', item }),
    }

    return this.#adapter.mutate(serviceName, method, args).then((item: unknown) => {
      updaters[method]?.(item)
      return item as InferMutationData<S, D>
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
    service: ServiceState<TMeta>,
    appliedEvents: QueuedEvent[],
    touch: (queryId: string) => void,
  ): void {
    const getId = (item: unknown) => this.#adapter.getId(item)
    const itemAdded = (meta: TMeta) => this.#adapter.itemAdded(meta)
    const itemRemoved = (meta: TMeta) => this.#adapter.itemRemoved(meta)
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
                    status: 'idle' as const,
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

  #refetchRefetchableQueries(serviceName: string): void {
    const service = this.getState().get(serviceName)
    if (!service) return

    for (const query of service.queries.values()) {
      if (query.config.realtime === 'refetch' && this.#listenerCount(query.queryId) > 0) {
        this.refetch(query.queryId)
      }
    }
  }

  getState(): Map<string, ServiceState<TMeta>> {
    return this.#state
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
      query?: Query<unknown, TMeta>,
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

  #fetched({ queryId, result }: { queryId: string; result: QueryResponse<unknown, TMeta> }): void {
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
          status: 'success' as const,
          data,
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

function getItems<TMeta = Record<string, unknown>>(query: Query<unknown, TMeta>): unknown[] {
  return Array.isArray(query.state.data)
    ? query.state.data
    : query.state.data
      ? [query.state.data]
      : []
}
