import { matcher as defaultMatcher } from '../core/filterQuery'
import { getIn, setIn, updateIn, mergeIn, unsetIn, forEachObj } from '../core/helpers'

const defaultIdField = item => item.id || item._id
const defaultUpdatedAtField = item => item.updatedAt || item.updated_at

export class QueryCache {
  #state = {
    entities: {},
    queries: {},
    refs: {},
    index: {},
    lookups: {
      serviceNamesByQueryId: {},
    },
  }
  #listeners = new Set()
  #idField
  #updatedAtField

  constructor({ idField = defaultIdField, updatedAtField = defaultUpdatedAtField }) {
    this.#idField = idField
    this.#updatedAtField = updatedAtField
  }

  get() {
    return this.#state
  }

  set(fn) {
    this.#state = fn(this.#state)
    this.#listeners.forEach(listener => listener(this.#state))
  }

  status(queryId) {
    const serviceName = this.#state.lookups.serviceNamesByQueryId[queryId]
    return this.#state.queries[serviceName]?.[queryId]?.status
  }

  isFetching(queryId) {
    const serviceName = this.#state.lookups.serviceNamesByQueryId[queryId]
    return this.#state.queries[serviceName]?.[queryId]?.isFetching
  }

  getId(item) {
    const idField = this.#idField
    const id = typeof idField === 'string' ? item[idField] : idField(item)
    if (!id) console.warn('An item has been received without any ID', item)
    return id
  }

  getUpdatedAt(item) {
    const updatedAtField = this.#updatedAtField
    return typeof updatedAtField === 'string' ? item[updatedAtField] : updatedAtField(item)
  }

  subscribe(fn) {
    this.#listeners.add(fn)
    return () => {
      this.#listeners.delete(fn)
    }
  }

  destroy(queryId) {
    this.set(curr => this.#computeDestroyed(curr, { queryId }))
  }

  fetching(payload) {
    this.set(curr => this.#computeFetching(curr, payload))
  }

  fetched(payload) {
    this.set(curr => this.#computeFetched(curr, payload))
  }

  fetchFailed(payload) {
    this.set(curr => this.#computeFetchFailed(curr, payload))
  }

  created(payload) {
    this.set(curr => this.#computeCreated(curr, payload))
  }

  updated(payload) {
    this.set(curr => this.#computeUpdated(curr, payload))
  }

  patched(payload) {
    this.set(curr => this.#computePatched(curr, payload))
  }

  removed(payload) {
    this.set(curr => this.#computeRemoved(curr, payload))
  }

  #computeDestroyed(curr, { queryId }) {
    const serviceName = getIn(curr, ['lookups', 'serviceNamesByQueryId', queryId])

    let next = curr

    const query = getIn(curr, ['queries', serviceName, queryId])
    if (query) {
      // for (const item of query.data) {
      //   next = updateIn(next, ['index', serviceName, this.#idField(item)], index => {
      //     const next = { ...index, queries: { ...index.queries }, size: index.size - 1 }
      //     delete next.queries[queryId]
      //     return next
      //   })
      // }
      next = unsetIn(curr, ['queries', serviceName, queryId])
    }
    return next
  }

  #computeFetching(
    curr,
    {
      serviceName,
      data,
      method,
      params,
      queryId,
      realtime,
      fetchPolicy,
      allPages,
      parallel,
      parallelLimit,
      matcher,
    },
  ) {
    let next = curr

    // existing query being refetched!
    if (getIn(next, ['queries', serviceName, queryId])) {
      next = updateIn(next, ['queries', serviceName, queryId], query =>
        query.status === 'error'
          ? {
              ...query,
              status: 'loading',
              error: null,
              isFetching: true,
            }
          : {
              ...query,
              isFetching: true,
            },
      )
    } else {
      // update queries
      next = setIn(next, ['queries', serviceName, queryId], {
        params,
        data: null,
        meta: {},
        method,
        realtime,
        fetchPolicy,
        allPages,
        parallel,
        parallelLimit,
        matcher,
        status: 'loading',
        isFetching: true,
        error: null,
      })

      // update queryId index
      if (getIn(next, ['lookups', 'serviceNamesByQueryId', queryId]) !== serviceName) {
        next = setIn(next, ['lookups', 'serviceNamesByQueryId', queryId], serviceName)
      }
    }

    return next
  }

  #computeFetched(curr, { queryId, serviceName, data: result }) {
    // TODO - do we really need this? don't think so, remove if tests pass
    // we already inserted this response to cache
    const query = getIn(curr, ['queries', serviceName, queryId])
    const prevData = getIn(curr, ['queries', serviceName, queryId, 'res'])

    if (prevData === result) {
      return curr
    }

    let next = curr

    let meta
    let data

    if (query.method === 'find') {
      const { data: _data, ..._meta } = result
      meta = _meta
      data = _data
    } else {
      meta = {}
      data = result
    }

    const entities = query.realtime === 'merge' ? { ...getIn(next, ['entities', serviceName]) } : {}
    const index = query.realtime === 'merge' ? { ...getIn(next, ['index', serviceName]) } : {}
    const items = Array.isArray(data) ? data : [data]
    for (const item of items) {
      const itemId = this.getId(item)
      entities[itemId] = item

      if (query.realtime === 'merge') {
        const itemIndex = { ...index[itemId] }
        itemIndex.queries = { ...itemIndex.queries, [queryId]: true }
        itemIndex.size = itemIndex.size ? itemIndex.size + 1 : 1
        index[itemId] = itemIndex
      }
    }

    if (query.realtime === 'merge') {
      // update entities
      next = setIn(next, ['entities', serviceName], entities)
      next = setIn(next, ['index', serviceName], index)
    }

    // update queries
    next = mergeIn(next, ['queries', serviceName, queryId], {
      // params,
      data,
      meta,
      res: data,
      status: 'success',
      isFetching: false,
      error: null,
      ...(query.realtime === 'merge' ? {} : { entities }),
    })

    // update queryId index
    if (getIn(next, ['lookups', 'serviceNamesByQueryId', queryId]) !== serviceName) {
      next = setIn(next, ['lookups', 'serviceNamesByQueryId', queryId], serviceName)
    }

    return next
  }

  #computeFetchFailed(curr, { queryId, serviceName, error }) {
    let next = curr

    next = mergeIn(next, ['queries', serviceName, queryId], {
      data: null,
      meta: {},
      res: null,
      status: 'error',
      isFetching: false,
      error,
    })

    // update queryId index
    if (getIn(next, ['lookups', 'serviceNamesByQueryId', queryId]) !== serviceName) {
      next = setIn(next, ['lookups', 'serviceNamesByQueryId', queryId], serviceName)
    }

    return next
  }

  #computeCreated(curr, { serviceName, item }) {
    return this.#updateQueries(curr, { serviceName, method: 'create', item })
  }

  #computeUpdated(curr, { serviceName, item }) {
    const itemId = this.getId(item)

    const currItem = getIn(curr, ['entities', serviceName, itemId])

    // check to see if we should discard this update
    if (currItem) {
      const currUpdatedAt = this.getUpdatedAt(currItem)
      const nextUpdatedAt = this.getUpdatedAt(item)
      if (nextUpdatedAt && nextUpdatedAt < currUpdatedAt) {
        return curr
      }
    }

    let next = curr
    if (currItem) {
      next = setIn(next, ['entities', serviceName, itemId], item)
    } else {
      const index = { queries: {}, size: 0 }
      next = setIn(next, ['entities', serviceName, itemId], item)
      next = setIn(next, ['index', serviceName, itemId], index)
    }

    return this.#updateQueries(next, { serviceName, method: 'update', item })
  }

  #computePatched(curr, payload) {
    return this.#computeUpdated(curr, payload)
  }

  #computeRemoved(curr, { serviceName, item: itemOrItems }) {
    const items = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems]

    const exists = items.some(item => getIn(curr, ['entities', serviceName, this.getId(item)]))
    if (!exists) return curr

    // updating queries updates state, get a fresh copy
    let next = curr
    next = this.#updateQueries(next, { serviceName, method: 'remove', item: itemOrItems })

    // now remove it from entities
    const serviceEntities = { ...getIn(next, ['entities', serviceName]) }
    for (const item of items) {
      delete serviceEntities[this.getId(item)]
      next = setIn(next, ['entities', serviceName], serviceEntities)
    }
    return next
  }

  #updateQueries(curr, { serviceName, method, item: itemOrItems }) {
    const items = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems]
    let next = curr

    for (const item of items) {
      const itemId = this.getId(item)
      const queries = { ...getIn(next, ['queries', serviceName]) }
      const index = { ...getIn(next, ['index', serviceName, itemId]) }
      index.queries = { ...index.queries }
      index.size = index.size || 0

      let updateCount = 0

      forEachObj(queries, (query, queryId) => {
        let matches

        // do not update non realtime queries
        // those get updated/refetched in a different way
        if (query.realtime !== 'merge') {
          return
        }

        if (method === 'remove') {
          // optimisation, if method is remove, we want to immediately remove the object
          // from cache, which means we don't need to match using matcher
          matches = false
        } else if (!query.params.query || Object.keys(query.params.query).length === 0) {
          // another optimisation, if there is no query, the object matches
          matches = true
        } else {
          const matcher = query.matcher ? query.matcher(defaultMatcher) : defaultMatcher
          matches = matcher(query.params.query)(item)
        }

        if (index.queries[queryId]) {
          if (!matches) {
            updateCount++
            queries[queryId] = {
              ...query,
              meta: { ...query.meta, total: query.meta.total - 1 },
              data: query.data.filter(x => this.getId(x) !== itemId),
            }
            delete index.queries[queryId]
            index.size -= 1
          } else {
            updateCount++
            queries[queryId] = {
              ...query,
              data: Array.isArray(query.data)
                ? // find case
                  query.data.map(x => (this.getId(x) === itemId ? item : x))
                : // get case
                  this.getId(query.data) === itemId
                  ? item
                  : query.data,
            }
          }
        } else {
          // only add if query has fetched all of the data..
          // if it hasn't fetched all of the data then leave this
          // up to the consumer of the figbird to decide if data
          // should be refetched
          if (matches && query.data && query.data.length <= query.meta.total) {
            updateCount++
            // TODO - sort
            queries[queryId] = {
              ...query,
              meta: { ...query.meta, total: query.meta.total + 1 },
              data: query.data.concat(item),
            }
            index.queries[queryId] = true
            index.size += 1
          }
        }
      })

      if (updateCount > 0) {
        next = setIn(next, ['queries', serviceName], queries)
        next = setIn(next, ['index', serviceName, itemId], index)

        // in case of create, only ever add it to the cache if it's relevant for any of the
        // queries, otherwise, we might end up piling in newly created objects into cache
        // even if the app never uses them
        if (!getIn(next, ['entities', serviceName, itemId])) {
          next = setIn(next, ['entities', serviceName, itemId], item)
        }

        // this item is no longer relevant to any query, garbage collect it
        if (index.size === 0) {
          next = unsetIn(next, ['entities', serviceName, itemId])
          next = unsetIn(next, ['index', serviceName, itemId])
        }
      }
    }

    return next
  }
}
