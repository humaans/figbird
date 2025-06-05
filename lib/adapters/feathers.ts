import { matcher, type PrepareQueryOptions } from './matcher.js'
import type {
  ServiceItem,
  TimestampedItem,
  FeathersParams,
  FeathersFindMeta,
  EventHandler,
  EventHandlers,
  IdExtractor,
  UpdatedAtExtractor,
  ServiceResponse,
  FindResponse,
} from '../types.js'

// Type definitions
interface FeathersService<T = ServiceItem> {
  get(id: string | number, params?: FeathersParams): Promise<T>
  find(
    params?: FeathersParams,
  ): Promise<{ data: T[]; total?: number; limit?: number; skip?: number } | T[]>
  create(data: Partial<T>, params?: FeathersParams): Promise<T>
  update(id: string | number, data: Partial<T>, params?: FeathersParams): Promise<T>
  patch(id: string | number, data: Partial<T>, params?: FeathersParams): Promise<T>
  remove(id: string | number, params?: FeathersParams): Promise<T>
  on(event: string, listener: EventHandler<T>): void
  off(event: string, listener: EventHandler<T>): void
  [method: string]: unknown
}

interface FeathersClient {
  service(name: string): FeathersService
}

type IdFieldType<T = ServiceItem> = string | IdExtractor<T>
type UpdatedAtFieldType<T = ServiceItem> = string | UpdatedAtExtractor<T>

interface FeathersAdapterOptions<T = ServiceItem> {
  idField?: IdFieldType<T>
  updatedAtField?: UpdatedAtFieldType<T>
  defaultPageSize?: number
  defaultPageSizeWhenFetchingAll?: number
}

export class FeathersAdapter<T extends ServiceItem = ServiceItem> {
  feathers?: FeathersClient
  #idField: IdFieldType<T>
  #updatedAtField: UpdatedAtFieldType<T>
  #defaultPageSize?: number
  #defaultPageSizeWhenFetchingAll?: number

  constructor(
    feathers: FeathersClient,
    {
      idField = (item: T) => item.id || item._id,
      updatedAtField = (item: T) =>
        (item as TimestampedItem).updatedAt || (item as TimestampedItem).updated_at,
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
  ): Promise<ServiceResponse<T>> {
    const res = await this.#service(serviceName).get(resourceId, params)
    return { data: res, meta: {} }
  }

  async #_find(serviceName: string, params?: FeathersParams): Promise<FindResponse<T>> {
    const res = await this.#service(serviceName).find(params)
    if (Array.isArray(res)) {
      return { data: res, meta: {} }
    } else {
      const { data, ...meta } = res
      return { data, meta }
    }
  }

  async find(serviceName: string, params?: FeathersParams): Promise<FindResponse<T>> {
    if (this.#defaultPageSize && !params?.query?.$limit) {
      params = { ...params }
      params.query = { ...params.query, $limit: this.#defaultPageSize }
    }
    return this.#_find(serviceName, params)
  }

  findAll(serviceName: string, params?: FeathersParams): Promise<FindResponse<T>> {
    const defaultPageSize = this.#defaultPageSizeWhenFetchingAll || this.#defaultPageSize
    if (defaultPageSize && !params?.query?.$limit) {
      params = { ...params }
      params.query = { ...params.query, $limit: defaultPageSize }
    }

    return new Promise((resolve, reject) => {
      let $skip = 0
      const result: FindResponse<T> = {
        data: [],
        meta: { skip: 0 },
      }

      const resolveOrFetchNext = ({ data, meta }: FindResponse<T>) => {
        if (
          data.length === 0 ||
          (typeof meta.limit === 'number' && meta.limit >= 0 && data.length < meta.limit) ||
          // allow total to be undefined or -1 to indicate
          // that total will not be available on this endpoint
          (typeof meta.total === 'number' && meta.total >= 0 && result.data.length >= meta.total)
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
            if (meta.limit !== undefined) {
              result.meta.limit = meta.limit
            }
            if (meta.total !== undefined) {
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

  getId(item: T): string | number | undefined {
    const id =
      typeof this.#idField === 'string'
        ? ((item as Record<string, unknown>)[this.#idField] as string | number | undefined)
        : this.#idField(item)
    if (!id) console.warn('An item has been received without any ID', item)
    return id
  }

  #getUpdatedAt(item: T): string | Date | number | undefined {
    return typeof this.#updatedAtField === 'string'
      ? ((item as Record<string, unknown>)[this.#updatedAtField] as
          | string
          | Date
          | number
          | undefined)
      : this.#updatedAtField(item)
  }

  isItemStale(currItem: T, nextItem: T): boolean {
    const currUpdatedAt = this.#getUpdatedAt(currItem)
    const nextUpdatedAt = this.#getUpdatedAt(nextItem)
    return !!currUpdatedAt && !!nextUpdatedAt && nextUpdatedAt < currUpdatedAt
  }

  matcher(
    query: Record<string, unknown> | null | undefined,
    options?: PrepareQueryOptions,
  ): (item: T) => boolean {
    return matcher<T>(query as Parameters<typeof matcher>[0], options)
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
