import { hashObject, getIn, setIn } from './helpers'
import { fetch } from './fetch'
import { QueryCache } from './queryCache'

const loading = {
  data: null,
  error: null,
  status: 'loading',
  isFetching: true,
}

export class Figbird {
  #queryCache
  #queries = new Map()
  #realtime = new Map()
  #defaultPageSize
  #defaultPageSizeWhenFetchingAll
  feathers = null

  constructor({
    feathers,
    idField,
    updatedAtField,
    defaultPageSize,
    defaultPageSizeWhenFetchingAll,
  }) {
    this.feathers = feathers
    this.#queryCache = new QueryCache({ idField, updatedAtField })
    this.#defaultPageSize = defaultPageSize
    this.#defaultPageSizeWhenFetchingAll = defaultPageSizeWhenFetchingAll
  }

  debug() {
    return this.#queryCache.get()
  }

  getQueryState(queryId) {
    const { queries, lookups } = this.#queryCache.get()
    const serviceName = getIn(lookups, ['serviceNamesByQueryId', queryId])
    const query = getIn(queries, [serviceName, queryId])

    if (!query) {
      return loading
    }

    return query
  }

  createQuery(query) {
    if (this.#defaultPageSizeWhenFetchingAll && query.allPages && !query.params?.query?.$limit) {
      query = setIn(query, ['params', 'query', '$limit'], this.#defaultPageSizeWhenFetchingAll)
    } else if (this.#defaultPageSize && (!query.params || !query.params.$limit)) {
      query = setIn(query, ['params', 'query', '$limit'], this.#defaultPageSize)
    }

    const queryId = `q:${hashObject(query)}`

    return { queryId: queryId, ...query }
  }

  watchQuery(query) {
    const { queryId } = query
    if (!this.#queries.has(queryId)) {
      this.#queries.set(queryId, { query, refs: 1 })
    } else {
      this.#queries.get(queryId).refs += 1
    }

    // TODO - simplificate
    const statusForQuery = this.#queryCache.status(query.queryId)
    const isFetching = this.#queryCache.isFetching(query.queryId)
    if (
      (statusForQuery !== 'success' && statusForQuery !== 'loading') ||
      (statusForQuery === 'success' && query.fetchPolicy === 'swr' && !isFetching) ||
      (statusForQuery === 'success' && query.fetchPolicy === 'network-only' && !isFetching)
    ) {
      this.queue(query)
    }

    this.listenToRealtime(query)

    const shouldRemoveByDefault = query.fetchPolicy === 'network-only'
    return ({ remove = shouldRemoveByDefault } = {}) => {
      this.#queries.get(queryId).refs -= 1
      if (remove && this.#queries.get(queryId).refs === 0) {
        this.#queries.delete(queryId)
        this.#queryCache.destroy(queryId)
      }
    }
  }

  refetch(query) {
    this.queue(query)
  }

  async queue(query) {
    const feathers = this.feathers

    this.#queryCache.fetching({
      queryId: query.queryId,
      serviceName: query.service,
      method: query.method,
      params: query.params,
      realtime: query.realtime,
      fetchPolicy: query.fetchPolicy,
      matcher: query.matcher,
    })

    try {
      const result = await fetch(feathers, query.service, query.method, query.id, query.params, {
        queryId: query.queryId,
        allPages: query.allPages,
        parallel: query.parallel,
        parallelLimit: query.parallelLimit,
      })

      // TODO - just store as is "correctly" in the cache, do not de-normalize
      // if (query.method === 'get') result = { data: [result] }

      this.#queryCache.fetched({
        queryId: query.queryId,
        serviceName: query.service,
        data: result,
      })
    } catch (err) {
      this.#queryCache.fetchFailed({
        queryId: query.queryId,
        serviceName: query.service,
        error: err,
      })
    }
  }

  mutate({ serviceName, method, args }) {
    const updaters = {
      create: item => this.#queryCache.created({ serviceName, item }),
      update: item => this.#queryCache.updated({ serviceName, item }),
      patch: item => this.#queryCache.patched({ serviceName, item }),
      remove: item => this.#queryCache.removed({ serviceName, item }),
    }

    const feathers = this.feathers
    const service = feathers.service(serviceName)
    return service[method](...args).then(item => {
      updaters[method](item)
    })
  }

  // TODO - unsub!?
  listenToRealtime(query) {
    // already listening
    if (this.#realtime.has(query.service)) return

    const service = this.feathers.service(query.service)
    const created = item => this.#queryCache.created({ serviceName: query.service, item })
    const updated = item => this.#queryCache.updated({ serviceName: query.service, item })
    const patched = item => this.#queryCache.patched({ serviceName: query.service, item })
    const removed = item => this.#queryCache.removed({ serviceName: query.service, item })

    service.on('created', created)
    service.on('updated', updated)
    service.on('patched', patched)
    service.on('removed', removed)

    const refetch = () => this.refetchRefetchableQueries()

    service.on('created', refetch)
    service.on('updated', refetch)
    service.on('patched', refetch)
    service.on('removed', refetch)

    this.#realtime.set(query.service, true)
  }

  refetchRefetchableQueries() {
    for (const [_, { query }] of this.#queries) {
      if (query.realtime === 'refetch') {
        this.refetch(query)
      }
    }
  }

  subscribe(fn) {
    return this.#queryCache.subscribe(fn)
  }

  destroy() {
    // TOOD
  }
}
