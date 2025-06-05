import { matcher } from './matcher.js'

// Type definitions
interface ServiceResponse<T> {
  data: T
  meta: Record<string, any>
}

interface FindResponse<T> {
  data: T[]
  meta: {
    total?: number
    limit?: number
    skip?: number
    [key: string]: any
  }
}

interface FeathersService {
  get(id: string | number, params?: any): Promise<any>
  find(params?: any): Promise<any>
  create(data: any, params?: any): Promise<any>
  update(id: string | number, data: any, params?: any): Promise<any>
  patch(id: string | number, data: any, params?: any): Promise<any>
  remove(id: string | number, params?: any): Promise<any>
  on(event: string, listener: (data: any) => void): void
  off(event: string, listener: (data: any) => void): void
  [method: string]: any
}

interface FeathersClient {
  service(name: string): FeathersService
}

interface EventHandlers {
  created: (data: any) => void
  updated: (data: any) => void
  patched: (data: any) => void
  removed: (data: any) => void
}

type IdFieldType = string | ((item: any) => string | number | undefined)
type UpdatedAtFieldType = string | ((item: any) => any)

interface FeathersAdapterOptions {
  idField?: IdFieldType
  updatedAtField?: UpdatedAtFieldType
  defaultPageSize?: number
  defaultPageSizeWhenFetchingAll?: number
}

export class FeathersAdapter {
  feathers: FeathersClient | null = null

  #idField: IdFieldType
  #updatedAtField: UpdatedAtFieldType
  #defaultPageSize?: number
  #defaultPageSizeWhenFetchingAll?: number

  constructor(
    feathers: FeathersClient,
    {
      idField = (item: any) => item.id || item._id,
      updatedAtField = (item: any) => item.updatedAt || item.updated_at,
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
    params?: any,
  ): Promise<ServiceResponse<any>> {
    const res = await this.#service(serviceName).get(resourceId, params)
    return { data: res, meta: {} }
  }

  async #_find(serviceName: string, params?: any): Promise<FindResponse<any>> {
    const res = await this.#service(serviceName).find(params)
    if (res && res.data && Array.isArray(res.data)) {
      const { data, ...meta } = res
      return { data, meta }
    } else {
      return { data: res, meta: {} }
    }
  }

  async find(serviceName: string, params?: any): Promise<FindResponse<any>> {
    if (this.#defaultPageSize && !params?.query?.$limit) {
      params = { ...params }
      params.query = { ...params.query, $limit: this.#defaultPageSize }
    }
    return this.#_find(serviceName, params)
  }

  findAll(serviceName: string, params?: any): Promise<FindResponse<any>> {
    const defaultPageSize = this.#defaultPageSizeWhenFetchingAll || this.#defaultPageSize
    if (defaultPageSize && !params?.query?.$limit) {
      params = { ...params }
      params.query = { ...params.query, $limit: defaultPageSize }
    }

    return new Promise((resolve, reject) => {
      let $skip = 0
      const result: FindResponse<any> = {
        data: [],
        meta: { skip: 0 },
      }

      const resolveOrFetchNext = ({ data, meta }: FindResponse<any>) => {
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
          query: { ...params.query, $skip },
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

  mutate(serviceName: string, method: string, args: any[]): Promise<any> {
    return this.#service(serviceName)[method](...args)
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

  getId(item: any): string | number | undefined {
    const id = typeof this.#idField === 'string' ? item[this.#idField] : this.#idField(item)
    if (!id) console.warn('An item has been received without any ID', item)
    return id
  }

  #getUpdatedAt(item: any): any {
    return typeof this.#updatedAtField === 'string'
      ? item[this.#updatedAtField]
      : this.#updatedAtField(item)
  }

  isItemStale(currItem: any, nextItem: any): boolean {
    const currUpdatedAt = this.#getUpdatedAt(currItem)
    const nextUpdatedAt = this.#getUpdatedAt(nextItem)
    return nextUpdatedAt && nextUpdatedAt < currUpdatedAt
  }

  matcher(query: any, options?: any): (item: any) => boolean {
    return matcher(query, options)
  }

  itemAdded(meta: any): any {
    if (meta?.total && typeof meta.total === 'number' && meta?.total >= 0) {
      return { ...meta, total: meta.total + 1 }
    } else {
      return meta
    }
  }

  itemRemoved(meta: any): any {
    if (meta?.total && typeof meta.total === 'number' && meta?.total > 0) {
      return { ...meta, total: meta.total - 1 }
    } else {
      return meta
    }
  }
}
