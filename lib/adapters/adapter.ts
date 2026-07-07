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

  // Optional reconnect support. Adapters should call the handler when the transport
  // reconnects after a period where realtime events may have been missed.
  subscribeToReconnect?(handler: () => void): () => void

  /**
   * Read an item's id, or `undefined` when absent. Pure extraction — whether a
   * missing id is noteworthy is the store's call (it warns on event/fetch paths
   * and stays silent on presence checks), not the adapter's.
   */
  getId(item: unknown): string | number | undefined

  isItemStale(currItem: unknown, nextItem: unknown): boolean

  // Matcher is typed with TQuery but works with unknown items
  matcher(query: TQuery | undefined, options?: unknown): (item: unknown) => boolean

  /**
   * Optional: names of custom query operators the app has taught this adapter to
   * evaluate client-side (e.g. `$asOf` on effective-dated services). Queries using
   * these classify as locally maintainable — realtime events merge instead of
   * refetching — so the adapter's `matcher` MUST evaluate them with exactly the
   * server's membership semantics.
   */
  customOperators?: readonly string[]

  // Meta transformation methods
  itemAdded(meta: TMeta): TMeta
  itemRemoved(meta: TMeta): TMeta

  // Initialize empty meta to avoid unsafe casts
  emptyMeta(): TMeta

  /**
   * Meta for a find answered locally from the cache: the store knows the window it
   * computed (`total`/`limit`/`skip`), but only the adapter knows the meta envelope
   * its consumers expect those numbers in.
   */
  findMeta(window: { total: number; limit: number; skip: number }): TMeta
}

// Helper types to extract adapter properties
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export type AdapterParams<A> = A extends Adapter<infer P, any, any> ? P : never
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export type AdapterFindMeta<A> = A extends Adapter<any, infer M, any> ? M : never
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export type AdapterQuery<A> = A extends Adapter<any, any, infer Q> ? Q : never
