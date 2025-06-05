// Common types used throughout the Figbird library

/**
 * Generic query parameters that adapters can extend
 */
export interface QueryParams {
  query?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Generic metadata returned from find operations
 */
export interface FindMeta {
  [key: string]: unknown
}

/**
 * Base interface for items. Adapters should extend this with their own ID requirements
 */
export interface Item {
  [key: string]: unknown
}

/**
 * Type for ID extraction functions
 */
export type IdExtractor<T = Item> = (item: T) => string | number | undefined

/**
 * Type for updatedAt extraction functions
 */
export type UpdatedAtExtractor<T = Item> = (item: T) => string | Date | number | undefined

/**
 * Event types supported by Figbird
 */
export type EventType = 'created' | 'updated' | 'patched' | 'removed'

/**
 * Event payload structure
 */
export interface EventPayload<T = Item> {
  type: EventType
  item: T
}

/**
 * CRUD method names
 */
export type CrudMethod = 'create' | 'update' | 'patch' | 'remove'

/**
 * Type for error objects
 */
export type FigbirdError = Error | { message?: string; code?: number | string } | unknown

/**
 * Type for matcher functions
 */
export type ItemMatcher<T = Item> = (item: T) => boolean
/**
 * Generic service response wrapper
 */
export interface ServiceResponse<T> {
  data: T
  meta: Record<string, unknown>
}

/**
 * Find operation response
 */
export interface FindResponse<T> {
  data: T[]
  meta: FindMeta
}

/**
 * Event handler function type
 */
export type EventHandler<T = Item> = (item: T) => void

/**
 * Event handlers map
 */
export interface EventHandlers<T = Item> {
  created: EventHandler<T>
  updated: EventHandler<T>
  patched: EventHandler<T>
  removed: EventHandler<T>
}

/**
 * Query configuration options
 */
export interface QueryOptions {
  skip?: boolean
  realtime?: 'merge' | 'refetch' | 'disabled'
  fetchPolicy?: 'swr' | 'cache-first' | 'network-only'
  allPages?: boolean
}
