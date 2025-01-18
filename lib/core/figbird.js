import { hashObject, getIn, setIn, updateIn, unsetIn } from './helpers'

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
    params,
  }

  // figbird specific config options that
  // drive the query lifecycle
  let config = {
    skip,
    realtime,
    fetchPolicy,
    allPages,
    matcher,
  }

  return { desc, config }
}

// a lightweight query reference object to make it easy
// subscribe to state changes and read query data
// this is only a ref and does not contain state itself, it instead
// references all the state from the shared figbird query state
class QueryRef {
  #queryId
  #desc
  #config
  #queryStore

  constructor({ desc, config, queryStore }) {
    this.#queryId = `q/${hashObject({ desc, config })}`
    this.#desc = desc
    this.#config = config
    this.#queryStore = queryStore
  }

  details() {
    return {
      queryId: this.#queryId,
      desc: this.#desc,
      config: this.#config,
    }
  }

  hash() {
    return this.#queryId
  }

  subscribe(fn) {
    this.#queryStore.materialize(this)
    return this.#queryStore.subscribe(this.#queryId, fn)
  }

  getSnapshot() {
    this.#queryStore.materialize(this)
    return this.#queryStore.getQueryState(this.#queryId)
  }

  refetch() {
    this.#queryStore.materialize(this)
    return this.#queryStore.refetch(this.#queryId)
  }
}

class QueryStore {
  #adapter = null

  #realtime = new Set()
  #listeners = new Map()
  #globalListeners = new Set()

  #state = {
    entities: {},
    queries: {},
    index: {},
  }

  constructor({ adapter }) {
    this.#adapter = adapter
  }

  #getQuery(queryId) {
    return getIn(this.getState(), ['queries', queryId])
  }

  getQueryState(queryId) {
    return this.#getQuery(queryId)?.state
  }

  materialize(queryRef) {
    this.#setState(
      state => {
        const { queryId, desc, config } = queryRef.details()
        if (getIn(state, ['queries', queryId])) {
          return state
        } else {
          return setIn(state, ['queries', queryId], {
            queryId,
            desc,
            config,
            pending: true,
            // TODO: simplify
            filterItem: config.matcher
              ? config.matcher(q => this.#adapter.matcher(q))(desc.params?.query)
              : this.#adapter.matcher(desc.params?.query),
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

  #addListener(queryId, fn) {
    if (!this.#listeners.has(queryId)) {
      this.#listeners.set(queryId, new Set())
    }
    this.#listeners.get(queryId).add(fn)
    return () => {
      const listeners = this.#listeners.get(queryId)
      if (listeners) {
        listeners.delete(fn)
        if (listeners.size === 0) {
          this.#listeners.delete(queryId)
        }
      }
    }
  }

  #invokeListeners(queryId) {
    const listeners = this.#listeners.get(queryId)
    if (listeners) {
      const state = this.getQueryState(queryId)
      listeners.forEach(listener => listener(state))
    }
  }

  #addGlobalListener(fn) {
    this.#globalListeners.add(fn)
    return () => {
      this.#globalListeners.delete(fn)
    }
  }

  #invokeGlobalListeners() {
    const state = this.getState()
    this.#globalListeners.forEach(listener => listener(state))
  }

  #listenerCount(queryId) {
    return this.#listeners.get(queryId)?.size || 0
  }

  subscribe(queryId, fn) {
    const q = this.#getQuery(queryId)
    if (
      q.pending ||
      (q.state.status === 'success' && q.config.fetchPolicy === 'swr' && !q.state.isFetching) ||
      (q.state.status === 'error' && !q.state.isFetching)
    ) {
      this.#queue(queryId)
    }

    const removeListener = this.#addListener(queryId, fn)

    this.#subscribeToRealtime(queryId)

    const shouldVacuumByDefault = q.config.fetchPolicy === 'network-only'
    return ({ vacuum = shouldVacuumByDefault } = {}) => {
      removeListener()
      if (vacuum && this.#listenerCount(queryId) === 0) {
        this.#vacuum({ queryId })
      }
    }
  }

  subscribeToStateChanges(fn) {
    return this.#addGlobalListener(fn)
  }

  refetch(queryId) {
    const q = this.#getQuery(queryId)
    if (!q.state.isFetching) {
      this.#queue(queryId)
    }
  }

  async #queue(queryId) {
    this.#fetching({ queryId })
    try {
      const result = await this.#fetch(queryId)
      this.#fetched({ queryId, result })
    } catch (err) {
      this.#fetchFailed({ queryId, error: err })
    }
  }

  #fetch(queryId) {
    const query = this.#getQuery(queryId)
    const { serviceName, method, resourceId, params } = query.desc
    const { allPages } = query.config

    if (method === 'get') {
      return this.#adapter.get(serviceName, resourceId, params)
    } else if (allPages) {
      return this.#adapter.findAll(serviceName, params)
    } else {
      return this.#adapter.find(serviceName, params)
    }
  }

  mutate({ serviceName, method, args }) {
    const updaters = {
      create: item => this.#created({ serviceName, item }),
      update: item => this.#updated({ serviceName, item }),
      patch: item => this.#patched({ serviceName, item }),
      remove: item => this.#removed({ serviceName, item }),
    }

    return this.#adapter.mutate(serviceName, method, args).then(item => {
      updaters[method](item)
    })
  }

  #subscribeToRealtime(queryId) {
    const query = this.#getQuery(queryId)
    const { serviceName } = query.desc

    if (this.#realtime.has(serviceName)) {
      return
    }

    const created = item => {
      this.#created({ serviceName, item })
      this.#refetchRefetchableQueries()
    }
    const updated = item => {
      this.#updated({ serviceName, item })
      this.#refetchRefetchableQueries()
    }
    const patched = item => {
      this.#patched({ serviceName, item })
      this.#refetchRefetchableQueries()
    }
    const removed = item => {
      this.#removed({ serviceName, item })
      this.#refetchRefetchableQueries()
    }

    const unsub = this.#adapter.subscribe(serviceName, {
      created,
      updated,
      patched,
      removed,
    })

    this.#realtime.add(serviceName)

    return () => {
      unsub()
      this.#realtime.delete(serviceName)
    }
  }

  #refetchRefetchableQueries() {
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

  #setState(fn, { silent = false } = {}) {
    const prev = this.#state
    this.#state = fn(this.#state)

    if (!silent && prev !== this.#state) {
      const prevQueries = prev.queries
      const nextQueries = this.#state.queries

      for (const [queryId, nextQuery] of Object.entries(nextQueries)) {
        const prevQuery = prevQueries[queryId]
        if (prevQuery?.state !== nextQuery.state) {
          this.#invokeListeners(queryId)
        }
      }

      this.#invokeGlobalListeners()
    }

    return this.#state
  }

  #fetching(payload) {
    this.#setState(curr => this.#computeFetching(curr, payload))
  }

  #fetched(payload) {
    this.#setState(curr => this.#computeFetched(curr, payload))
  }

  #fetchFailed(payload) {
    this.#setState(curr => this.#computeFetchFailed(curr, payload))
  }

  #created(payload) {
    this.#setState(curr => this.#computeCreated(curr, payload))
  }

  #updated(payload) {
    this.#setState(curr => this.#computeUpdated(curr, payload))
  }

  #patched(payload) {
    this.#setState(curr => this.#computePatched(curr, payload))
  }

  #removed(payload) {
    this.#setState(curr => this.#computeRemoved(curr, payload))
  }

  #vacuum(payload) {
    this.#setState(curr => this.#computeVacuum(curr, payload))
  }

  #computeVacuum(curr, { queryId }) {
    let next = curr

    const query = getIn(next, ['queries', queryId])
    if (query) {
      if (query.state.data) {
        const items = Array.isArray(query.state.data) ? query.state.data : [query.state.data]
        for (const item of items) {
          next = updateIn(
            next,
            ['index', query.desc.serviceName, this.#adapter.getId(item)],
            index => {
              const next = { ...index, queries: { ...index.queries }, size: index.size - 1 }
              delete next.queries[queryId]
              return next
            },
          )
        }
      }
      next = unsetIn(next, ['queries', queryId])
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

    const { data, meta } = result
    const items = Array.isArray(data) ? data : [data]

    for (const item of items) {
      const itemId = this.#adapter.getId(item)
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

    next = setIn(next, ['queries', queryId, 'state'], {
      data,
      meta,
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
    const itemId = this.#adapter.getId(item)

    const currItem = getIn(curr, ['entities', serviceName, itemId])

    // check to see if we should discard this update
    if (currItem && this.#adapter.isItemStale(currItem, item)) {
      return curr
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

    const exists = items.some(item =>
      getIn(curr, ['entities', serviceName, this.#adapter.getId(item)]),
    )
    if (!exists) return curr

    let next = curr
    next = this.#updateQueries(next, { serviceName, method: 'remove', item: itemOrItems })

    const serviceEntities = { ...getIn(next, ['entities', serviceName]) }
    for (const item of items) {
      delete serviceEntities[this.#adapter.getId(item)]
      next = setIn(next, ['entities', serviceName], serviceEntities)
    }
    return next
  }

  #updateQueries(curr, { serviceName, method, item: itemOrItems }) {
    const items = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems]
    let next = curr

    for (const item of items) {
      const itemId = this.#adapter.getId(item)
      const queries = getIn(next, ['queries'])
      const index = { ...getIn(next, ['index', serviceName, itemId]) }
      index.queries = { ...index.queries }
      index.size = index.size || 0

      next = setIn(next, ['entities', serviceName, itemId], item)

      let updateCount = 0

      for (const [queryId, query] of Object.entries(queries)) {
        let matches

        if (query.config.realtime !== 'merge') {
          break
        }

        if (method === 'find' && query.config.fetchPolicy === 'network-only') {
          break
        }

        if (query.desc.serviceName !== serviceName) {
          break
        }

        const hasItem = index.queries[queryId]

        if (method === 'remove') {
          matches = false
        } else {
          matches = query.filterItem(item)
        }

        if (hasItem) {
          updateCount++
          if (!matches) {
            next = updateIn(next, ['queries', queryId, 'state'], state => {
              if (query.desc.method === 'get') {
                return { ...state, data: null }
              } else {
                return {
                  ...state,
                  meta: { ...state.meta, total: state.meta.total - 1 },
                  data: state.data.filter(x => this.#adapter.getId(x) !== itemId),
                }
              }
            })
            delete index.queries[queryId]
            index.size -= 1
          } else {
            updateCount++
            next = updateIn(next, ['queries', queryId, 'state'], state => {
              if (query.desc.method === 'get') {
                return { ...state, data: item }
              } else {
                return {
                  ...state,
                  data: state.data.map(x => (this.#adapter.getId(x) === itemId ? item : x)),
                }
              }
            })
          }
        } else if (matches) {
          if (
            query.desc.method === 'find' &&
            query.state.data &&
            // TODO - check if isPaginationComplete
            query.state.data?.length <= query.state.meta.total
          ) {
            updateCount++
            next = updateIn(next, ['queries', queryId, 'state'], state => {
              return {
                ...state,
                meta: { ...state.meta, total: state.meta.total + 1 },
                data: state.data.concat(item),
              }
            })
            index.queries[queryId] = true
            index.size += 1
          }
        }
      }

      if (updateCount > 0) {
        next = setIn(next, ['index', serviceName, itemId], index)

        if (index.size === 0) {
          next = unsetIn(next, ['entities', serviceName, itemId])
          next = unsetIn(next, ['index', serviceName, itemId])
        }
      }
    }

    return next
  }
}

/**

Usage:

const adapter = new FeathersAdapter({ feathers })
const figbird = new Figbird({ adapter })

const q = figbird.query({ serviceName: 'notes', method: 'find' })

// Execute query and begin listening for realtime updates
const unsub = q.subscribe(state => console(state.status, state.data))

// Get current query state synchronously
q.getSnapshot()

// Stop listening to updates while preserving the query state and data in cache.
// The query state can be recovered by creating a new query with the same parameters.
// Multiple queries can safely reference the same cached state.
unsub()

*/
export class Figbird {
  adapter = null
  queryStore = null

  constructor({ adapter }) {
    this.adapter = adapter
    this.queryStore = new QueryStore({ adapter })
  }

  getState() {
    return this.queryStore.getState()
  }

  getQueryState(queryRef) {
    return this.queryStore.getQuery(queryRef.hash())
  }

  query(desc, config) {
    return new QueryRef({ desc, config, queryStore: this.queryStore })
  }

  mutate({ serviceName, method, args }) {
    return this.queryStore.mutate({ serviceName, method, args })
  }

  subscribeToStateChanges(fn) {
    return this.queryStore.subscribeToStateChanges(fn)
  }
}
