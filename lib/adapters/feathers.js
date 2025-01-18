import { matcher } from './filterQuery'

export class FeathersAdapter {
  feathers = null
  #idField
  #updatedAtField
  #defaultPageSize

  constructor(
    feathers,
    {
      idField = item => item.id || item._id,
      updatedAtField = item => item.updatedAt || item.updated_at,
      defaultPageSize,
    } = {},
  ) {
    this.feathers = feathers
    this.#idField = idField
    this.#updatedAtField = updatedAtField
    this.#defaultPageSize = defaultPageSize
  }

  #service(serviceName) {
    return this.feathers.service(serviceName)
  }

  get(serviceName, resourceId, params) {
    return this.#service(serviceName).get(resourceId, params)
  }

  find(serviceName, params) {
    if (this.#defaultPageSize && !params?.query?.$limit) {
      params = { ...params }
      params.query = { ...params.query, $limit: this.#defaultPageSize }
    }
    return this.#service(serviceName).find(params)
  }

  findAll(serviceName, params) {
    return new Promise((resolve, reject) => {
      let skip = 0
      const result = { data: [], skip: 0 }

      const doFind = skip => {
        return this.find(serviceName, {
          ...params,
          query: {
            ...(params.query || {}),
            $skip: skip,
          },
        })
      }

      const resolveOrFetchNext = res => {
        if (
          res.data.length === 0 ||
          res.data.length < res.limit ||
          // allow total to be undefined or -1 to indicate
          // that total will not be available on this endpoint
          (typeof res.total === 'number' && res.total >= 0 && result.data.length >= res.total)
        ) {
          resolve(result)
        } else {
          skip = result.data.length
          fetchNext()
        }
      }

      const fetchNext = () => {
        doFind(skip)
          .then(res => {
            result.limit = res.limit
            result.total = res.total
            result.data = result.data.concat(res.data)

            resolveOrFetchNext(res)
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

  matcher(query) {
    return matcher(query)
  }
}
