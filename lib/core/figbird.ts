import type {
  Adapter,
  AdapterFindMeta,
  AdapterParams,
  AdapterQuery,
  QueryResponse,
} from '../adapters/adapter.js'
import { hashObject } from './hash.js'
import type {
  AnySchema,
  Schema,
  ServiceCreate,
  ServiceItem,
  ServiceNames,
  ServicePatch,
  ServiceQuery,
  ServiceUpdate,
} from './schema.js'

// ==================== EVENT TYPES ====================

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

// ==================== QUERY STATE TYPES ====================

export type QueryStatus = 'idle' | 'loading' | 'success' | 'error'

/**
 * Query state representation - discriminated union for better type safety
 */
export type QueryState<T, TMeta = Record<string, unknown>> =
  | {
      status: 'loading'
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
 * Query state for infinite find queries - extended with pagination state
 */
export type InfiniteQueryState<T, TMeta = Record<string, unknown>> =
  | {
      status: 'loading'
      data: T[]
      meta: TMeta
      isFetching: boolean
      isLoadingMore: boolean
      loadMoreError: null
      error: null
      hasNextPage: boolean
      pageParam: string | number | null
    }
  | {
      status: 'success'
      data: T[]
      meta: TMeta
      isFetching: boolean
      isLoadingMore: boolean
      loadMoreError: Error | null
      error: null
      hasNextPage: boolean
      pageParam: string | number | null
    }
  | {
      status: 'error'
      data: T[]
      meta: TMeta
      isFetching: boolean
      isLoadingMore: boolean
      loadMoreError: Error | null
      error: Error
      hasNextPage: boolean
      pageParam: string | number | null
    }

/**
 * Internal query representation
 */
export interface Query<T = unknown, TMeta = Record<string, unknown>, TQuery = unknown> {
  queryId: string
  desc: QueryDescriptor
  config: QueryConfig<T, TQuery>
  pending: boolean
  dirty: boolean
  filterItem: (item: ElementType<T>) => boolean
  /** Sorter for infinite queries to insert realtime events in order */
  sorter?: (a: ElementType<T>, b: ElementType<T>) => number
  state: QueryState<T, TMeta> | InfiniteQueryState<ElementType<T>, TMeta>
  /** Number of retry attempts made for the current fetch */
  retryCount: number
  /** Timestamp when data was last successfully fetched */
  fetchedAt: number | null
}

/**
 * Service state in the store
 */
export interface ServiceState<TMeta = Record<string, unknown>> {
  entities: Map<string | number, unknown>
  queries: Map<string, Query<unknown, TMeta, unknown>>
  itemQueryIndex: Map<string | number, Set<string>>
}

// ==================== QUERY DESCRIPTOR TYPES ====================

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
 * Query descriptor for infinite find operations
 */
export interface InfiniteFindDescriptor {
  serviceName: string
  method: 'infiniteFind'
  params?: unknown
  /** Unique ID to make each hook instance a separate query (pagination state is per-instance) */
  instanceId: string
}

/**
 * Discriminated union of query descriptors
 */
export type QueryDescriptor = GetDescriptor | FindDescriptor | InfiniteFindDescriptor

// ==================== QUERY CONFIG TYPES ====================

/**
 * Helper type to extract element type from arrays
 */
type ElementType<T> = T extends (infer E)[] ? E : T

/**
 * Retry delay configuration - either a number (ms) or a function that receives
 * the attempt number (0-indexed) and returns the delay in milliseconds.
 */
export type RetryDelayFn = (attempt: number) => number

/**
 * Base query configuration shared by all query types.
 * Add these alongside adapter params when calling useFind/useGet.
 */
interface BaseQueryConfig<TItem = unknown, TQuery = unknown> {
  /**
   * Skip fetching entirely. Useful for conditional queries.
   * When true, status is 'loading' with isFetching: false and no network request is made.
   */
  skip?: boolean

  /**
   * Realtime strategy for handling events:
   * - 'merge' (default): merge incoming events into cached results
   * - 'refetch': refetch the entire query when an event is received
   * - 'disabled': ignore realtime events for this query
   */
  realtime?: 'merge' | 'refetch' | 'disabled'

  /**
   * Fetch policy determines how cache vs network is used:
   * - 'swr' (default): stale-while-revalidate (show cache, refetch in background)
   * - 'cache-first': prefer cache and avoid network if data is present
   * - 'network-only': always fetch on mount
   */
  fetchPolicy?: 'swr' | 'cache-first' | 'network-only'

  /**
   * Optional custom matcher factory. Only used in realtime 'merge' mode.
   * Receives the prepared query object; returns a predicate for items.
   * Provide this if your adapter needs custom client-side matching logic.
   * Note: For find queries, the matcher works with individual items, not arrays.
   */
  matcher?: (query: TQuery | undefined) => (item: ElementType<TItem>) => boolean

  /**
   * Number of times to retry failed fetches. Set to `false` to disable retries.
   * Default: 3
   */
  retry?: number | false

  /**
   * Delay between retries. Can be a number (ms) or a function receiving attempt number.
   * Default: exponential backoff (1s, 2s, 4s... capped at 30s)
   */
  retryDelay?: number | RetryDelayFn

  /**
   * Time in milliseconds that cached data is considered "fresh".
   * During this window, cache-hit queries won't trigger background refetches.
   * Default: 30000 (30 seconds) - prevents refetch storms from rapid tab switching
   * while still catching missed realtime events reasonably quickly.
   */
  staleTime?: number

  /**
   * Refetch stale queries when the browser window regains focus.
   * Default: true
   */
  refetchOnWindowFocus?: boolean
}

/**
 * Configuration for get queries
 */
export type GetQueryConfig<TItem = unknown, TQuery = unknown> = BaseQueryConfig<TItem, TQuery>

/**
 * Configuration for find queries
 */
export interface FindQueryConfig<TItem = unknown, TQuery = unknown> extends BaseQueryConfig<
  TItem,
  TQuery
> {
  /**
   * Fetches all pages by iterating until completion, aggregating results.
   * Honors adapter pagination controls (e.g. $limit/$skip for Feathers).
   */
  allPages?: boolean
}

/**
 * Configuration for infinite find queries
 */
export interface InfiniteFindQueryConfig<TItem = unknown, TQuery = unknown> extends Omit<
  BaseQueryConfig<TItem, TQuery>,
  'fetchPolicy'
> {
  /**
   * Page size limit for each fetch
   */
  limit?: number

  /**
   * Custom sorter for inserting realtime events in sorted order.
   * Default: built from query.$sort
   */
  sorter?: (a: ElementType<TItem>, b: ElementType<TItem>) => number
}

/**
 * Discriminated union of query configurations
 */
export type QueryConfig<TItem = unknown, TQuery = unknown> =
  | GetQueryConfig<TItem, TQuery>
  | FindQueryConfig<TItem, TQuery>
  | InfiniteFindQueryConfig<TItem, TQuery>

/**
 * Combined config for get operations
 * Combines the descriptor and config properties with index signature for extra params
 */
export type CombinedGetConfig<TItem = unknown, TQuery = unknown> = GetDescriptor &
  GetQueryConfig<TItem, TQuery> & {
    [key: string]: unknown
  }

/**
 * Combined config for find operations
 * Combines the descriptor and config properties with index signature for extra params
 */
export type CombinedFindConfig<TItem = unknown, TQuery = unknown> = FindDescriptor &
  FindQueryConfig<TItem, TQuery> & {
    [key: string]: unknown
  }

/**
 * Combined config for infinite find operations
 */
export type CombinedInfiniteFindConfig<TItem = unknown, TQuery = unknown> = InfiniteFindDescriptor &
  InfiniteFindQueryConfig<TItem, TQuery> & {
    [key: string]: unknown
  }

/**
 * Combined config for internal use (used by splitConfig for get/find queries)
 * Note: InfiniteFindConfig is not included as infinite queries use a different code path
 */
export type CombinedConfig<TItem = unknown, TQuery = unknown> =
  | CombinedGetConfig<TItem, TQuery>
  | CombinedFindConfig<TItem, TQuery>

/**
 * Item matcher function type
 */
export type ItemMatcher<T> = (item: T) => boolean

// ==================== MUTATION TYPES ====================

/**
 * Base mutation descriptor with common fields
 */
interface BaseMutationDescriptor {
  serviceName: string
  params?: unknown
}

/**
 * Descriptor for create mutations
 */
export interface CreateMutationDescriptor extends BaseMutationDescriptor {
  method: 'create'
  data: unknown
}

/**
 * Descriptor for update mutations
 */
export interface UpdateMutationDescriptor extends BaseMutationDescriptor {
  method: 'update'
  id: string | number
  data: unknown
}

/**
 * Descriptor for patch mutations
 */
export interface PatchMutationDescriptor extends BaseMutationDescriptor {
  method: 'patch'
  id: string | number
  data: unknown
}

/**
 * Descriptor for remove mutations
 */
export interface RemoveMutationDescriptor extends BaseMutationDescriptor {
  method: 'remove'
  id: string | number
}

/**
 * Discriminated union of all mutation descriptors
 */
export type MutationDescriptor =
  | CreateMutationDescriptor
  | UpdateMutationDescriptor
  | PatchMutationDescriptor
  | RemoveMutationDescriptor

// ==================== HELPER TYPES ====================

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

// Helper to specialize adapter params' `query` by service-level domain query
type ParamsWithServiceQuery<S extends Schema, N extends ServiceNames<S>, A extends Adapter> = Omit<
  AdapterParams<A>,
  'query'
> & { query?: ServiceQuery<S, N> }

// ==================== FIGBIRD CLASS ====================

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
/**
 * Default query configuration options that can be set globally
 */
export interface DefaultQueryConfig {
  retry?: number | false
  retryDelay?: number | RetryDelayFn
  staleTime?: number
  refetchOnWindowFocus?: boolean
}

/**
 * Figbird core instance holding the adapter and shared query state.
 * Prefer `createHooks(figbird)` in React apps to get strongly-typed hooks.
 */
export class Figbird<
  S extends Schema = AnySchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  A extends Adapter<any, any, any> = Adapter<unknown, Record<string, unknown>, unknown>,
> {
  adapter: A
  queryStore: QueryStore<S, AdapterParams<A>, AdapterFindMeta<A>, AdapterQuery<A>>
  schema: S | undefined

  /**
   * Create a Figbird instance.
   * @param adapter Data adapter (e.g. FeathersAdapter)
   * @param eventBatchProcessingInterval Optional interval (ms) for batching realtime events
   * @param schema Optional schema to enable full TypeScript inference
   * @param defaultQueryConfig Global defaults for query options (retry, staleTime, etc.)
   */
  constructor({
    adapter,
    eventBatchProcessingInterval,
    schema,
    defaultQueryConfig,
  }: {
    adapter: A
    eventBatchProcessingInterval?: number
    schema?: S
    defaultQueryConfig?: DefaultQueryConfig
  }) {
    this.adapter = adapter
    this.schema = schema
    this.queryStore = new QueryStore<S, AdapterParams<A>, AdapterFindMeta<A>, AdapterQuery<A>>({
      adapter,
      eventBatchProcessingInterval,
      ...(defaultQueryConfig && { defaultQueryConfig }),
    })
  }

  /** Returns the entire internal state map keyed by service name. */
  getState(): Map<string, ServiceState<AdapterFindMeta<A>>> {
    return this.queryStore.getState()
  }

  // Strongly-typed overloads for inference from serviceName and method
  /** Create a typed `find` query reference. */
  query<N extends ServiceNames<S>>(
    desc: { serviceName: N; method: 'find'; params?: ParamsWithServiceQuery<S, N, A> },
    config?: QueryConfig<ServiceItem<S, N>[], ServiceQuery<S, N>>,
  ): QueryRef<
    ServiceItem<S, N>[],
    ServiceQuery<S, N>,
    S,
    AdapterParams<A>,
    AdapterFindMeta<A>,
    AdapterQuery<A>
  >
  /** Create a typed `get` query reference. */
  query<N extends ServiceNames<S>>(
    desc: {
      serviceName: N
      method: 'get'
      resourceId: string | number
      params?: ParamsWithServiceQuery<S, N, A>
    },
    config?: QueryConfig<ServiceItem<S, N>, ServiceQuery<S, N>>,
  ): QueryRef<
    ServiceItem<S, N>,
    ServiceQuery<S, N>,
    S,
    AdapterParams<A>,
    AdapterFindMeta<A>,
    AdapterQuery<A>
  >
  /** Create a typed `infiniteFind` query reference. */
  query<N extends ServiceNames<S>>(
    desc: {
      serviceName: N
      method: 'infiniteFind'
      params?: ParamsWithServiceQuery<S, N, A>
      instanceId: string
    },
    config?: InfiniteFindQueryConfig<ServiceItem<S, N>[], ServiceQuery<S, N>>,
  ): QueryRef<
    ServiceItem<S, N>[],
    ServiceQuery<S, N>,
    S,
    AdapterParams<A>,
    AdapterFindMeta<A>,
    AdapterQuery<A>
  >
  // Generic fallback overload (for dynamic descriptors)
  query<D extends QueryDescriptor>(
    desc: D,
    config?: QueryConfig<InferQueryData<S, D>, AdapterQuery<A>>,
  ): QueryRef<
    InferQueryData<S, D>,
    AdapterQuery<A>,
    S,
    AdapterParams<A>,
    AdapterFindMeta<A>,
    AdapterQuery<A>
  >
  // Implementation
  query(
    desc: {
      serviceName: string
      method: 'find' | 'get' | 'infiniteFind'
      resourceId?: string | number
      instanceId?: string
      params?: unknown
    },
    config?: QueryConfig<unknown, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): any {
    return new QueryRef<unknown, unknown, S, AdapterParams<A>, AdapterFindMeta<A>, AdapterQuery<A>>(
      {
        desc: desc as QueryDescriptor,
        config: (config || {}) as QueryConfig<unknown, unknown>,
        queryStore: this.queryStore,
      },
    )
  }

  // Strongly-typed mutation overloads

  /** Create a single new item. */
  mutate<N extends ServiceNames<S>>(desc: {
    serviceName: N
    method: 'create'
    data: ServiceCreate<S, N>
    params?: AdapterParams<A>
  }): Promise<ServiceItem<S, N>>

  /** Create multiple new items (batch). */
  mutate<N extends ServiceNames<S>>(desc: {
    serviceName: N
    method: 'create'
    data: ServiceCreate<S, N>[]
    params?: AdapterParams<A>
  }): Promise<ServiceItem<S, N>[]>

  /** Update an existing item by ID (full replacement). */
  mutate<N extends ServiceNames<S>>(desc: {
    serviceName: N
    method: 'update'
    id: string | number
    data: ServiceUpdate<S, N>
    params?: AdapterParams<A>
  }): Promise<ServiceItem<S, N>>

  /** Patch an existing item by ID (partial update). */
  mutate<N extends ServiceNames<S>>(desc: {
    serviceName: N
    method: 'patch'
    id: string | number
    data: ServicePatch<S, N>
    params?: AdapterParams<A>
  }): Promise<ServiceItem<S, N>>

  /** Remove an item by ID. */
  mutate<N extends ServiceNames<S>>(desc: {
    serviceName: N
    method: 'remove'
    id: string | number
    params?: AdapterParams<A>
  }): Promise<ServiceItem<S, N>>

  // Implementation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mutate(desc: MutationDescriptor): Promise<any> {
    return this.queryStore.mutate(desc)
  }

  /** Subscribe to any state changes within Figbird (across all queries/services). */
  subscribeToStateChanges(
    fn: (state: Map<string, ServiceState<AdapterFindMeta<A>>>) => void,
  ): () => void {
    return this.queryStore.subscribeToStateChanges(fn)
  }
}

// ==================== SPLIT CONFIG HELPER ====================

/**
 * A helper to split the properties into a query descriptor `desc` (including 'params')
 * and figbird-specific query configuration `config`
 */
export function splitConfig<TItem = unknown, TQuery = unknown>(
  combinedConfig: CombinedConfig<TItem, TQuery>,
): {
  desc: QueryDescriptor
  config: QueryConfig<TItem, TQuery>
} {
  // Extract common properties with defaults
  const {
    serviceName,
    method,
    skip,
    realtime = 'merge',
    fetchPolicy = 'swr',
    matcher,
    retry,
    retryDelay,
    staleTime,
    refetchOnWindowFocus,
    ...rest
  } = combinedConfig

  if (method === 'get') {
    const { resourceId, ...params } = rest as CombinedGetConfig<TItem, TQuery>

    const desc: GetDescriptor = {
      serviceName,
      method,
      resourceId,
      params,
    }

    const config: GetQueryConfig<TItem, TQuery> = {
      ...(skip !== undefined && { skip }),
      realtime,
      fetchPolicy,
      ...(matcher !== undefined && { matcher }),
      ...(retry !== undefined && { retry }),
      ...(retryDelay !== undefined && { retryDelay }),
      ...(staleTime !== undefined && { staleTime }),
      ...(refetchOnWindowFocus !== undefined && { refetchOnWindowFocus }),
    }

    return { desc, config }
  } else {
    const { allPages, ...params } = rest as CombinedFindConfig<TItem, TQuery>

    const desc: FindDescriptor = {
      serviceName,
      method,
      params,
    }

    const config: FindQueryConfig<TItem, TQuery> = {
      ...(skip !== undefined && { skip }),
      realtime,
      fetchPolicy,
      ...(matcher !== undefined && { matcher }),
      ...(allPages !== undefined && { allPages }),
      ...(retry !== undefined && { retry }),
      ...(retryDelay !== undefined && { retryDelay }),
      ...(staleTime !== undefined && { staleTime }),
      ...(refetchOnWindowFocus !== undefined && { refetchOnWindowFocus }),
    }

    return { desc, config }
  }
}

// ==================== QUERY REF CLASS ====================

// a lightweight query reference object to make it easy
// subscribe to state changes and read query data
// this is only a ref and does not contain state itself, it instead
// references all the state from the shared figbird query state
/**
 * Lightweight reference to a query in the shared Figbird store.
 * Provides helpers to subscribe to updates, get snapshots, and refetch.
 */
class QueryRef<
  T,
  TQueryType = unknown,
  S extends Schema = AnySchema, // Add S here
  TParams = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TQuery = Record<string, unknown>,
> {
  #queryId: string
  #desc: QueryDescriptor
  #config: QueryConfig<T, TQueryType>
  #queryStore: QueryStore<S, TParams, TMeta, TQuery>

  constructor({
    desc,
    config,
    queryStore,
  }: {
    desc: QueryDescriptor
    config: QueryConfig<T, TQueryType>
    queryStore: QueryStore<S, TParams, TMeta, TQuery>
  }) {
    this.#queryId = `q/${hashObject({ desc, config })}`
    this.#desc = desc
    this.#config = config
    this.#queryStore = queryStore
  }

  /** Returns internal details of this query reference (for debugging/testing). */
  details(): { queryId: string; desc: QueryDescriptor; config: QueryConfig<T, TQueryType> } {
    return {
      queryId: this.#queryId,
      desc: this.#desc,
      config: this.#config,
    }
  }

  /** Returns a stable hash representing descriptor + config. */
  hash(): string {
    return this.#queryId
  }

  /**
   * Subscribes to this query's state. Triggers fetching if needed.
   * Returns an unsubscribe function.
   */
  subscribe(fn: (state: QueryState<T, TMeta>) => void): () => void {
    this.#queryStore.materialize(this)
    return this.#queryStore.subscribe<T>(this.#queryId, fn)
  }

  /** Returns the latest known state for this query, if available. */
  getSnapshot(): QueryState<T, TMeta> | InfiniteQueryState<ElementType<T>, TMeta> | undefined {
    this.#queryStore.materialize(this)
    if (this.#desc.method === 'infiniteFind') {
      return this.#queryStore.getInfiniteQueryState<ElementType<T>>(this.#queryId)
    }
    return this.#queryStore.getQueryState<T>(this.#queryId)
  }

  /** Triggers a refetch for this query. */
  refetch(): void {
    this.#queryStore.materialize(this)
    return this.#queryStore.refetch(this.#queryId)
  }

  /** Load the next page for an infinite query. */
  loadMore(): void {
    if (this.#desc.method !== 'infiniteFind') {
      throw new Error('loadMore is only available for infinite queries')
    }
    this.#queryStore.materialize(this)
    this.#queryStore.loadMore(this.#queryId)
  }
}

// ==================== QUERY STORE CLASS ====================

/**
 * Default exponential backoff: 1s, 2s, 4s, 8s... capped at 30s
 */
function defaultRetryDelay(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), 30000)
}

/**
 * Compute retry delay from config
 */
function computeRetryDelay(attempt: number, retryDelay: number | RetryDelayFn | undefined): number {
  if (typeof retryDelay === 'function') {
    return retryDelay(attempt)
  }
  if (typeof retryDelay === 'number') {
    return retryDelay
  }
  return defaultRetryDelay(attempt)
}

/**
 * Internal query store managing entities, queries, and subscriptions.
 */
class QueryStore<
  S extends Schema = AnySchema,
  TParams = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TQuery = Record<string, unknown>,
> {
  // ==================== SHARED STATE ====================

  #adapter: Adapter<TParams, TMeta, TQuery>
  #defaultQueryConfig: DefaultQueryConfig

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
    defaultQueryConfig = {},
  }: {
    adapter: Adapter<TParams, TMeta, TQuery>
    eventBatchProcessingInterval?: number | undefined
    defaultQueryConfig?: DefaultQueryConfig
  }) {
    this.#adapter = adapter
    this.#eventBatchProcessingInterval = eventBatchProcessingInterval
    this.#defaultQueryConfig = defaultQueryConfig
    this.#setupWindowFocusListener()
  }

  #setupWindowFocusListener(): void {
    // SSR guard - both window and document must exist
    if (typeof window === 'undefined' || typeof document === 'undefined') return

    const onFocus = () => this.#onWindowFocus()

    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') onFocus()
    })
  }

  #onWindowFocus(): void {
    for (const [, service] of this.#state) {
      for (const [queryId, query] of service.queries) {
        if (this.#listenerCount(queryId) === 0) continue
        if (!this.#getEffectiveConfig(query.config).refetchOnWindowFocus) continue
        if (!this.#isStale(query)) continue
        if (query.state.isFetching) continue
        this.#queue(queryId)
      }
    }
  }

  #getEffectiveConfig(config: QueryConfig<unknown, unknown>): {
    retry: number | false
    retryDelay: number | RetryDelayFn | undefined
    staleTime: number
    refetchOnWindowFocus: boolean
  } {
    return {
      retry: config.retry ?? this.#defaultQueryConfig.retry ?? 3,
      retryDelay: config.retryDelay ?? this.#defaultQueryConfig.retryDelay,
      staleTime: config.staleTime ?? this.#defaultQueryConfig.staleTime ?? 30_000,
      refetchOnWindowFocus:
        config.refetchOnWindowFocus ?? this.#defaultQueryConfig.refetchOnWindowFocus ?? true,
    }
  }

  #isStale(query: Query<unknown, TMeta, unknown>): boolean {
    if (query.state.status !== 'success') return true
    if (query.fetchedAt === null) return true
    const { staleTime } = this.#getEffectiveConfig(query.config)
    return staleTime === 0 || Date.now() - query.fetchedAt > staleTime
  }

  // ==================== PUBLIC API ====================

  /** Returns the entire store state map keyed by service name. */
  getState(): Map<string, ServiceState<TMeta>> {
    return this.#state
  }

  /** Returns the current state for a query by id, if present. */
  getQueryState<T>(queryId: string): QueryState<T, TMeta> | undefined {
    return this.#getQuery(queryId)?.state as QueryState<T, TMeta> | undefined
  }

  /** Returns the current state for an infinite query by id, if present. */
  getInfiniteQueryState<T>(queryId: string): InfiniteQueryState<T, TMeta> | undefined {
    return this.#getQuery(queryId)?.state as InfiniteQueryState<T, TMeta> | undefined
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
          if (desc.method === 'infiniteFind') {
            const infiniteConfig = config as InfiniteFindQueryConfig<unknown, unknown>
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
              sorter: infiniteConfig.sorter ?? this.#createSorter(desc),
              state: {
                status: 'loading' as const,
                data: [],
                meta: this.#adapter.emptyMeta(),
                isFetching: !config.skip,
                isLoadingMore: false,
                loadMoreError: null,
                error: null,
                hasNextPage: false,
                pageParam: null,
              } as InfiniteQueryState<unknown, TMeta>,
              retryCount: 0,
              fetchedAt: null,
            })
          } else {
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
              retryCount: 0,
              fetchedAt: null,
            })
          }
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

    // Infinite queries always fetch on first subscribe, but don't have SWR behavior
    if (q.desc.method === 'infiniteFind') {
      if (q.pending || (q.state.status === 'error' && !q.state.isFetching)) {
        this.#queueInfinite(queryId, false)
      }
    } else {
      const fetchPolicy = (q.config as BaseQueryConfig<unknown, unknown>).fetchPolicy
      const shouldFetch =
        q.pending ||
        (q.state.status === 'success' &&
          fetchPolicy === 'swr' &&
          !q.state.isFetching &&
          this.#isStale(q)) ||
        (q.state.status === 'error' && !q.state.isFetching)

      if (shouldFetch) {
        this.#queue(queryId)
      }
    }

    const removeListener = this.#addListener(queryId, fn)

    this.#subscribeToRealtime(queryId)

    // Infinite queries always vacuum (each has unique instanceId)
    const fetchPolicy = (q.config as BaseQueryConfig<unknown, unknown>).fetchPolicy
    const shouldVacuumByDefault = fetchPolicy === 'network-only' || q.desc.method === 'infiniteFind'
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

    if (q.desc.method === 'infiniteFind') {
      this.refetchInfinite(queryId)
      return
    }

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

  /** Refetch an infinite query from the beginning (reset pagination). */
  refetchInfinite(queryId: string): void {
    const q = this.#getQuery(queryId)
    if (!q || q.desc.method !== 'infiniteFind') return

    const state = q.state as InfiniteQueryState<unknown, TMeta>
    if (state.isFetching || state.isLoadingMore) {
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
      return
    }

    // Reset state and refetch from beginning
    this.#transactOverService(queryId, (service, query) => {
      if (!query) return
      service.queries.set(queryId, {
        ...query,
        state: {
          status: 'loading' as const,
          data: [],
          meta: this.#adapter.emptyMeta(),
          isFetching: true,
          isLoadingMore: false,
          loadMoreError: null,
          error: null,
          hasNextPage: false,
          pageParam: null,
        } as InfiniteQueryState<unknown, TMeta>,
      })
    })

    this.#queueInfinite(queryId, false)
  }

  /** Load more data for an infinite query. */
  loadMore(queryId: string): void {
    const q = this.#getQuery(queryId)
    if (!q || q.desc.method !== 'infiniteFind') return

    const state = q.state as InfiniteQueryState<unknown, TMeta>
    if (state.isLoadingMore || !state.hasNextPage || state.pageParam === null) {
      return
    }

    this.#transactOverService(queryId, (service, query) => {
      if (!query) return
      const currentState = query.state as InfiniteQueryState<unknown, TMeta>
      service.queries.set(queryId, {
        ...query,
        state: {
          ...currentState,
          isLoadingMore: true,
          loadMoreError: null,
        },
      })
    })

    this.#queueInfinite(queryId, true)
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

  // ==================== REGULAR QUERY LIFECYCLE ====================

  async #queue(queryId: string): Promise<void> {
    this.#fetching({ queryId })
    try {
      const result = await this.#fetch(queryId)
      this.#fetched({ queryId, result })
    } catch (err) {
      await this.#handleFetchError({
        queryId,
        error: err instanceof Error ? err : new Error(String(err)),
      })
    }
  }

  async #handleFetchError({ queryId, error }: { queryId: string; error: Error }): Promise<void> {
    const query = this.#getQuery(queryId)
    if (!query) {
      this.#fetchFailed({ queryId, error })
      return
    }

    const { retry: maxRetries, retryDelay } = this.#getEffectiveConfig(query.config)

    if (maxRetries !== false && query.retryCount < maxRetries) {
      const delay = computeRetryDelay(query.retryCount, retryDelay)

      // Increment retryCount
      this.#transactOverService(
        queryId,
        (service, q) => {
          if (q) {
            service.queries.set(queryId, { ...q, retryCount: q.retryCount + 1 })
          }
        },
        { silent: true },
      )

      await new Promise(r => setTimeout(r, delay))

      // Only retry if still has listeners
      if (this.#listenerCount(queryId) > 0) {
        return this.#queue(queryId)
      }
    }

    this.#fetchFailed({ queryId, error })
  }

  #fetch(queryId: string): Promise<QueryResponse<unknown, TMeta | undefined>> {
    const query = this.#getQuery(queryId)
    if (!query) {
      return Promise.reject(new Error('Query not found'))
    }

    const { desc, config } = query

    if (desc.method === 'get') {
      return this.#adapter.get(desc.serviceName, desc.resourceId, desc.params as TParams)
    } else if (desc.method === 'find') {
      const findConfig = config as FindQueryConfig<unknown, unknown>
      return findConfig.allPages
        ? this.#adapter.findAll(desc.serviceName, desc.params as TParams)
        : this.#adapter.find(desc.serviceName, desc.params as TParams)
    } else {
      return Promise.reject(new Error('Unsupported query method'))
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
        retryCount: 0,
        fetchedAt: Date.now(),
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
        retryCount: 0, // Reset for next attempt
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

  // ==================== INFINITE QUERY LIFECYCLE ====================

  async #queueInfinite(queryId: string, isLoadMore: boolean): Promise<void> {
    if (!isLoadMore) {
      this.#fetchingInfinite({ queryId })
    }
    try {
      const result = await this.#fetchInfinite(queryId, isLoadMore)
      this.#fetchedInfinite({ queryId, result, isLoadMore })
    } catch (err) {
      this.#fetchFailedInfinite({
        queryId,
        error: err instanceof Error ? err : new Error(String(err)),
        isLoadMore,
      })
    }
  }

  #fetchInfinite(queryId: string, isLoadMore: boolean): Promise<QueryResponse<unknown[], TMeta>> {
    const query = this.#getQuery(queryId)
    if (!query || query.desc.method !== 'infiniteFind') {
      return Promise.reject(new Error('Infinite query not found'))
    }

    const { desc, config } = query
    const infiniteConfig = config as InfiniteFindQueryConfig<unknown, unknown>
    const state = query.state as InfiniteQueryState<unknown, TMeta>

    const baseQuery = (desc.params as { query?: Record<string, unknown> })?.query || {}
    const pageParam = isLoadMore ? state.pageParam : null

    const params: TParams = {
      query: {
        ...baseQuery,
        ...(infiniteConfig.limit && { $limit: infiniteConfig.limit }),
        ...(typeof pageParam === 'string' && { $cursor: pageParam }),
        ...(typeof pageParam === 'number' && { $skip: pageParam }),
      },
    } as TParams

    return this.#adapter.find(desc.serviceName, params)
  }

  #fetchingInfinite({ queryId }: { queryId: string }): void {
    this.#transactOverService(queryId, (service, query) => {
      if (!query) return
      const state = query.state as InfiniteQueryState<unknown, TMeta>

      // Preserve the status while updating fetching state
      const newState: InfiniteQueryState<unknown, TMeta> =
        state.status === 'success'
          ? { ...state, isFetching: true }
          : state.status === 'error'
            ? {
                status: 'loading' as const,
                data: state.data,
                meta: state.meta,
                isFetching: true,
                isLoadingMore: false,
                loadMoreError: null,
                error: null,
                hasNextPage: state.hasNextPage,
                pageParam: state.pageParam,
              }
            : { ...state, isFetching: true }

      service.queries.set(queryId, {
        ...query,
        pending: false,
        dirty: false,
        state: newState,
      })
    })
  }

  #fetchedInfinite({
    queryId,
    result,
    isLoadMore,
  }: {
    queryId: string
    result: QueryResponse<unknown[], TMeta>
    isLoadMore: boolean
  }): void {
    let shouldRefetch = false

    this.#transactOverService(queryId, (service, query) => {
      if (!query) return

      const data = result.data
      const meta = result.meta as TMeta
      const getId = (item: unknown) => this.#adapter.getId(item)
      const nextPageParam = this.#adapter.getNextPageParam(meta, data)
      const hasNextPage = this.#adapter.getHasNextPage(meta, data)

      // Store entities in central cache
      for (const item of data) {
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
      const currentState = query.state as InfiniteQueryState<unknown, TMeta>

      if (isLoadMore) {
        service.queries.set(queryId, {
          ...query,
          dirty: false,
          state: {
            ...currentState,
            data: [...(currentState.data as unknown[]), ...data],
            meta,
            isLoadingMore: false,
            hasNextPage,
            pageParam: nextPageParam,
          },
        })
      } else {
        service.queries.set(queryId, {
          ...query,
          dirty: false,
          state: {
            status: 'success' as const,
            data,
            meta,
            isFetching: false,
            isLoadingMore: false,
            loadMoreError: null,
            error: null,
            hasNextPage,
            pageParam: nextPageParam,
          } as InfiniteQueryState<unknown, TMeta>,
        })
      }
    })

    if (shouldRefetch && this.#listenerCount(queryId) > 0) {
      this.refetchInfinite(queryId)
    }
  }

  #fetchFailedInfinite({
    queryId,
    error,
    isLoadMore,
  }: {
    queryId: string
    error: Error
    isLoadMore: boolean
  }): void {
    let shouldRefetch = false

    this.#transactOverService(queryId, (service, query) => {
      if (!query) return

      shouldRefetch = query.dirty
      const currentState = query.state as InfiniteQueryState<unknown, TMeta>

      let newState: InfiniteQueryState<unknown, TMeta>
      if (isLoadMore) {
        // For loadMore failure, keep the current status and update loadMoreError
        if (currentState.status === 'success') {
          newState = {
            ...currentState,
            isLoadingMore: false,
            loadMoreError: error,
          }
        } else if (currentState.status === 'error') {
          newState = {
            ...currentState,
            isLoadingMore: false,
            loadMoreError: error,
          }
        } else {
          newState = {
            ...currentState,
            isLoadingMore: false,
          }
        }
      } else {
        newState = {
          status: 'error' as const,
          data: currentState.data,
          meta: this.#adapter.emptyMeta(),
          isFetching: false,
          isLoadingMore: false,
          loadMoreError: null,
          error,
          hasNextPage: false,
          pageParam: null,
        }
      }

      service.queries.set(queryId, {
        ...query,
        dirty: false,
        state: newState,
      })
    })

    if (shouldRefetch && this.#listenerCount(queryId) > 0) {
      this.refetchInfinite(queryId)
    }
  }

  // ==================== REALTIME EVENTS ====================

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

          const fetchPolicy = (query.config as BaseQueryConfig<unknown, unknown>).fetchPolicy
          if (query.desc.method === 'find' && fetchPolicy === 'network-only') {
            continue
          }

          if (type === 'removed') {
            matches = false
          } else {
            matches = query.filterItem(item)
          }

          const hasItem = itemQueryIndex.has(queryId)

          // Handle infiniteFind queries separately
          if (query.desc.method === 'infiniteFind') {
            const state = query.state as InfiniteQueryState<unknown, TMeta>
            if (state.status !== 'success') continue

            if (hasItem && !matches) {
              // Remove: item no longer matches
              const newData = state.data.filter((x: unknown) => getId(x) !== itemId)
              service.queries.set(queryId, {
                ...query,
                state: {
                  ...state,
                  meta: itemRemoved(state.meta),
                  data: newData,
                },
              })
              itemQueryIndex.delete(queryId)
              touch(queryId)
            } else if (hasItem && matches) {
              // Update in place
              const newData = state.data.map((x: unknown) => (getId(x) === itemId ? item : x))
              service.queries.set(queryId, {
                ...query,
                state: {
                  ...state,
                  data: newData,
                },
              })
              touch(queryId)
            } else if (matches && state.data) {
              // Insert at sorted position
              const sorter = query.sorter || (() => 0)
              const newData = insertSorted(state.data, item, sorter)
              service.queries.set(queryId, {
                ...query,
                state: {
                  ...state,
                  meta: itemAdded(state.meta),
                  data: newData,
                },
              })
              itemQueryIndex.add(queryId)
              touch(queryId)
            }
            continue
          }

          // Handle get and find queries (infiniteFind already handled above)
          const queryState = query.state as QueryState<unknown, TMeta>
          if (hasItem && !matches) {
            // remove
            const nextState: QueryState<unknown, TMeta> =
              query.desc.method === 'get' && queryState.status === 'success'
                ? {
                    status: 'loading' as const,
                    data: null,
                    meta: itemRemoved(queryState.meta),
                    isFetching: false,
                    error: null,
                  }
                : queryState.status === 'success'
                  ? {
                      ...queryState,
                      meta: itemRemoved(queryState.meta),
                      data: (queryState.data as unknown[]).filter(
                        (x: unknown) => getId(x) !== itemId,
                      ),
                    }
                  : queryState
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
                queryState.status === 'success'
                  ? {
                      ...queryState,
                      data:
                        query.desc.method === 'get'
                          ? item
                          : (queryState.data as unknown[]).map((x: unknown) =>
                              getId(x) === itemId ? item : x,
                            ),
                    }
                  : queryState,
            })
            touch(queryId)
          } else if (matches && query.desc.method === 'find' && queryState.data) {
            service.queries.set(queryId, {
              ...query,
              state:
                queryState.status === 'success'
                  ? {
                      ...queryState,
                      meta: itemAdded(queryState.meta),
                      data: (queryState.data as unknown[]).concat(item),
                    }
                  : queryState,
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

  // ==================== STATE MANAGEMENT ====================

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

  // ==================== INTERNAL HELPERS ====================

  #createSorter(desc: QueryDescriptor): (a: unknown, b: unknown) => number {
    const sort = (desc.params as { query?: { $sort?: Record<string, 1 | -1> } })?.query?.$sort
    if (!sort || Object.keys(sort).length === 0) {
      return () => 0
    }
    const sortEntries = Object.entries(sort)
    return (a: unknown, b: unknown) => {
      for (const [key, direction] of sortEntries) {
        const aVal = (a as Record<string, unknown>)[key]
        const bVal = (b as Record<string, unknown>)[key]
        let cmp = 0
        if (aVal == null && bVal == null) {
          cmp = 0
        } else if (aVal == null) {
          cmp = 1
        } else if (bVal == null) {
          cmp = -1
        } else if (typeof aVal === 'string' && typeof bVal === 'string') {
          cmp = aVal.localeCompare(bVal)
        } else if (aVal < bVal) {
          cmp = -1
        } else if (aVal > bVal) {
          cmp = 1
        }
        if (cmp !== 0) {
          return cmp * direction
        }
      }
      return 0
    }
  }

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

// ==================== MODULE HELPERS ====================

function getItems<TMeta = Record<string, unknown>>(
  query: Query<unknown, TMeta, unknown>,
): unknown[] {
  return Array.isArray(query.state.data)
    ? query.state.data
    : query.state.data
      ? [query.state.data]
      : []
}

/**
 * Insert an item into a sorted array at the correct position using binary search.
 */
function insertSorted<T>(data: T[], item: T, sorter: (a: T, b: T) => number): T[] {
  const result = [...data]
  let low = 0
  let high = result.length

  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (sorter(item, result[mid]!) <= 0) {
      high = mid
    } else {
      low = mid + 1
    }
  }

  result.splice(low, 0, item)
  return result
}
