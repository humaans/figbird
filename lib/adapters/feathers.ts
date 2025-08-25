import type { Adapter, EventHandlers, QueryResponse } from './adapter.js'
import { matcher, type PrepareQueryOptions } from './matcher.js'

type IdExtractor<T> = (item: T) => string | number | undefined
type UpdatedAtExtractor<T> = (item: T) => string | Date | number | null | undefined

type IdFieldType<T = FeathersItem> = string | IdExtractor<T>
type UpdatedAtFieldType<T = FeathersItem> = string | UpdatedAtExtractor<T>

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
 */
export interface FeathersParams {
  query?: FeathersQuery
  paginate?: boolean | { default?: boolean; max?: number }
  provider?: string
  route?: Record<string, string>
  connection?: unknown
  headers?: Record<string, string>
  [key: string]: unknown
}

/**
 * Feathers-specific metadata for find operations
 */
export interface FeathersFindMeta {
  total?: number
  limit?: number
  skip?: number
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
export interface FeathersService<T = FeathersItem> {
  get(id: string | number, params?: FeathersParams): Promise<T>
  find(
    params?: FeathersParams,
  ): Promise<{ data: T[]; total?: number; limit?: number; skip?: number } | T[]>
  create(data: Partial<T>, params?: FeathersParams): Promise<T>
  create(data: T[], params?: FeathersParams): Promise<T[]>
  update(id: string | number, data: Partial<T>, params?: FeathersParams): Promise<T>
  patch(id: string | number, data: Partial<T>, params?: FeathersParams): Promise<T>
  remove(id: string | number, params?: FeathersParams): Promise<T>
  on(event: string, listener: (data: T) => void): void
  off(event: string, listener: (data: T) => void): void
  [method: string]: unknown
}

/**
 * Feathers client interface
 */
export interface FeathersClient {
  service(name: string): FeathersService
  [key: string]: unknown
}

interface FeathersAdapterOptions<T = FeathersItem> {
  idField?: IdFieldType<T>
  updatedAtField?: UpdatedAtFieldType<T>
  defaultPageSize?: number
  defaultPageSizeWhenFetchingAll?: number
}

export class FeathersAdapter<T = unknown> implements Adapter<T, FeathersParams> {
  feathers?: FeathersClient
  #idField: IdFieldType<T>
  #updatedAtField: UpdatedAtFieldType<T>
  #defaultPageSize?: number
  #defaultPageSizeWhenFetchingAll?: number

  constructor(
    feathers: FeathersClient,
    {
      idField = (item: T) => (item as FeathersItem).id || (item as FeathersItem)._id,
      updatedAtField = (item: T) =>
        (item as FeathersItem).updatedAt || (item as FeathersItem).updated_at,
      defaultPageSize,
      defaultPageSizeWhenFetchingAll,
    }: FeathersAdapterOptions<T> = {},
  ) {
    this.feathers = feathers
    this.#idField = idField
    this.#updatedAtField = updatedAtField
    this.#defaultPageSize = defaultPageSize
    this.#defaultPageSizeWhenFetchingAll = defaultPageSizeWhenFetchingAll
  }

  #service(serviceName: string): FeathersService<T> {
    return this.feathers!.service(serviceName) as FeathersService<T>
  }

  async get(
    serviceName: string,
    resourceId: string | number,
    params?: FeathersParams,
  ): Promise<QueryResponse<T>> {
    const res = await this.#service(serviceName).get(resourceId, params)
    return { data: res, meta: {} }
  }

  async #_find(serviceName: string, params?: FeathersParams): Promise<QueryResponse<T[]>> {
    const res = await this.#service(serviceName).find(params)
    if (Array.isArray(res)) {
      return { data: res, meta: {} }
    } else {
      const { data, ...meta } = res
      return { data, meta }
    }
  }

  async find(serviceName: string, params?: FeathersParams): Promise<QueryResponse<T[]>> {
    if (this.#defaultPageSize && !params?.query?.$limit) {
      params = { ...params }
      params.query = { ...params.query, $limit: this.#defaultPageSize }
    }
    return this.#_find(serviceName, params)
  }

  findAll(serviceName: string, params?: FeathersParams): Promise<QueryResponse<T[]>> {
    const defaultPageSize = this.#defaultPageSizeWhenFetchingAll || this.#defaultPageSize
    if (defaultPageSize && !params?.query?.$limit) {
      params = { ...params }
      params.query = { ...params.query, $limit: defaultPageSize }
    }

    return new Promise((resolve, reject) => {
      let $skip = 0
      const result: QueryResponse<T[]> = {
        data: [],
        meta: { skip: 0 },
      }

      const resolveOrFetchNext = ({ data, meta }: QueryResponse<T[]>) => {
        if (
          data.length === 0 ||
          (meta && typeof meta.limit === 'number' && meta.limit >= 0 && data.length < meta.limit) ||
          // allow total to be undefined or -1 to indicate
          // that total will not be available on this endpoint
          (meta &&
            typeof meta.total === 'number' &&
            meta.total >= 0 &&
            result.data.length >= meta.total)
        ) {
          resolve(result)
        } else {
          $skip = result.data.length
          fetchNext()
        }
      }

      const fetchNext = () => {
        this.#_find(serviceName, {
          ...params,
          query: { ...params?.query, $skip },
        })
          .then(({ data, meta }) => {
            if (meta && meta.limit !== undefined && result.meta) {
              result.meta.limit = meta.limit
            }
            if (meta && meta.total !== undefined && result.meta) {
              result.meta.total = meta.total
            }
            result.data = result.data.concat(data)
            resolveOrFetchNext({ data, meta })
          })
          .catch(reject)
      }

      fetchNext()
    })
  }

  mutate(serviceName: string, method: string, args: unknown[]): Promise<T> {
    const service = this.#service(serviceName)
    const serviceMethod = service[method]
    if (typeof serviceMethod === 'function') {
      return serviceMethod.apply(service, args)
    }
    throw new Error(`Method ${method} not found on service ${serviceName}`)
  }

  subscribe(serviceName: string, handlers: EventHandlers<T>): () => void {
    const service = this.#service(serviceName)

    service.on('created', handlers.created as (data: T) => void)
    service.on('updated', handlers.updated as (data: T) => void)
    service.on('patched', handlers.patched as (data: T) => void)
    service.on('removed', handlers.removed as (data: T) => void)

    return () => {
      service.off('created', handlers.created as (data: T) => void)
      service.off('updated', handlers.updated as (data: T) => void)
      service.off('patched', handlers.patched as (data: T) => void)
      service.off('removed', handlers.removed as (data: T) => void)
    }
  }

  getId(item: T): string | number | undefined {
    const id =
      typeof this.#idField === 'string'
        ? ((item as Record<string, unknown>)[this.#idField] as string | number | undefined)
        : this.#idField(item)
    if (!id) console.warn('An item has been received without any ID', item)
    return id
  }

  #getUpdatedAt(item: T): string | Date | number | null | undefined {
    return typeof this.#updatedAtField === 'string'
      ? ((item as Record<string, unknown>)[this.#updatedAtField] as
          | string
          | Date
          | number
          | null
          | undefined)
      : this.#updatedAtField(item)
  }

  isItemStale(currItem: T, nextItem: T): boolean {
    const currUpdatedAt = this.#getUpdatedAt(currItem)
    const nextUpdatedAt = this.#getUpdatedAt(nextItem)

    // If either timestamp is missing, consider stale to force update
    if (!currUpdatedAt || !nextUpdatedAt) {
      return true
    }

    // If types differ, consider stale to force update
    if (typeof currUpdatedAt !== typeof nextUpdatedAt) {
      console.warn('Mixed updatedAt types detected - considering item stale')
      return true
    }

    // Date objects need special handling
    if (currUpdatedAt instanceof Date && nextUpdatedAt instanceof Date) {
      return nextUpdatedAt.getTime() < currUpdatedAt.getTime()
    }

    // Strings (ISO) and numbers can be compared directly
    return nextUpdatedAt < currUpdatedAt
  }

  matcher(
    query: Record<string, unknown> | null | undefined,
    options?: PrepareQueryOptions,
  ): (item: T) => boolean {
    // Extract custom operators from the query ($ prefixed keys that aren't standard)
    const customOperators: string[] = []
    if (query) {
      for (const key of Object.keys(query)) {
        if (
          key.startsWith('$') &&
          ![
            '$limit',
            '$skip',
            '$sort',
            '$select',
            '$or',
            '$and',
            '$in',
            '$nin',
            '$lt',
            '$lte',
            '$gt',
            '$gte',
            '$ne',
          ].includes(key)
        ) {
          customOperators.push(key)
        }
      }
    }

    // Merge custom operators with any provided in options
    const enhancedOptions: PrepareQueryOptions = {
      ...options,
      operators: [...(options?.operators || []), ...customOperators],
    }

    return matcher<T>(query as Parameters<typeof matcher>[0], enhancedOptions)
  }

  itemAdded(meta: FeathersFindMeta): FeathersFindMeta {
    if (meta?.total && typeof meta.total === 'number' && meta?.total >= 0) {
      return { ...meta, total: meta.total + 1 }
    } else {
      return meta
    }
  }

  itemRemoved(meta: FeathersFindMeta): FeathersFindMeta {
    if (meta?.total && typeof meta.total === 'number' && meta?.total > 0) {
      return { ...meta, total: meta.total - 1 }
    } else {
      return meta
    }
  }
}
