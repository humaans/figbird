import { hashObject } from './helpers'
import { fetch } from './fetch'
import { QueryCache } from './queryCache'

export class QueryManager {
  #queryCache
  #queries = new Map()
  #realtime = new Map()
  #feathers

  constructor({ feathers, idField, updatedAtField }) {
    this.#feathers = feathers
    this.#queryCache = new QueryCache({ idField, updatedAtField })
  }

  createQuery(query) {
    const queryId = `q:${hashObject(query)}`
    return { queryId: queryId, ...query }
  }

  addQuery(query) {
    const { queryId } = query
    if (!this.#queries.has(queryId)) {
      this.#queries.set(queryId, { query, refs: 0 })
    } else {
      this.#queries.get(queryId).refs += 1
    }

    const statusForQuery = this.#queryCache.status(query.queryId)
    if (
      (statusForQuery !== 'success' && statusForQuery !== 'loading') ||
      (statusForQuery === 'success' && query.fetchPolicy === 'swr')
    ) {
      this.queue(query)
    }

    this.listenToRealtime(query)

    return ({ remove = false } = {}) => {
      this.#queries.get(queryId).refs -= 1
      if (remove && this.#queries.get(queryId).refs === 0) {
        this.#queries.delete(queryId)
      }
    }
  }

  refetch(query) {
    this.queue(query)
  }

  async queue(query) {
    const feathers = this.#feathers

    this.#queryCache.fetching({
      queryId: query.queryId,
      serviceName: query.service,
      method: query.method,
      params: query.params,
      realtime: query.realtime,
      // matcher
    })

    try {
      const result = await fetch(feathers, query.service, query.method, query.id, query.params, {
        queryId: query.queryId,
        allPages: query.allPages,
        parallel: query.parallel,
        parallelLimit: query.parallelLimit,
      })

      // TODO - just store as is "correctly" in the cache, do not de-normalize
      if (query.method === 'get') result = { data: [result] }

      this.#queryCache.fetched({
        queryId: query.queryId,
        serviceName: query.service,
        method: query.method,
        params: query.params,
        realtime: query.realtime,
        // matcher,
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

  // TODO - unsub!?
  listenToRealtime(query) {
    // already listening
    if (this.#realtime.has(query.service)) return

    const service = this.#feathers.service(query.service)
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
}
