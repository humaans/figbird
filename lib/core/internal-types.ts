// Internal types used within Figbird core - not exported to consumers

import type { EventType } from '../types.js'

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
