// Internal types used within Figbird core - not exported to consumers

/**
 * Internal event representation
 */
export interface Event<T> {
  type: 'created' | 'updated' | 'patched' | 'removed'
  item: T
}

/**
 * Queued event for batch processing
 */
export interface QueuedEvent<T> {
  serviceName: string
  type: 'created' | 'updated' | 'patched' | 'removed'
  items: T[]
}

/**
 * Query state representation
 */
export interface QueryState<T> {
  data: T | null
  meta: Record<string, unknown>
  status: 'idle' | 'loading' | 'success' | 'error'
  isFetching: boolean
  error: unknown
}

/**
 * Internal query representation
 */
export interface Query<T> {
  queryId: string
  desc: QueryDescriptor
  config: QueryConfig
  pending: boolean
  dirty: boolean
  filterItem: (item: T) => boolean
  state: QueryState<T>
}

/**
 * Service state in the store
 */
export interface ServiceState<T> {
  entities: Map<string | number, T>
  queries: Map<string, Query<T>>
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
 * Internal adapter interface with ID handling
 */
export interface InternalAdapter<T = unknown, TParams = unknown> {
  get(
    serviceName: string,
    resourceId: string | number,
    params?: TParams,
  ): Promise<import('../types.js').Response<T>>
  find(serviceName: string, params?: TParams): Promise<import('../types.js').Response<T[]>>
  findAll(serviceName: string, params?: TParams): Promise<import('../types.js').Response<T[]>>
  mutate(serviceName: string, method: string, args: unknown[]): Promise<T>
  subscribe?(serviceName: string, handlers: import('../types.js').EventHandlers<T>): () => void

  // Internal methods not exposed in public adapter interface
  getId(item: T): string | number | undefined
  isItemStale(currItem: T, nextItem: T): boolean
  matcher(query: unknown, options?: unknown): ItemMatcher<T>
  itemAdded(meta: Record<string, unknown>): Record<string, unknown>
  itemRemoved(meta: Record<string, unknown>): Record<string, unknown>
}
