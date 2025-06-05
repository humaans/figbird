// Public types for Figbird consumers

/**
 * Generic response wrapper for all operations
 */
export interface Response<TData, TMeta = Record<string, unknown>> {
  data: TData
  meta?: TMeta
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
