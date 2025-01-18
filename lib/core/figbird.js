import { hashObject, getIn, setIn, updateIn, mergeIn, unsetIn, forEachObj } from './helpers'
import { fetch } from './fetch'
import { matcher as defaultMatcher } from './filterQuery'

const defaultIdField = item => item.id || item._id
const defaultUpdatedAtField = item => item.updatedAt || item.updated_at

// a helper to split a bag of properties
// into a query descriptor `desc`, which includes the pass through `params`
// and query `config` which is figbird specific config
export function splitConfig(combinedConfig) {
  // TODO - fix skip option
  const {
    serviceName,
    method,
    resourceId,
    allPages,
    skip,
    parallel,
    parallelLimit,
    realtime = 'merge',
    fetchPolicy = 'swr',
    matcher,
    ...params // pass through params
  } = combinedConfig

  // query descriptor, describes the shape
  // of the query and is passed to the adapter
  const desc = {
    serviceName,
    method,
    resourceId,
    allPages,
    params,
  }

  // figbird specific config options that
  // drive the query lifecycle
  let config = {
    skip,
    parallel,
    parallelLimit,
    realtime,
    fetchPolicy,
    matcher,
    params,
  }

  return { desc, config }
}

// a lightweight query reference object to make it easy
// subscribe to state changes and read query data
// this is only a ref and does not contain state itself, it instead
// references all the state from the shared figbird query state
class QueryRef {
  constructor({ desc, config, figbird }) {
    this.queryId = `q/${hashObject({ desc, config })}`
    this.desc = desc
    this.config = config
    this.figbird = figbird
  }

  details() {
    return {
      queryId: this.queryId,
      desc: this.desc,
      config: this.config,
    }
  }

  hash() {
    return this.queryId
  }

  subscribe(fn) {
    this.figbird.materialize(this)
    return this.figbird.subscribe(this.queryId, fn)
  }

  getSnapshot() {
    this.figbird.materialize(this)
    return this.figbird.getQueryState(this.queryId)
  }

  refetch() {
    this.figbird.materialize(this)
    return this.figbird.refetch(this.queryId)
  }
}

export class Figbird {
  feathers = null

  // figbird options
  #idField
  #updatedAtField
  #defaultPageSize
  #defaultPageSizeWhenFetchingAll

  // subs
  #realtime = new Set()
  #listeners = new Set()

  #state = {
    entities: {},
    queries: {},
    index: {},
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

  service(serviceName) {
    return this.feathers.service(serviceName)
  }

  getQuery(queryId) {
    return getIn(this.getState(), ['queries', queryId])
  }

  getQueryState(queryId) {
    return this.getQuery(queryId)?.state
  }

  query(desc, config) {
    // handle some helpful global defaults, set a page size when fetching all if limit is not provided
    // GENERALISE: we should move this into the adapter
    if (!desc.params?.query?.$limit) {
      if (this.#defaultPageSizeWhenFetchingAll && desc.allPages) {
        desc = setIn(desc, ['params', 'query', '$limit'], this.#defaultPageSizeWhenFetchingAll)
      } else if (this.#defaultPageSize) {
        desc = setIn(desc, ['params', 'query', '$limit'], this.#defaultPageSize)
      }
    }

    return new QueryRef({ desc, config, figbird: this })
  }

  materialize(queryRef) {
    this.setState(
      state => {
        const { queryId, desc, config } = queryRef.details()
        if (getIn(state, ['queries', queryId])) {
          return state
        } else {
          return setIn(state, ['queries', queryId], {
            queryId,
            desc,
            config,
            refs: 0,
            pending: true,
            state: {
              data: null,
              status: 'loading',
              isFetching: true,
              error: null,
            },
          })
        }
      },
      { silent: true },
    )
  }

  subscribe(queryId, fn) {
    // TODO - simplificate
    const q = this.getQuery(queryId)
    if (
      q.pending ||
      (q.state.status !== 'success' && q.state.status !== 'loading') ||
      (q.state.status === 'success' && q.config.fetchPolicy === 'swr' && !q.state.isFetching) ||
      (q.state.status === 'success' &&
        q.config.fetchPolicy === 'network-only' &&
        !q.state.isFetching)
    ) {
      this.queue(queryId)
    }

    this.#listeners.add(fn)

    // part of subbing
    this.listenToRealtime(queryId)

    const shouldRemoveByDefault = q.config.fetchPolicy === 'network-only'

    this.setState(state => updateIn(state, ['queries', queryId, 'refs'], curr => curr + 1), {
      silent: true,
    })

    return ({ remove = shouldRemoveByDefault } = {}) => {
      this.#listeners.delete(fn)

      const state = this.setState(state => {
        return updateIn(state, ['queries', queryId, 'refs'], curr => curr - 1, { silent: true })
      })

      if (remove && getIn(state, ['queries', queryId, 'refs'])) {
        this.vacuum({ queryId })
      }
    }
  }

  refetch(queryId) {
    const q = this.getQuery(queryId)
    if (
      q.pending ||
      (q.state.status !== 'success' && q.state.status !== 'loading') ||
      (q.state.status === 'success' && q.config.fetchPolicy === 'swr' && !q.state.isFetching) ||
      (q.state.status === 'success' &&
        q.config.fetchPolicy === 'network-only' &&
        !q.state.isFetching)
    ) {
      this.queue(queryId)
    }
  }

  async queue(queryId) {
    this.fetching({ queryId })
    try {
      const result = await this.fetch(queryId)
      this.fetched({ queryId, result })
    } catch (err) {
      this.fetchFailed({ queryId, error: err })
    }
  }

  fetch(queryId) {
    const query = this.getQuery(queryId)
    const desc = query.desc
    const config = query.config
    return fetch(this.feathers, {
      serviceName: desc.serviceName,
      method: desc.method,
      resourceId: desc.resourceId,
      params: desc.params,
      allPages: desc.allPages,
      parallel: config.parallel,
      parallelLimit: config.parallelLimit,
    })
  }

  mutate({ serviceName, method, args }) {
    const updaters = {
      create: item => this.created({ serviceName, item }),
      update: item => this.updated({ serviceName, item }),
      patch: item => this.patched({ serviceName, item }),
      remove: item => this.removed({ serviceName, item }),
    }

    const service = this.service(serviceName)
    return service[method](...args).then(item => {
      updaters[method](item)
    })
  }

  // TODO - unsub!?
  listenToRealtime(queryId) {
    const query = this.getQuery(queryId)
    const { serviceName } = query.desc

    // already listening
    if (this.#realtime.has(serviceName)) return

    const service = this.service(serviceName)
    const created = item => this.created({ serviceName, item })
    const updated = item => this.updated({ serviceName, item })
    const patched = item => this.patched({ serviceName, item })
    const removed = item => this.removed({ serviceName, item })

    service.on('created', created)
    service.on('updated', updated)
    service.on('patched', patched)
    service.on('removed', removed)

    const refetch = () => this.refetchRefetchableQueries()

    service.on('created', refetch)
    service.on('updated', refetch)
    service.on('patched', refetch)
    service.on('removed', refetch)

    this.#realtime.add(serviceName)
  }

  refetchRefetchableQueries() {
    const state = this.getState()
    const queries = getIn(state, ['queries'])
    for (const query of Object.values(queries)) {
      if (query.config.realtime === 'refetch') {
        this.refetch(query.queryId)
      }
    }
  }

  getState() {
    return this.#state
  }

  setState(fn, { silent = false } = {}) {
    const prev = this.#state
    this.#state = fn(this.#state)

    // TODO, loop over this.#state.queries
    // and for each one that changed it's state
    // fire those listeners, all listeners are per query specific

    if (!silent && prev !== this.#state) {
      this.#listeners.forEach(listener => listener(this.#state))
    }

    return this.#state
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

  vacuum(payload) {
    this.setState(curr => this.#computeDestroyed(curr, payload))
  }

  #computeDestroyed(curr, { queryId }) {
    let next = curr

    const query = getIn(curr, ['queries', queryId])
    if (query) {
      // TODO
      // for (const item of query.data) {
      //   next = updateIn(next, ['index', serviceName, this.#idField(item)], index => {
      //     const next = { ...index, queries: { ...index.queries }, size: index.size - 1 }
      //     delete next.queries[queryId]
      //     return next
      //   })
      // }
      next = unsetIn(curr, ['queries', queryId])
    }
    return next
  }

  #computeFetching(curr, { queryId }) {
    let next = curr

    if (getIn(next, ['queries', queryId])) {
      next = setIn(next, ['queries', queryId, 'pending'], false)
      next = updateIn(next, ['queries', queryId, 'state'], state =>
        state.status === 'error'
          ? { ...state, isFetching: true, status: 'loading', error: null }
          : { ...state, isFetching: true },
      )
    }

    return next
  }

  #computeFetched(curr, { queryId, result }) {
    const query = getIn(curr, ['queries', queryId])
    const { serviceName } = query.desc
    const { realtime } = query.config

    let next = curr

    const entities = realtime === 'merge' ? { ...getIn(next, ['entities', serviceName]) } : {}
    const index = realtime === 'merge' ? { ...getIn(next, ['index', serviceName]) } : {}

    let items = []
    let meta = {}
    let data = result

    if (result && query.desc.method === 'find' && typeof result === 'object' && result.data) {
      items = result.data
      data = items
      meta = { ...result }
      delete meta.data
    } else if (Array.isArray(result)) {
      items = result
    } else if (result) {
      items = [result]
    }

    for (const item of items) {
      const itemId = this.getId(item)
      entities[itemId] = item

      if (realtime === 'merge') {
        const itemIndex = { ...index[itemId] }
        itemIndex.queries = { ...itemIndex.queries, [queryId]: true }
        itemIndex.size = itemIndex.size ? itemIndex.size + 1 : 1
        index[itemId] = itemIndex
      }
    }

    if (realtime === 'merge') {
      next = setIn(next, ['entities', serviceName], entities)
      next = setIn(next, ['index', serviceName], index)
    }

    // update queries
    next = setIn(next, ['queries', queryId, 'state'], {
      data,
      ...meta, // TODO, do not spread?
      status: 'success',
      isFetching: false,
      error: null,
    })

    return next
  }

  #computeFetchFailed(curr, { queryId, error }) {
    let next = curr

    next = setIn(next, ['queries', queryId, 'state'], {
      data: null,
      status: 'error',
      isFetching: false,
      error,
    })

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
      const queries = { ...getIn(next, ['queries']) }
      const index = { ...getIn(next, ['index', serviceName, itemId]) }
      index.queries = { ...index.queries }
      index.size = index.size || 0

      let updateCount = 0

      forEachObj(queries, (query, queryId) => {
        let matches

        // do not update non realtime queries
        // those get updated/refetched in a different way
        if (query.config.realtime !== 'merge') {
          return
        }

        if (method === 'remove') {
          // optimisation, if method is remove, we want to immediately remove the object
          // from cache, which means we don't need to match using matcher
          matches = false
        } else if (!query.desc.params.query || Object.keys(query.desc.params.query).length === 0) {
          // another optimisation, if there is no query, the object matches
          matches = true
        } else {
          const match = query.config.matcher ? query.config.matcher(defaultMatcher) : defaultMatcher
          matches = match(query.desc.params.query)(item)
        }

        if (index.queries[queryId]) {
          if (!matches) {
            updateCount++
            next = updateIn(next, ['queries', queryId, 'state'], state => {
              if (query.desc.method === 'get') {
                return { ...state, data: null }
              } else {
                return {
                  ...state,
                  total: state.total - 1,
                  data: state.data.filter(x => this.getId(x) !== itemId),
                }
              }
            })
            delete index.queries[queryId]
            index.size -= 1
          } else {
            updateCount++
            next = updateIn(next, ['queries', queryId, 'state'], state => {
              if (query.desc.method === 'get') {
                return { ...state, data: this.getId(item) === itemId ? item : data }
              } else {
                return {
                  ...state,
                  data: state.data.map(x => (this.getId(x) === itemId ? item : x)),
                }
              }
            })
          }
        } else if (matches) {
          // only add if query has fetched all of the data..
          // if it hasn't too all of the data then leave this
          // up to the consumer of the figbird to decide if data
          // should be refetched
          if (
            query.desc.method === 'find' &&
            query.state.data &&
            query.state.data?.length <= query.state.total
          ) {
            updateCount++
            next = updateIn(next, ['queries', queryId, 'state'], state => {
              return {
                ...state,
                total: state.total + 1,
                data: state.data.concat(item),
              }
            })
            index.queries[queryId] = true
            index.size += 1
          }
        }
      })

      // TODO - merge into above
      if (updateCount > 0) {
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
