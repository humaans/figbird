import { hashObject, getIn, setIn, updateIn, unsetIn } from './helpers'

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

/**
 * A helper to split the properties into a query descriptor `desc` (including 'params')
 * and figbird-specific query configuration `config`
 */
export function splitConfig(combinedConfig) {
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
    itemQueryIndex: {},
    queriesById: {}, // Maps queryId to serviceName
  }

  constructor({ adapter }) {
    this.#adapter = adapter
  }

  #getQuery(queryId) {
    const serviceName = this.#state.queriesById[queryId]
    return serviceName ? getIn(this.getState(), ['queries', serviceName, queryId]) : undefined
  }

  getQueryState(queryId) {
    return this.#getQuery(queryId)?.state
  }

  materialize(queryRef) {
    this.#setState(
      state => {
        const { queryId, desc, config } = queryRef.details()
        const { serviceName } = desc

        if (getIn(state, ['queries', serviceName, queryId])) {
          return state
        } else {
          let next = state
          if (!next.queries[serviceName]) {
            next = setIn(next, ['queries', serviceName], {})
          }
          next = setIn(next, ['queriesById', queryId], serviceName)
          return setIn(next, ['queries', serviceName, queryId], {
            queryId,
            desc,
            config,
            pending: true,
            filterItem: this.#createItemFilter(desc, config),
            state: config.skip
              ? {
                  data: null,
                  status: 'idle',
                  isFetching: false,
                  error: null,
                }
              : {
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

  #createItemFilter(desc, config) {
    const filterItem = this.#adapter.matcher(desc.params?.query)
    return config.matcher ? config.matcher(desc.params?.query, filterItem) : filterItem
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
    for (const [serviceName, serviceQueries] of Object.entries(state.queries)) {
      for (const [queryId, query] of Object.entries(serviceQueries)) {
        if (query.config.realtime === 'refetch') {
          this.refetch(queryId)
        }
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
      for (const [serviceName, serviceQueries] of Object.entries(this.#state.queries)) {
        for (const [queryId, nextQuery] of Object.entries(serviceQueries)) {
          const prevQuery = getIn(prev, ['queries', serviceName, queryId])
          if (prevQuery?.state !== nextQuery.state) {
            this.#invokeListeners(queryId)
          }
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

    const serviceName = next.queriesById[queryId]
    const query = getIn(next, ['queries', serviceName, queryId])

    if (query) {
      if (query.state.data) {
        const items = Array.isArray(query.state.data) ? query.state.data : [query.state.data]
        for (const item of items) {
          next = updateIn(
            next,
            ['itemQueryIndex', serviceName, this.#adapter.getId(item)],
            index => {
              const next = { ...index }
              delete next[queryId]
              return next
            },
          )
        }
      }
      next = unsetIn(next, ['queries', serviceName, queryId])
      next = unsetIn(next, ['queriesById', queryId])
    }

    return next
  }

  #computeFetching(curr, { queryId }) {
    let next = curr
    const serviceName = next.queriesById[queryId]

    if (getIn(next, ['queries', serviceName, queryId])) {
      next = setIn(next, ['queries', serviceName, queryId, 'pending'], false)
      next = updateIn(next, ['queries', serviceName, queryId, 'state'], state =>
        state.status === 'error'
          ? { ...state, isFetching: true, status: 'loading', error: null }
          : { ...state, isFetching: true },
      )
    }

    return next
  }

  #computeFetched(curr, { queryId, result }) {
    const serviceName = curr.queriesById[queryId]
    const query = getIn(curr, ['queries', serviceName, queryId])

    let next = curr

    const { data, meta } = result
    const items = Array.isArray(data) ? data : [data]

    const entities = { ...getIn(next, ['entities', serviceName]) }
    const itemQueryIndex = { ...getIn(next, ['itemQueryIndex', serviceName]) }

    for (const item of items) {
      const itemId = this.#adapter.getId(item)
      entities[itemId] = item
      itemQueryIndex[itemId] = { ...itemQueryIndex[itemId], [queryId]: true }
    }

    next = setIn(next, ['entities', serviceName], entities)
    next = setIn(next, ['itemQueryIndex', serviceName], itemQueryIndex)

    next = setIn(next, ['queries', serviceName, queryId, 'state'], {
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
    const serviceName = next.queriesById[queryId]

    next = setIn(next, ['queries', serviceName, queryId, 'state'], {
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
      next = setIn(next, ['entities', serviceName, itemId], item)
      next = setIn(next, ['itemQueryIndex', serviceName, itemId], {})
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
      const queries = getIn(next, ['queries', serviceName]) || {}
      const itemQueryIndex = { ...getIn(next, ['itemQueryIndex', serviceName, itemId]) }

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

        const hasItem = itemQueryIndex[queryId]

        if (method === 'remove') {
          matches = false
        } else {
          matches = query.filterItem(item)
        }

        if (hasItem) {
          updateCount++
          if (!matches) {
            next = updateIn(next, ['queries', serviceName, queryId, 'state'], state => {
              if (query.desc.method === 'get') {
                return { ...state, data: null }
              } else {
                return {
                  ...state,
                  meta: this.#adapter.itemRemoved(state.meta),
                  data: state.data.filter(x => this.#adapter.getId(x) !== itemId),
                }
              }
            })
            delete itemQueryIndex[queryId]
          } else {
            updateCount++
            next = updateIn(next, ['queries', serviceName, queryId, 'state'], state => {
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
          if (query.desc.method === 'find' && query.state.data) {
            updateCount++
            next = updateIn(next, ['queries', serviceName, queryId, 'state'], state => {
              return {
                ...state,
                meta: this.#adapter.itemAdded(state.meta),
                // TODO, apply $sort if present
                data: state.data.concat(item),
              }
            })
            itemQueryIndex[queryId] = true
          }
        }
      }

      if (updateCount > 0) {
        next = setIn(next, ['itemQueryIndex', serviceName, itemId], itemQueryIndex)
        if (Object.keys(itemQueryIndex).length === 0) {
          next = unsetIn(next, ['entities', serviceName, itemId])
          next = unsetIn(next, ['itemQueryIndex', serviceName, itemId])
        }
      }
    }

    return next
  }
}
