import { hashObject, getIn, setIn, updateIn, mergeIn, unsetIn, forEachObj } from './helpers'
import { fetch } from './fetch'
import { matcher as defaultMatcher } from './filterQuery'

const loading = {
  data: null,
  error: null,
  status: 'loading',
  isFetching: true,
}

const defaultIdField = item => item.id || item._id
const defaultUpdatedAtField = item => item.updatedAt || item.updated_at

export class Figbird {
  feathers = null

  // config
  #idField
  #updatedAtField
  #defaultPageSize
  #defaultPageSizeWhenFetchingAll

  // subs
  #realtime = new Map()
  #listeners = new Set()

  // TODO - remove, move into state
  #queries = new Map()

  #state = {
    entities: {},
    queries: {},
    refs: {},
    index: {},
    lookups: {
      serviceNamesByQueryId: {},
    },
  }

  constructor({
    feathers,
    idField = defaultIdField,
    updatedAtField = defaultUpdatedAtField,
    defaultPageSize,
    defaultPageSizeWhenFetchingAll,
  }) {
    this.feathers = feathers
    this.#idField = idField
    this.#updatedAtField = updatedAtField
    this.#defaultPageSize = defaultPageSize
    this.#defaultPageSizeWhenFetchingAll = defaultPageSizeWhenFetchingAll
  }

  getQueryState(queryId) {
    const { queries, lookups } = this.getState()
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
    const statusForQuery = this.status(query.queryId)
    const isFetching = this.isFetching(query.queryId)
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
        this.vacuum(queryId)
      }
    }
  }

  refetch(query) {
    this.queue(query)
  }

  async queue(query) {
    const feathers = this.feathers

    this.fetching({
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

      this.fetched({
        queryId: query.queryId,
        serviceName: query.service,
        data: result,
      })
    } catch (err) {
      this.fetchFailed({
        queryId: query.queryId,
        serviceName: query.service,
        error: err,
      })
    }
  }

  mutate({ serviceName, method, args }) {
    const updaters = {
      create: item => this.created({ serviceName, item }),
      update: item => this.updated({ serviceName, item }),
      patch: item => this.patched({ serviceName, item }),
      remove: item => this.removed({ serviceName, item }),
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
    const created = item => this.created({ serviceName: query.service, item })
    const updated = item => this.updated({ serviceName: query.service, item })
    const patched = item => this.patched({ serviceName: query.service, item })
    const removed = item => this.removed({ serviceName: query.service, item })

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

  getState() {
    return this.#state
  }

  setState(fn) {
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

  vacuum(queryId) {
    this.setState(curr => this.#computeDestroyed(curr, { queryId }))
  }

  fetching(payload) {
    this.setState(curr => this.#computeFetching(curr, payload))
  }

  fetched(payload) {
    this.setState(curr => this.#computeFetched(curr, payload))
  }

  fetchFailed(payload) {
    this.setState(curr => this.#computeFetchFailed(curr, payload))
  }

  created(payload) {
    this.setState(curr => this.#computeCreated(curr, payload))
  }

  updated(payload) {
    this.setState(curr => this.#computeUpdated(curr, payload))
  }

  patched(payload) {
    this.setState(curr => this.#computePatched(curr, payload))
  }

  removed(payload) {
    this.setState(curr => this.#computeRemoved(curr, payload))
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
    const query = getIn(curr, ['queries', serviceName, queryId])

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
      next = setIn(next, ['entities', serviceName], entities)
      next = setIn(next, ['index', serviceName], index)
    }

    // update queries
    next = mergeIn(next, ['queries', serviceName, queryId], {
      // params,
      data,
      meta,
      status: 'success',
      isFetching: false,
      error: null,
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
