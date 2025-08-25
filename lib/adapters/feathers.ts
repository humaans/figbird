import type { Adapter, EventHandlers, QueryResponse } from './adapter.js'
import { matcher, type PrepareQueryOptions } from './matcher.js'

// Helper types for field extraction
type IdExtractor = (item: unknown) => string | number | undefined
type IdFieldType = string | IdExtractor

type UpdatedAtExtractor = (item: unknown) => string | Date | number | null | undefined
type UpdatedAtFieldType = string | UpdatedAtExtractor

type Timestamp = string | number | Date | null | undefined

// Feathers-specific types for the Feathers adapter

/**
 * Feathers query parameters
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
 * Feathers service method parameters
 * Now generic over TQuery for type-safe query handling
 */
export interface FeathersParams<TQuery extends Record<string, unknown> = FeathersQuery> {
  query?: TQuery
  connection?: unknown
  headers?: Record<string, string>
  [key: string]: unknown
}

/**
 * Feathers-specific metadata for find operations
 */
export interface FeathersFindMeta {
  total: number
  limit: number
  skip: number
  [key: string]: unknown
}

/**
 * Feathers item with standard id and timestamp fields
 */
export interface FeathersItem {
  id?: string | number
  _id?: string | number
  updatedAt?: string | Date | number | null
  updated_at?: string | Date | number | null
  createdAt?: string | Date | number | null
  created_at?: string | Date | number | null
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

export class FeathersAdapter<TQuery extends Record<string, unknown> = FeathersQuery>
  implements Adapter<FeathersParams<TQuery>, FeathersFindMeta, TQuery>
{
  feathers?: FeathersClient
  #idField: IdFieldType
  #updatedAtField: UpdatedAtFieldType
  #defaultPageSize?: number
  #defaultPageSizeWhenFetchingAll?: number

  constructor(
    feathers: FeathersClient,
    {
      idField = (item: unknown) => (item as FeathersItem).id || (item as FeathersItem)._id,
      updatedAtField = (item: unknown) =>
        (item as FeathersItem).updatedAt || (item as FeathersItem).updated_at,
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
    return this.feathers!.service(serviceName)
  }

  async get(
    serviceName: string,
    resourceId: string | number,
    params?: FeathersParams<TQuery>,
  ): Promise<QueryResponse<unknown, FeathersFindMeta>> {
    const res = await this.#service(serviceName).get(resourceId, params as FeathersParams)
    return { data: res, meta: { total: 1, limit: 1, skip: 0 } }
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
    if (this.#defaultPageSize && !params?.query?.$limit) {
      params = { ...params }
      params.query = { ...params.query, $limit: this.#defaultPageSize } as unknown as TQuery
    }
    return this.#_find(serviceName, params)
  }

  async findAll(
    serviceName: string,
    params?: FeathersParams<TQuery>,
  ): Promise<QueryResponse<unknown[], FeathersFindMeta>> {
    const defaultPageSize = this.#defaultPageSizeWhenFetchingAll || this.#defaultPageSize
    if (defaultPageSize && !params?.query?.$limit) {
      params = { ...params }
      params.query = { ...params.query, $limit: defaultPageSize } as unknown as TQuery
    }

    const result: QueryResponse<unknown[], FeathersFindMeta> = {
      data: [],
      meta: { total: -1, limit: 0, skip: 0 },
    }
    let $skip = 0

    while (true) {
      const { data, meta } = await this.#_find(serviceName, {
        ...params,
        query: { ...params?.query, $skip } as unknown as TQuery,
      })

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return matcher(query as any, options)
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
