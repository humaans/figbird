import type {
  Adapter,
  EventHandlers,
  MatcherContext,
  PageInfo,
  PageRequest,
  PageResponse,
  PageSource,
  QueryResponse,
} from './adapter.js'
import { matcher, type PrepareQueryOptions, type Query } from './matcher.js'
import type {
  Schema,
  ServiceNames,
  ServiceItem,
  ServiceCreate,
  ServiceUpdate,
  ServicePatch,
  ServiceQuery,
  ServiceMethods,
} from '../core/schema.js'

// Helper types for field extraction
type IdExtractor = (item: unknown) => string | number | undefined
type IdFieldType = string | IdExtractor

type UpdatedAtExtractor = (item: unknown) => string | Date | number | null | undefined
type UpdatedAtFieldType = string | UpdatedAtExtractor

type Timestamp = string | number | Date | null | undefined

// Feathers-specific types for the Feathers adapter

/**
 * Example usage with domain query types:
 * ```typescript
 * // In your schema, define your query fields including any Feathers controls you need
 * interface TodoQuery {
 *   completed?: boolean
 *   category?: string
 *   priority?: 'low' | 'medium' | 'high'
 *   $limit?: number
 *   $skip?: number
 *   $sort?: Record<string, 1 | -1>
 * }
 *
 * // The adapter is generic over your query type
 * const adapter = new FeathersAdapter<TodoQuery>(feathers)
 *
 * // Users get full type safety
 * const params: FeathersParams<TodoQuery> = {
 *   query: {
 *     completed: true,      // Domain field
 *     priority: 'high',     // Domain field
 *     $limit: 10,          // Control field (if included in your type)
 *     $skip: 20,           // Control field (if included in your type)
 *     $sort: { createdAt: -1 } // Control field (if included in your type)
 *   }
 * }
 * ```
 */

/**
 * Feathers service method parameters
 * Generic over TQuery for type-safe query handling
 */
export interface FeathersParams<TQuery = Record<string, unknown>> {
  /**
   * Query fields for filtering, sorting, pagination, etc.
   * When used with Figbird schemas, the query type is inferred per service.
   */
  query?: TQuery
  /** Optional connection information passed through to the Feathers client. */
  connection?: unknown
  /** Optional headers to include with the request. */
  headers?: Record<string, string>
  /** Any additional adapter-specific params are allowed. */
  [key: string]: unknown
}

/**
 * Feathers-specific metadata for find operations
 */
export interface FeathersFindMeta {
  /** Total number of items matching the query (may be -1 if unknown). */
  total: number
  /** Page size used for the current result set. */
  limit: number
  /** Number of items skipped (offset) for this page. */
  skip: number
  /** Additional adapter-specific metadata. */
  [key: string]: unknown
}

type FeathersFindResult =
  | {
      data: unknown[]
      total?: number
      limit?: number
      skip?: number
    }
  | unknown[]

/** Request/response mapping for a cursor-paginated Feathers service. */
export interface FeathersCursorPagination {
  query(page: PageRequest): Record<string, unknown>
  pageInfo(response: unknown): PageInfo
}

export interface CursorPaginationOptions {
  /**
   * Map Figbird's adapter-neutral request to Feathers query controls. Defaults
   * to Humaans' `cursor`/`cursorLimit`/`returnCursor` protocol.
   */
  query?: (page: PageRequest) => Record<string, unknown>
  /**
   * Read continuation information from the raw service response. Defaults to
   * `{ pageInfo: { hasNextPage, endCursor, total? } }`.
   */
  pageInfo?: (response: unknown) => PageInfo
}

/**
 * Configure one Feathers service to use opaque cursor pagination.
 *
 * @example
 * new FeathersAdapter(client, {
 *   pagination: { 'api/documents': cursorPagination() },
 * })
 */
export function cursorPagination({
  query = page => ({
    cursorLimit: page.limit,
    returnCursor: true,
    ...(page.after !== undefined ? { cursor: page.after } : {}),
    ...(page.returnTotal ? { returnTotal: true } : {}),
  }),
  pageInfo = response => {
    const value = (response as { pageInfo?: Record<string, unknown> } | null)?.pageInfo
    if (!value || typeof value.hasNextPage !== 'boolean') {
      throw new Error('Cursor-paginated Feathers response must include pageInfo.hasNextPage')
    }
    const result: PageInfo = {
      hasMore: value.hasNextPage,
      ...(Object.hasOwn(value, 'endCursor') ? { endCursor: value.endCursor } : {}),
      ...(typeof value.total === 'number' ? { total: value.total } : {}),
    }
    if (result.hasMore && result.endCursor == null) {
      throw new Error('Cursor-paginated Feathers response has more pages but no pageInfo.endCursor')
    }
    return result
  },
}: CursorPaginationOptions = {}): FeathersCursorPagination {
  return { query, pageInfo }
}

/**
 * Feathers service interface
 */
export interface FeathersService {
  get(id: string | number, params?: FeathersParams): Promise<unknown>
  find(params?: FeathersParams): Promise<FeathersFindResult>
  create(data: unknown, params?: FeathersParams): Promise<unknown>
  create(data: unknown[], params?: FeathersParams): Promise<unknown[]>
  update(id: string | number, data: unknown, params?: FeathersParams): Promise<unknown>
  patch(id: string | number, data: unknown, params?: FeathersParams): Promise<unknown>
  remove(id: string | number, params?: FeathersParams): Promise<unknown>
  on(event: string, listener: (data: unknown) => void): void
  off(event: string, listener: (data: unknown) => void): void
  [method: string]: unknown
}

/**
 * Feathers client interface
 */
export interface FeathersClient {
  service(name: string): FeathersService
  [key: string]: unknown
}

interface ReconnectEventSource {
  on(event: string, listener: () => void): void
  off?: (event: string, listener: () => void) => void
  removeListener?: (event: string, listener: () => void) => void
}

/**
 * Typed Feathers service for a specific service in the schema.
 * Provides full type safety for CRUD methods and custom methods.
 */
export type TypedFeathersService<
  TItem,
  TCreate,
  TUpdate,
  TPatch,
  TQuery,
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  TMethods extends Record<string, (...args: any[]) => any>,
> = {
  get(id: string | number, params?: FeathersParams<TQuery>): Promise<TItem>
  find(
    params?: FeathersParams<TQuery>,
  ): Promise<{ data: TItem[]; total?: number; limit?: number; skip?: number } | TItem[]>
  create(data: TCreate, params?: FeathersParams<TQuery>): Promise<TItem>
  create(data: TCreate[], params?: FeathersParams<TQuery>): Promise<TItem[]>
  update(id: string | number, data: TUpdate, params?: FeathersParams<TQuery>): Promise<TItem>
  patch(id: string | number, data: TPatch, params?: FeathersParams<TQuery>): Promise<TItem>
  remove(id: string | number, params?: FeathersParams<TQuery>): Promise<TItem>
  on(event: string, listener: (data: TItem) => void): void
  off(event: string, listener: (data: TItem) => void): void
} & TMethods

/**
 * Typed Feathers client based on schema.
 * Uses a mapped type that creates a union of call signatures, enabling literal
 * narrowing: when you call service('notes'), only the 'notes' signature matches.
 *
 * @example
 * const client: TypedFeathersClient<typeof schema> = ...
 * const note = await client.service('notes').get('1')  // note: Note
 * await client.service('notes').archive(['1'])         // Custom method typed!
 */
export type TypedFeathersClient<S extends Schema> = {
  service<N extends ServiceNames<S>>(
    serviceName: N,
  ): TypedFeathersService<
    ServiceItem<S, N>,
    ServiceCreate<S, N>,
    ServiceUpdate<S, N>,
    ServicePatch<S, N>,
    ServiceQuery<S, N>,
    ServiceMethods<S, N>
  >
}

/**
 * A custom query operator implementation: receives the operand from the query
 * (`{ $asOf: '2026-07-06' }` → `'2026-07-06'`) and the resolved service path,
 * then returns an item predicate. Registered operators are matched at the top level
 * of the query.
 */
export interface CustomOperatorContext {
  serviceName: string
}

export type CustomOperator = (
  operand: unknown,
  context: CustomOperatorContext,
) => (item: unknown) => boolean

export type CustomOperatorRegistration =
  | CustomOperator
  | {
      byService: Record<string, CustomOperator>
    }

export interface FeathersAdapterOptions {
  idField?: IdFieldType
  updatedAtField?: UpdatedAtFieldType
  defaultPageSize?: number
  defaultPageSizeWhenFetchingAll?: number
  /**
   * Teach the client to evaluate custom query operators locally, so queries using
   * them stay realtime-mergeable instead of classifying server-authoritative.
   *
   * This is a correctness contract: the predicate must reproduce the server's
   * membership semantics for the operator exactly — figbird will trust it to decide
   * which realtime events belong in which query results.
   *
   * @example
   * operators: {
   *   $asOf: asOf => item => isEffectiveOn(item, asOf),
   *   $visibleAt: {
   *     byService: {
   *       'api/posts': visibleAt => item => isVisibleAt(item, visibleAt),
   *     },
   *   },
   * }
   */
  operators?: Record<string, CustomOperatorRegistration>
  /** Native pagination strategy, selected by Feathers service path. */
  pagination?: Record<string, FeathersCursorPagination>
}

/**
 * Helper function to normalize timestamps to epoch milliseconds
 */
function toEpochMs(ts: Timestamp): number | null {
  if (ts == null) return null
  if (typeof ts === 'number') return ts
  if (typeof ts === 'string') {
    return new Date(ts).getTime()
  }
  return ts instanceof Date ? ts.getTime() : null
}

export class FeathersAdapter<TQuery = Record<string, unknown>> implements Adapter<
  FeathersParams<TQuery>,
  FeathersFindMeta,
  TQuery
> {
  feathers: FeathersClient
  #idField: IdFieldType
  #updatedAtField: UpdatedAtFieldType
  #defaultPageSize: number | undefined
  #defaultPageSizeWhenFetchingAll: number | undefined
  #operators: Record<string, CustomOperatorRegistration>
  #pagination: Record<string, FeathersCursorPagination>

  /** Names of custom operators registered for every service. */
  get customOperators(): readonly string[] {
    return Object.entries(this.#operators)
      .filter(([, registration]) => typeof registration === 'function')
      .map(([name]) => name)
  }

  /** Names of global and service-scoped custom operators available on a service. */
  customOperatorsFor(serviceName: string): readonly string[] {
    return Object.entries(this.#operators)
      .filter(
        ([, registration]) =>
          typeof registration === 'function' || registration.byService[serviceName] !== undefined,
      )
      .map(([name]) => name)
  }

  /**
   * Helper to merge query parameters while maintaining type safety
   */
  #mergeQueryParams(
    params: FeathersParams<TQuery> | undefined,
    additionalQuery: Record<string, unknown>,
  ): FeathersParams<TQuery> {
    return {
      ...params,
      query: { ...params?.query, ...additionalQuery } as TQuery,
    }
  }

  constructor(
    feathers: FeathersClient,
    {
      idField = (item: unknown) => {
        const obj = item as Record<string, unknown>
        return (obj.id ?? obj._id) as string | number | undefined
      },
      updatedAtField = (item: unknown) => {
        const obj = item as Record<string, unknown>
        return (obj.updatedAt ?? obj.updated_at) as string | Date | number | null | undefined
      },
      defaultPageSize,
      defaultPageSizeWhenFetchingAll,
      operators = {},
      pagination = {},
    }: FeathersAdapterOptions = {},
  ) {
    this.feathers = feathers
    this.#idField = idField
    this.#updatedAtField = updatedAtField
    this.#defaultPageSize = defaultPageSize
    this.#defaultPageSizeWhenFetchingAll = defaultPageSizeWhenFetchingAll
    this.#operators = operators
    this.#pagination = pagination
  }

  #service(serviceName: string): FeathersService {
    return this.feathers.service(serviceName)
  }

  isRetryableError(error: Error): boolean {
    const code = 'code' in error ? error.code : undefined
    return typeof code !== 'number' || code < 400 || code === 408 || code === 429 || code >= 500
  }

  async get(
    serviceName: string,
    resourceId: string | number,
    params?: FeathersParams<TQuery>,
  ): Promise<QueryResponse<unknown, undefined>> {
    const res = await this.#service(serviceName).get(resourceId, params as FeathersParams)
    // Feathers does not provide useful meta for get; return only the item
    return { data: res }
  }

  async #_find(
    serviceName: string,
    params?: FeathersParams<TQuery>,
  ): Promise<QueryResponse<unknown[], FeathersFindMeta>> {
    const res = await this.#service(serviceName).find(params as FeathersParams)
    return this.#normalizeFind(res)
  }

  #normalizeFind(res: FeathersFindResult): QueryResponse<unknown[], FeathersFindMeta> {
    if (Array.isArray(res)) {
      return { data: res, meta: { total: -1, limit: res.length, skip: 0 } }
    } else {
      const { data, total = -1, limit = data.length, skip = 0, ...rest } = res
      return { data, meta: { total, limit, skip, ...rest } }
    }
  }

  pageSource(
    serviceName: string,
  ): PageSource<FeathersParams<TQuery>, FeathersFindMeta> | undefined {
    const pagination = this.#pagination[serviceName]
    if (!pagination) return undefined
    return {
      dependency: 'sequential',
      find: (params, page) => this.#findPage(serviceName, pagination, params, page),
    }
  }

  async #findPage(
    serviceName: string,
    pagination: FeathersCursorPagination,
    params: FeathersParams<TQuery> | undefined,
    page: PageRequest,
  ): Promise<PageResponse<unknown[], FeathersFindMeta>> {
    const raw = await this.#service(serviceName).find(
      this.#mergeQueryParams(params, pagination.query(page)) as FeathersParams,
    )
    const normalized = this.#normalizeFind(raw)
    const pageInfo = pagination.pageInfo(raw)
    if (typeof pageInfo.hasMore !== 'boolean') {
      throw new Error(`Cursor pagination for "${serviceName}" did not return hasMore`)
    }
    if (pageInfo.hasMore && pageInfo.endCursor == null) {
      throw new Error(`Cursor pagination for "${serviceName}" has more pages but no endCursor`)
    }
    if (pageInfo.hasMore && Object.is(page.after, pageInfo.endCursor)) {
      throw new Error(`Cursor pagination for "${serviceName}" returned the same cursor twice`)
    }
    return {
      ...normalized,
      pageInfo,
      meta:
        pageInfo.total === undefined
          ? normalized.meta
          : { ...normalized.meta, total: pageInfo.total },
    }
  }

  async find(
    serviceName: string,
    params?: FeathersParams<TQuery>,
  ): Promise<QueryResponse<unknown[], FeathersFindMeta>> {
    const queryLimit = (params?.query as Record<string, unknown>)?.$limit
    if (this.#defaultPageSize && !queryLimit) {
      return this.#_find(
        serviceName,
        this.#mergeQueryParams(params, { $limit: this.#defaultPageSize }),
      )
    }
    return this.#_find(serviceName, params)
  }

  async findAll(
    serviceName: string,
    params?: FeathersParams<TQuery>,
  ): Promise<QueryResponse<unknown[], FeathersFindMeta>> {
    const pagination = this.#pagination[serviceName]
    if (pagination) {
      return this.#findAllByCursor(serviceName, pagination, params)
    }
    const defaultPageSize = this.#defaultPageSizeWhenFetchingAll || this.#defaultPageSize
    const queryLimit = (params?.query as Record<string, unknown>)?.$limit
    const baseParams =
      defaultPageSize && !queryLimit
        ? this.#mergeQueryParams(params, { $limit: defaultPageSize })
        : params || {}

    const result: QueryResponse<unknown[], FeathersFindMeta> = {
      data: [],
      meta: { total: -1, limit: 0, skip: 0 },
    }
    let $skip = 0

    while (true) {
      const { data, meta } = await this.#_find(
        serviceName,
        this.#mergeQueryParams(baseParams, { $skip }),
      )

      result.meta = { ...result.meta, ...meta }
      result.data.push(...data)

      const done =
        data.length === 0 ||
        data.length < meta.limit ||
        // allow total to be -1 to indicate that total will not be available on this endpoint
        (meta.total > 0 && result.data.length >= meta.total)

      if (done) return result

      $skip = result.data.length
    }
  }

  async #findAllByCursor(
    serviceName: string,
    pagination: FeathersCursorPagination,
    params?: FeathersParams<TQuery>,
  ): Promise<QueryResponse<unknown[], FeathersFindMeta>> {
    const limit = this.#defaultPageSizeWhenFetchingAll || this.#defaultPageSize || 50
    const result: QueryResponse<unknown[], FeathersFindMeta> = {
      data: [],
      meta: { total: -1, limit, skip: 0 },
    }
    let after: unknown = undefined
    let first = true

    while (true) {
      const page = await this.#findPage(serviceName, pagination, params, {
        limit,
        ...(after !== undefined ? { after } : {}),
        returnTotal: first,
      })
      result.data.push(...page.data)
      const knownTotal = result.meta.total >= 0 ? result.meta.total : page.meta.total
      result.meta = { ...result.meta, ...page.meta, total: knownTotal, limit, skip: 0 }
      if (!page.pageInfo.hasMore) return result
      after = page.pageInfo.endCursor
      first = false
    }
  }

  mutate(serviceName: string, method: string, args: unknown[]): Promise<unknown> {
    const service = this.#service(serviceName)
    const serviceMethod = service[method]
    if (typeof serviceMethod === 'function') {
      return serviceMethod.apply(service, args)
    }
    throw new Error(`Method ${method} not found on service ${serviceName}`)
  }

  subscribe(serviceName: string, handlers: EventHandlers): () => void {
    const service = this.#service(serviceName)

    service.on('created', handlers.created)
    service.on('updated', handlers.updated)
    service.on('patched', handlers.patched)
    service.on('removed', handlers.removed)

    return () => {
      service.off('created', handlers.created)
      service.off('updated', handlers.updated)
      service.off('patched', handlers.patched)
      service.off('removed', handlers.removed)
    }
  }

  subscribeToReconnect(handler: () => void): () => void {
    const source = this.#getReconnectEventSource()
    if (!source) return () => {}

    source.on('reconnect', handler)
    return () => {
      if (source.off) {
        source.off('reconnect', handler)
      } else {
        source.removeListener?.('reconnect', handler)
      }
    }
  }

  #getReconnectEventSource(): ReconnectEventSource | null {
    const io = (this.feathers as { io?: { io?: unknown } }).io
    const candidates = [
      // socket.io v3+ emits 'reconnect' on the Manager (socket.io), not the Socket —
      // prefer it when present, otherwise fall back to the socket itself (older
      // clients and primus emit 'reconnect' directly).
      io?.io,
      io,
      (this.feathers as { socket?: unknown }).socket,
      (this.feathers as { primus?: unknown }).primus,
    ]

    for (const candidate of candidates) {
      if (
        candidate &&
        typeof candidate === 'object' &&
        'on' in candidate &&
        typeof candidate.on === 'function'
      ) {
        return candidate as ReconnectEventSource
      }
    }

    return null
  }

  getId(item: unknown): string | number | undefined {
    return typeof this.#idField === 'string'
      ? ((item as Record<string, unknown>)[this.#idField] as string | number | undefined)
      : this.#idField(item)
  }

  #getUpdatedAt(item: unknown): string | Date | number | null | undefined {
    return typeof this.#updatedAtField === 'string'
      ? ((item as Record<string, unknown>)[this.#updatedAtField] as
          string | Date | number | null | undefined)
      : this.#updatedAtField(item)
  }

  isItemStale(currItem: unknown, nextItem: unknown): boolean {
    const currMs = toEpochMs(this.#getUpdatedAt(currItem))
    const nextMs = toEpochMs(this.#getUpdatedAt(nextItem))

    // If either timestamp is missing, consider not stale to allow update
    if (currMs == null || nextMs == null) {
      return false
    }

    // Next is stale if its timestamp is older than current
    return nextMs < currMs
  }

  #operatorFor(name: string, context: MatcherContext | undefined): CustomOperator | undefined {
    if (!Object.hasOwn(this.#operators, name)) return undefined

    const registration = this.#operators[name]!
    if (typeof registration === 'function') return registration
    if (!context) {
      throw new Error(
        `figbird: custom operator "${name}" is service-scoped, but matcher() was called ` +
          'without a serviceName context.',
      )
    }
    return registration.byService[context.serviceName]
  }

  matcher(
    query: TQuery | undefined,
    options?: PrepareQueryOptions,
    context?: MatcherContext,
  ): (item: unknown) => boolean {
    // Registered custom operators are peeled off the top level of the query and
    // composed as predicates around the sift-based matcher for the rest.
    const q = query as Record<string, unknown> | undefined
    const rest: Record<string, unknown> = {}
    const predicates: Array<(item: unknown) => boolean> = []
    const operatorContext = { serviceName: context?.serviceName ?? '' }

    for (const [name, operand] of Object.entries(q ?? {})) {
      const handler = this.#operatorFor(name, context)
      if (handler) {
        predicates.push(handler(operand, operatorContext))
      } else {
        rest[name] = operand
      }
    }

    // Cast to Query type - the matcher function will validate and clean the query internally
    if (predicates.length === 0) return matcher(query as Query | undefined, options)

    const base = matcher(rest as Query, options)
    return item => base(item) && predicates.every(predicate => predicate(item))
  }

  itemAdded(meta: FeathersFindMeta): FeathersFindMeta {
    // If total is -1 (indicating unavailable), keep it as -1
    if (meta.total < 0) {
      return meta
    }
    return { ...meta, total: meta.total + 1 }
  }

  itemRemoved(meta: FeathersFindMeta): FeathersFindMeta {
    // If total is -1 (indicating unavailable), keep it as -1
    if (meta.total < 0) {
      return meta
    }
    return { ...meta, total: Math.max(0, meta.total - 1) }
  }

  emptyMeta(): FeathersFindMeta {
    return { total: -1, limit: 0, skip: 0 }
  }

  findMeta(window: { total: number; limit: number; skip: number }): FeathersFindMeta {
    return window
  }
}
