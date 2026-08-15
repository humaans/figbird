/**
 * Generic response wrapper for all operations
 * - For find-like operations, include meta (e.g. pagination info)
 * - For get-like operations, adapters may omit meta entirely
 */
export type QueryResponse<TData, TMeta = undefined> = {
  data: TData
} & (TMeta extends undefined ? Record<never, never> : { meta: TMeta })

/** A native page response always carries normalized continuation information. */
export type PageResponse<TData, TMeta> = QueryResponse<TData, TMeta> & {
  pageInfo: PageInfo
}

/** A stable, serializable token suitable for transport and query-cache identity. */
export type PageCursor = string | number

/** Opaque page request passed to adapters that support native pagination. */
export interface PageRequest {
  limit: number
  /** Adapter-issued continuation from the preceding page. */
  after?: PageCursor
  /** Only the first page asks the server to calculate a total. */
  includeTotal: boolean
}

/** Adapter-neutral page information consumed by the query engine. */
export type PageInfo = (
  | { hasMore: false }
  | {
      hasMore: true
      /** Opaque continuation to pass to the next page request. */
      endCursor: PageCursor
    }
) & {
  total?: number
}

/**
 * Service-level native pagination capability. Sequential sources issue opaque
 * continuations, so later pages must be rebuilt after an earlier page changes.
 */
export interface PageSource<TParams, TMeta> {
  /**
   * `ordering` promises that a cursor remains valid when every explicit filter
   * and ordering input is unchanged. This enables visible, non-window-changing
   * updates to merge locally; omit it for conservative reconciliation on every
   * realtime event.
   */
  cursorStability?: 'ordering'
  find(params: TParams | undefined, page: PageRequest): Promise<PageResponse<unknown[], TMeta>>
}

/**
 * Event handlers for real-time updates
 */
export interface EventHandlers {
  created: (item: unknown) => void
  updated: (item: unknown) => void
  patched: (item: unknown) => void
  removed: (item: unknown) => void
}

/** Adapter transport state consumed by Figbird's canonical sync snapshot. */
export type AdapterConnectionState = 'connecting' | 'connected' | 'disconnected'

/** Service context supplied when the adapter evaluates a query locally. */
export interface MatcherContext {
  serviceName: string
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

  /** Return the native pagination capability for a service, if configured. */
  pageSource?(serviceName: string): PageSource<TParams, TMeta> | undefined

  findAll(serviceName: string, params?: TParams): Promise<QueryResponse<unknown[], TMeta>>

  mutate(serviceName: string, method: string, args: unknown[]): Promise<unknown>

  /** Return false when retrying a failed query cannot help. Errors retry by default. */
  isRetryableError?(error: Error): boolean

  // Optional real-time support
  subscribe?(serviceName: string, handlers: EventHandlers): () => void

  // Optional reconnect support. Adapters should call the handler when the transport
  // reconnects after a period where realtime events may have been missed.
  subscribeToReconnect?(handler: () => void): () => void

  /** Current transport state. Omit when the adapter has no meaningful connection lifecycle. */
  getConnectionState?(): AdapterConnectionState

  /** Notify whenever `getConnectionState()` may have changed. */
  subscribeToConnectionState?(handler: () => void): () => void

  /**
   * Read an item's id, or `undefined` when absent. Pure extraction — whether a
   * missing id is noteworthy is the store's call (it warns on event/fetch paths
   * and stays silent on presence checks), not the adapter's.
   */
  getId(item: unknown): string | number | undefined

  isItemStale(currItem: unknown, nextItem: unknown): boolean

  // Matcher is typed with TQuery but works with unknown items
  matcher(
    query: TQuery | undefined,
    options?: unknown,
    context?: MatcherContext,
  ): (item: unknown) => boolean

  /**
   * Optional: names of custom query operators the app has taught this adapter to
   * evaluate on every service.
   */
  customOperators?: readonly string[]

  /**
   * Optional service-aware custom operator lookup. The returned names include
   * globally supported operators and operators supported for this service.
   */
  customOperatorsFor?(serviceName: string): readonly string[]

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

/**
 * Resolve the operators an adapter can evaluate for one service, including the
 * legacy global-only contract.
 */
export function locallySupportedOperators(
  adapter: Pick<Adapter, 'customOperators' | 'customOperatorsFor'>,
  serviceName: string,
): ReadonlySet<string> {
  return new Set(adapter.customOperatorsFor?.(serviceName) ?? adapter.customOperators ?? [])
}

// Helper types to extract adapter properties
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export type AdapterParams<A> = A extends Adapter<infer P, any, any> ? P : never
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export type AdapterFindMeta<A> = A extends Adapter<any, infer M, any> ? M : never
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export type AdapterQuery<A> = A extends Adapter<any, any, infer Q> ? Q : never
