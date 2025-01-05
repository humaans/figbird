import { hashObject } from './helpers'
import { fetch } from './fetch'
import { QueryCache } from './queryCache'

export class QueryManager {
  #queryCache = new QueryCache()
  #queries = new Map()

  constructor({ feathers }) {
    this.feathers = feathers
  }

  createQuery(query) {
    const queryId = `q${hashObject(query)}`
    return { queryId: queryId, ...query }
  }

  addQuery(query) {
    const { queryId } = query
    if (!this.#queries.has(queryId)) {
      this.#queries.set(queryId, { query, refs: 0 })
    } else {
      this.#queries.get(queryId).refs += 1
    }

    this.queue(query)
    this.listenToRealtime(query)

    return ({ remove = false } = {}) => {
      this.#queries.get(queryId).refs -= 1
      if (remove && this.#queries.get(queryId).refs === 0) {
        this.#queries.delete(queryId)
      }
    }
  }

  async queue(query) {
    const { feathers } = this

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
    const service = this.feathers.service(query.service)
    const created = item => this.#queryCache.created({ serviceName: query.service, item })
    const updated = item => this.#queryCache.updated({ serviceName: query.service, item })
    const patched = item => this.#queryCache.patched({ serviceName: query.service, item })
    const removed = item => this.#queryCache.removed({ serviceName: query.service, item })

    service.on('created', created)
    service.on('updated', updated)
    service.on('patched', patched)
    service.on('removed', removed)
  }

  subscribe(fn) {
    return this.#queryCache.subscribe(fn)
  }
}
