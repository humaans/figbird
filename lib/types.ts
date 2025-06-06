// Public types for Figbird consumers

/**
 * Generic response wrapper for all operations
 */
export interface Response<TData, TMeta = Record<string, unknown>> {
  data: TData
  meta: TMeta
}

/**
 * Event types supported by Figbird
 */
export type EventType = 'created' | 'updated' | 'patched' | 'removed'

/**
 * Event handlers for real-time updates
 */
export interface EventHandlers<T> {
  created: (item: T) => void
  updated: (item: T) => void
  patched: (item: T) => void
  removed: (item: T) => void
}

/**
 * Unified adapter interface with optional internal methods
 */
export interface Adapter<T = unknown, TParams = unknown> {
  // Required core methods
  get(serviceName: string, resourceId: string | number, params?: TParams): Promise<Response<T>>
  find(serviceName: string, params?: TParams): Promise<Response<T[]>>
  findAll(serviceName: string, params?: TParams): Promise<Response<T[]>>
  mutate(serviceName: string, method: string, args: unknown[]): Promise<T>

  // Optional real-time support
  subscribe?(serviceName: string, handlers: EventHandlers<T>): () => void

  // Optional internal methods for advanced features
  getId?(item: T): string | number | undefined
  isItemStale?(currItem: T, nextItem: T): boolean
  matcher?(query: unknown, options?: unknown): (item: T) => boolean
  itemAdded?(meta: Record<string, unknown>): Record<string, unknown>
  itemRemoved?(meta: Record<string, unknown>): Record<string, unknown>
}
