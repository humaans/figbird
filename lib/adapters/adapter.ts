/**
 * Generic response wrapper for all operations
 * - For find-like operations, include meta (e.g. pagination info)
 * - For get-like operations, adapters may omit meta entirely
 */
export type QueryResponse<TData, TMeta = undefined> = { data: TData } & (TMeta extends undefined
  ? Record<never, never>
  : { meta: TMeta })

/**
 * Event handlers for real-time updates
 */
export interface EventHandlers {
  created: (item: unknown) => void
  updated: (item: unknown) => void
  patched: (item: unknown) => void
  removed: (item: unknown) => void
}

/**
 * Unified adapter interface
 * The adapter is service-agnostic and works with unknown items
 * Type safety comes from the Schema, not the adapter
 */
export interface Adapter<
  TParams = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TQuery = Record<string, unknown>,
> {
  // Required core methods
  get(
    serviceName: string,
    resourceId: string | number,
    params?: TParams,
  ): Promise<QueryResponse<unknown, TMeta | undefined>>

  find(serviceName: string, params?: TParams): Promise<QueryResponse<unknown[], TMeta>>

  findAll(serviceName: string, params?: TParams): Promise<QueryResponse<unknown[], TMeta>>

  mutate(serviceName: string, method: string, args: unknown[]): Promise<unknown>

  // Optional real-time support
  subscribe?(serviceName: string, handlers: EventHandlers): () => void

  // Required internal methods
  getId(item: unknown): string | number | undefined

  isItemStale(currItem: unknown, nextItem: unknown): boolean

  // Matcher is typed with TQuery but works with unknown items
  matcher(query: TQuery | undefined, options?: unknown): (item: unknown) => boolean

  // Meta transformation methods
  itemAdded(meta: TMeta): TMeta
  itemRemoved(meta: TMeta): TMeta

  // Initialize empty meta to avoid unsafe casts
  emptyMeta(): TMeta
}

// Helper types to extract adapter properties
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AdapterParams<A> = A extends Adapter<infer P, any, any> ? P : never
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AdapterFindMeta<A> = A extends Adapter<any, infer M, any> ? M : never
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AdapterQuery<A> = A extends Adapter<any, any, infer Q> ? Q : never
