import { matcher } from './matcher'
import { Schema } from '../core/schema'

export type ServiceName<S extends Schema<any>> = keyof S & string

export type ServiceEntityType<
  S extends Schema<any>,
  N extends ServiceName<S>,
> = S[N]['resolvedType']

type ServicePath<S extends Schema<any>, N extends ServiceName<S>> = S[N]['serviceName']

type FeathersService<T> = {
  get(id: string | number, params?: Params): Promise<T>
  find(params?: Params): Promise<T[] | { data: T[]; total: number; limit: number; skip: number }>
  on(event: string, handler: (data: T) => void): void
  off(event: string, handler: (data: T) => void): void
  create(data: Partial<T>, params?: Params): Promise<T>
  update(id: string | number, data: T, params?: Params): Promise<T>
  patch(id: string | number, data: Partial<T>, params?: Params): Promise<T>
  remove(id: string | number, params?: Params): Promise<T>
  [key: string]: ((...args: any[]) => Promise<any>) | any
}

type Meta = {
  limit?: number
  total?: number
  skip?: number
}

type Params = {
  query?: {
    $limit?: number
    $skip?: number
    [key: string]: any
  }
  [key: string]: any
}

type FeathersClient<S extends Schema<any>> = {
  service<N extends ServiceName<S>>(
    path: ServicePath<S, N>,
  ): FeathersService<ServiceEntityType<S, N>>
}

type EventHandlers<T> = {
  created: (data: T) => void
  updated: (data: T) => void
  patched: (data: T) => void
  removed: (data: T) => void
}

type Item = {
  id?: string | number
  _id?: string | number
  updatedAt?: string | number
  updated_at?: string | number
  [key: string]: any
}

type FeathersAdapterOptions<S extends Schema<any>> = {
  schema?: S
  idField?: string | ((item: Item) => string | number | undefined)
  updatedAtField?: string | ((item: Item) => string | number | undefined)
  defaultPageSize?: number
  defaultPageSizeWhenFetchingAll?: number
}

export class FeathersAdapter<S extends Schema<any>> {
  feathers: FeathersClient<S>
  schema: S | undefined

  #idField: string | ((item: Item) => string | number | undefined)
  #updatedAtField: string | ((item: Item) => string | number | undefined)
  #defaultPageSize?: number
  #defaultPageSizeWhenFetchingAll?: number

  constructor(
    feathers: FeathersClient<S>,
    {
      schema,
      idField = (item: Item) => item.id || item._id,
      updatedAtField = (item: Item) => item.updatedAt || item.updated_at,
      defaultPageSize,
      defaultPageSizeWhenFetchingAll,
    }: FeathersAdapterOptions<S> = {},
  ) {
    this.feathers = feathers
    this.schema = schema
    this.#idField = idField
    this.#updatedAtField = updatedAtField
    this.#defaultPageSize = defaultPageSize
    this.#defaultPageSizeWhenFetchingAll = defaultPageSizeWhenFetchingAll
  }

  #service<N extends ServiceName<S>>(serviceName: N): FeathersService<ServiceEntityType<S, N>> {
    if (this.schema) {
      // We'll use the real Feathers path from `schema[serviceName].serviceName`
      const path = this.schema[serviceName].serviceName
      return this.feathers.service<N>(path)
    } else {
      // Fallback: assume the "serviceName" key is the same as the Feathers path
      return this.feathers.service<N>(serviceName as unknown as ServicePath<S, N>)
    }
  }

  async get<N extends ServiceName<S>>(
    serviceName: N,
    resourceId: string | number,
    params?: Params,
  ): Promise<{ data: ServiceEntityType<S, N>; meta: {} }> {
    const res = await this.#service(serviceName).get(resourceId, params)
    return { data: res, meta: {} }
  }

  async #_find<N extends ServiceName<S>>(
    serviceName: N,
    params?: Params,
  ): Promise<{
    data: ServiceEntityType<S, N>[]
    meta: Partial<Meta>
  }> {
    const res = await this.#service(serviceName).find(params)
    if (res && 'data' in res && Array.isArray(res.data)) {
      const { data, ...meta } = res
      return { data, meta }
    } else {
      // If Feathers returned a plain array, wrap it
      return { data: res as ServiceEntityType<S, N>[], meta: {} }
    }
  }

  async find<N extends ServiceName<S>>(
    serviceName: N,
    params?: Params,
  ): Promise<{ data: ServiceEntityType<S, N>[]; meta: Partial<Meta> }> {
    if (this.#defaultPageSize && !params?.query?.$limit) {
      params = { ...params }
      params.query = { ...params.query, $limit: this.#defaultPageSize }
    }
    return this.#_find(serviceName, params)
  }

  findAll<N extends ServiceName<S>>(
    serviceName: N,
    params?: Params,
  ): Promise<{
    data: ServiceEntityType<S, N>[]
    skip: number
    limit?: number
    total?: number
  }> {
    const defaultPageSize = this.#defaultPageSizeWhenFetchingAll || this.#defaultPageSize
    if (defaultPageSize && !params?.query?.$limit) {
      params = { ...params }
      params.query = { ...params.query, $limit: defaultPageSize }
    }

    return new Promise<{
      data: ServiceEntityType<S, N>[]
      skip: number
      limit?: number
      total?: number
    }>((resolve, reject) => {
      let $skip = 0
      const result: {
        data: ServiceEntityType<S, N>[]
        skip: number
        limit?: number
        total?: number
      } = { data: [], skip: 0 }

      const resolveOrFetchNext = ({
        data,
        meta,
      }: {
        data: ServiceEntityType<S, N>[]
        meta: Meta
      }) => {
        if (
          data.length === 0 ||
          data.length < (meta.limit || 0) ||
          (typeof meta.total === 'number' && result.data.length >= meta.total)
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
            if ('limit' in meta) {
              result.limit = meta.limit
            }
            if ('total' in meta) {
              result.total = meta.total
            }
            result.data = result.data.concat(data)
            resolveOrFetchNext({ data, meta })
          })
          .catch(reject)
      }

      fetchNext()
    })
  }

  mutate<N extends ServiceName<S>>(
    serviceName: N,
    method: string,
    args: any[],
  ): Promise<ServiceEntityType<S, N>> {
    const service = this.#service(serviceName)
    return (service[method] as (...args: any[]) => Promise<ServiceEntityType<S, N>>)(...args)
  }

  subscribe<N extends ServiceName<S>>(
    serviceName: N,
    handlers: EventHandlers<ServiceEntityType<S, N>>,
  ) {
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

  getId(item: Item) {
    const id = typeof this.#idField === 'string' ? item[this.#idField] : this.#idField(item)
    if (!id) console.warn('An item has been received without any ID', item)
    return id
  }

  #getUpdatedAt(item: Item) {
    return typeof this.#updatedAtField === 'string'
      ? item[this.#updatedAtField]
      : this.#updatedAtField(item)
  }

  isItemStale(currItem: Item, nextItem: Item) {
    const currUpdatedAt = this.#getUpdatedAt(currItem)
    const nextUpdatedAt = this.#getUpdatedAt(nextItem)
    return nextUpdatedAt && nextUpdatedAt < currUpdatedAt
  }

  matcher(query: any) {
    return matcher(query, {})
  }

  itemAdded(meta: Meta | null) {
    if (meta?.total != undefined) {
      return { ...meta, total: meta.total + 1 }
    } else {
      return meta
    }
  }

  itemRemoved(meta: Meta | null) {
    if (meta?.total !== undefined) {
      return { ...meta, total: meta.total - 1 }
    } else {
      return meta
    }
  }
}
