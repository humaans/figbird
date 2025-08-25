/**
 * Generic response wrapper for all operations
 */
export interface QueryResponse<TData, TMeta = Record<string, unknown>> {
  data: TData
  meta: TMeta
}

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
  get(serviceName: string, resourceId: string | number, params?: TParams): Promise<QueryResponse<T>>
  find(serviceName: string, params?: TParams): Promise<QueryResponse<T[]>>
  findAll(serviceName: string, params?: TParams): Promise<QueryResponse<T[]>>
  mutate(serviceName: string, method: string, args: unknown[]): Promise<T>

  // Optional real-time support
  subscribe?(serviceName: string, handlers: EventHandlers<T>): () => void

  // Required internal methods
  getId(item: T): string | number | undefined
  isItemStale(currItem: T, nextItem: T): boolean
  matcher(query: unknown, options?: unknown): (item: T) => boolean
  itemAdded(meta: Record<string, unknown>): Record<string, unknown>
  itemRemoved(meta: Record<string, unknown>): Record<string, unknown>
}
