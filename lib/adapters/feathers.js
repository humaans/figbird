import { matcher } from './matcher.js'

export class FeathersAdapter {
  feathers = null

  #idField
  #updatedAtField
  #defaultPageSize
  #defaultPageSizeWhenFetchingAll

  constructor(
    feathers,
    {
      idField = item => item.id || item._id,
      updatedAtField = item => item.updatedAt || item.updated_at,
      defaultPageSize,
      defaultPageSizeWhenFetchingAll,
    } = {},
  ) {
    this.feathers = feathers
    this.#idField = idField
    this.#updatedAtField = updatedAtField
    this.#defaultPageSize = defaultPageSize
    this.#defaultPageSizeWhenFetchingAll = defaultPageSizeWhenFetchingAll
  }

  #service(serviceName) {
    return this.feathers.service(serviceName)
  }

  async get(serviceName, resourceId, params) {
    const res = await this.#service(serviceName).get(resourceId, params)
    return { data: res, meta: {} }
  }

  async #_find(serviceName, params) {
    const res = await this.#service(serviceName).find(params)
    if (res && res.data && Array.isArray(res.data)) {
      const { data, ...meta } = res
      return { data, meta }
    } else {
      return { data: res, meta: {} }
    }
  }

  async find(serviceName, params) {
    if (this.#defaultPageSize && !params?.query?.$limit) {
      params = { ...params }
      params.query = { ...params.query, $limit: this.#defaultPageSize }
    }
    return this.#_find(serviceName, params)
  }

  findAll(serviceName, params) {
    const defaultPageSize = this.#defaultPageSizeWhenFetchingAll || this.#defaultPageSize
    if (defaultPageSize && !params?.query?.$limit) {
      params = { ...params }
      params.query = { ...params.query, $limit: defaultPageSize }
    }

    return new Promise((resolve, reject) => {
      let $skip = 0
      const result = {
        data: [],
        meta: { skip: 0 },
      }

      const resolveOrFetchNext = ({ data, meta }) => {
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

  mutate(serviceName, method, args) {
    return this.#service(serviceName)[method](...args)
  }

  subscribe(serviceName, handlers) {
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

  getId(item) {
    const id = typeof this.#idField === 'string' ? item[this.#idField] : this.#idField(item)
    if (!id) console.warn('An item has been received without any ID', item)
    return id
  }

  #getUpdatedAt(item) {
    return typeof this.#updatedAtField === 'string'
      ? item[this.#updatedAtField]
      : this.#updatedAtField(item)
  }

  isItemStale(currItem, nextItem) {
    const currUpdatedAt = this.#getUpdatedAt(currItem)
    const nextUpdatedAt = this.#getUpdatedAt(nextItem)
    return nextUpdatedAt && nextUpdatedAt < currUpdatedAt
  }

  matcher(query, options) {
    return matcher(query, options)
  }

  itemAdded(meta) {
    if (meta?.total && typeof meta.total === 'number' && meta?.total >= 0) {
      return { ...meta, total: meta.total + 1 }
    } else {
      return meta
    }
  }

  itemRemoved(meta) {
    if (meta?.total && typeof meta.total === 'number' && meta?.total > 0) {
      return { ...meta, total: meta.total - 1 }
    } else {
      return meta
    }
  }
}
