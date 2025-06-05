// Common types used throughout the Figbird library

/**
 * Represents a query parameter structure for Feathers services
 */
export interface FeathersQuery {
  $limit?: number
  $skip?: number
  $sort?: Record<string, 1 | -1>
  $select?: string[]
  $or?: Array<Record<string, unknown>>
  $and?: Array<Record<string, unknown>>
  [key: string]: unknown
}

/**
 * Represents the params object passed to Feathers service methods
 */
export interface FigbirdParams {
  query?: FeathersQuery
  paginate?: boolean | { default?: boolean; max?: number }
  provider?: string
  route?: Record<string, string>
  connection?: unknown
  headers?: Record<string, string>
  [key: string]: unknown
}

/**
 * Represents metadata returned from Feathers find operations
 */
export interface FigbirdFindMeta {
  total?: number
  limit?: number
  skip?: number
  [key: string]: unknown
}

/**
 * Base interface for service items with an ID
 */
export interface ServiceItem {
  id?: string | number
  _id?: string | number
  [key: string]: unknown
}

/**
 * Interface for items with timestamps
 */
export interface TimestampedItem extends ServiceItem {
  updatedAt?: string | Date | number
  updated_at?: string | Date | number
  createdAt?: string | Date | number
  created_at?: string | Date | number
}

/**
 * Type for ID extraction functions
 */
export type IdExtractor<T = ServiceItem> = (item: T) => string | number | undefined

/**
 * Type for updatedAt extraction functions
 */
export type UpdatedAtExtractor<T = ServiceItem> = (item: T) => string | Date | number | undefined

/**
 * Event types supported by Figbird
 */
export type EventType = 'created' | 'updated' | 'patched' | 'removed'

/**
 * Event payload structure
 */
export interface EventPayload<T = ServiceItem> {
  type: EventType
  item: T
}

/**
 * CRUD method names
 */
export type CrudMethod = 'create' | 'update' | 'patch' | 'remove'

/**
 * Method arguments for different CRUD operations
 */
export type CreateArgs<T = ServiceItem> = [data: Partial<T>, params?: FigbirdParams]
export type UpdateArgs<T = ServiceItem> = [
  id: string | number,
  data: Partial<T>,
  params?: FigbirdParams,
]
export type PatchArgs<T = ServiceItem> = [
  id: string | number,
  data: Partial<T>,
  params?: FigbirdParams,
]
export type RemoveArgs = [id: string | number, params?: FigbirdParams]

/**
 * Union type for all CRUD arguments
 */
export type CrudArgs<T = ServiceItem> = CreateArgs<T> | UpdateArgs<T> | PatchArgs<T> | RemoveArgs

/**
 * Type for error objects
 */
export type FigbirdError = Error | { message?: string; code?: number | string } | unknown

/**
 * Type for matcher functions
 */
export type ItemMatcher<T = ServiceItem> = (item: T) => boolean

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
  meta: FigbirdFindMeta
}

/**
 * Event handler function type
 */
export type EventHandler<T = ServiceItem> = (item: T) => void

/**
 * Event handlers map
 */
export interface EventHandlers<T = ServiceItem> {
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
