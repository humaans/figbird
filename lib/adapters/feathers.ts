import type { Adapter, EventHandlers, QueryResponse } from './adapter.js'
import { matcher, type PrepareQueryOptions, type Query } from './matcher.js'

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
export interface FeathersParams<TQuery extends Record<string, unknown> = Record<string, unknown>> {
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

/**
 * Feathers service interface
 */
export interface FeathersService {
  get(id: string | number, params?: FeathersParams): Promise<unknown>
  find(
    params?: FeathersParams,
  ): Promise<{ data: unknown[]; total?: number; limit?: number; skip?: number } | unknown[]>
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

interface FeathersAdapterOptions {
  idField?: IdFieldType
  updatedAtField?: UpdatedAtFieldType
  defaultPageSize?: number
  defaultPageSizeWhenFetchingAll?: number
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

export class FeathersAdapter<TQuery extends Record<string, unknown> = Record<string, unknown>>
  implements Adapter<FeathersParams<TQuery>, FeathersFindMeta, TQuery>
{
  feathers: FeathersClient
  #idField: IdFieldType
  #updatedAtField: UpdatedAtFieldType
  #defaultPageSize: number | undefined
  #defaultPageSizeWhenFetchingAll: number | undefined

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
    }: FeathersAdapterOptions = {},
  ) {
    this.feathers = feathers
    this.#idField = idField
    this.#updatedAtField = updatedAtField
    this.#defaultPageSize = defaultPageSize
    this.#defaultPageSizeWhenFetchingAll = defaultPageSizeWhenFetchingAll
  }

  #service(serviceName: string): FeathersService {
    return this.feathers.service(serviceName)
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
    if (Array.isArray(res)) {
      return { data: res, meta: { total: -1, limit: res.length, skip: 0 } }
    } else {
      const { data, total = -1, limit = data.length, skip = 0, ...rest } = res
      return { data, meta: { total, limit, skip, ...rest } }
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
        (meta.total >= 0 && result.data.length >= meta.total)

      if (done) return result

      $skip = result.data.length
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

  getId(item: unknown): string | number | undefined {
    const id =
      typeof this.#idField === 'string'
        ? ((item as Record<string, unknown>)[this.#idField] as string | number | undefined)
        : this.#idField(item)
    if (!id) console.warn('An item has been received without any ID', item)
    return id
  }

  #getUpdatedAt(item: unknown): string | Date | number | null | undefined {
    return typeof this.#updatedAtField === 'string'
      ? ((item as Record<string, unknown>)[this.#updatedAtField] as
          | string
          | Date
          | number
          | null
          | undefined)
      : this.#updatedAtField(item)
  }

  isItemStale(currItem: unknown, nextItem: unknown): boolean {
    const currMs = toEpochMs(this.#getUpdatedAt(currItem))
    const nextMs = toEpochMs(this.#getUpdatedAt(nextItem))

    // If either timestamp is missing, consider stale to force update
    if (currMs == null || nextMs == null) {
      return true
    }

    // Next is stale if its timestamp is older than current
    return nextMs < currMs
  }

  matcher(
    query: TQuery | null | undefined,
    options?: PrepareQueryOptions,
  ): (item: unknown) => boolean {
    // Cast to Query type - the matcher function will validate and clean the query internally
    return matcher(query as Query | null | undefined, options)
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
}
