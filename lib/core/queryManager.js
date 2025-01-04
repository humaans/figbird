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

    return ({ remove = false } = {}) => {
      this.#queries.get(queryId).refs -= 1
      if (remove && this.#queries.get(queryId).refs === 0) {
        this.#queries.delete(queryId)
      }
    }
  }

  async queue(query) {
    const { feathers } = this

    try {
      const result = await fetch(feathers, query.service, query.method, query.id, query.params, {
        queryId: query.queryId,
        transformResponse: data => ({ data: [data] }),
      })

      console.log('dispatching!')
      this.#queryCache.fetched({
        queryId: query.queryId,
        serviceName: query.service,
        method: query.method,
        params: query.params,
        // realtime,
        selectData: data => data[0],
        // matcher,
        data: result,
      })
    } catch (err) {
      console.log('Woopsy', err)
    }
  }

  subscribe(fn) {
    return this.#queryCache.subscribe(fn)
  }
}
