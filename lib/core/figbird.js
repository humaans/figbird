import { hashObject } from './hash.js'

/**
    Usage:

    const adapter = new FeathersAdapter({ feathers })
    const figbird = new Figbird({ adapter })

    const q = figbird.query({ serviceName: 'notes', method: 'find' })

    // Execute query and begin listening for realtime updates
    const unsub = q.subscribe(state => console.log(state.status, state.data))

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

  constructor({ adapter, eventBatchProcessingInterval }) {
    this.adapter = adapter
    this.queryStore = new QueryStore({ adapter, eventBatchProcessingInterval })
  }

  getState() {
    return this.queryStore.getState()
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

  #state = new Map()
  #serviceNamesByQueryId = new Map()

  #eventQueue = []
  #eventBatchProcessingTimer = null
  #eventBatchProcessingInterval = 100

  constructor({ adapter, eventBatchProcessingInterval = 100 }) {
    this.#adapter = adapter
    this.#eventBatchProcessingInterval = eventBatchProcessingInterval
  }

  #getQuery(queryId) {
    const serviceName = this.#serviceNamesByQueryId.get(queryId)
    if (serviceName) {
      const service = this.getState().get(serviceName)
      if (service) {
        return service.queries.get(queryId)
      }
    }
  }

  getQueryState(queryId) {
    return this.#getQuery(queryId)?.state
  }

  materialize(queryRef) {
    const { queryId, desc, config } = queryRef.details()

    if (!this.#getQuery(queryId)) {
      this.#serviceNamesByQueryId.set(queryId, desc.serviceName)

      this.#transactOverService(
        queryId,
        service => {
          service.queries.set(queryId, {
            queryId,
            desc,
            config,
            pending: !config.skip,
            dirty: false,
            filterItem: this.#createItemFilter(desc, config),
            state: config.skip
              ? {
                  data: null,
                  meta: {},
                  status: 'idle',
                  isFetching: false,
                  error: null,
                }
              : {
                  data: null,
                  meta: {},
                  status: 'loading',
                  isFetching: true,
                  error: null,
                },
          })
        },
        { silent: true },
      )
    }
  }

  #createItemFilter(desc, config) {
    // if this query is not using the realtime mode
    // we will never be merging events into the cache
    // and will never call the matcher, so to avoid
    // the issue where custom query filters or operators
    // cause the default matcher to throw an error without
    // additional configuration, let's avoid creating a matcher
    // altogether
    if (config.realtime !== 'merge') {
      return () => false
    }

    return config.matcher
      ? config.matcher(desc.params?.query)
      : this.#adapter.matcher(desc.params?.query)
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
    } else {
      // Mark as dirty to refetch after current fetch completes
      this.#transactOverService(
        queryId,
        (service, query) => {
          service.queries.set(queryId, {
            ...query,
            dirty: true,
          })
        },
        { silent: true },
      )
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
      create: item => this.#processEvent(serviceName, { type: 'created', item }),
      update: item => this.#processEvent(serviceName, { type: 'updated', item }),
      patch: item => this.#processEvent(serviceName, { type: 'patched', item }),
      remove: item => this.#processEvent(serviceName, { type: 'removed', item }),
    }

    return this.#adapter.mutate(serviceName, method, args).then(item => {
      updaters[method](item)
      return item
    })
  }

  #subscribeToRealtime(queryId) {
    const query = this.#getQuery(queryId)
    const { serviceName } = query.desc

    // check if already subscribed to the events of this service
    if (this.#realtime.has(serviceName)) {
      return
    }

    const created = item => this.#queueEvent(serviceName, { type: 'created', item })
    const updated = item => this.#queueEvent(serviceName, { type: 'updated', item })
    const patched = item => this.#queueEvent(serviceName, { type: 'patched', item })
    const removed = item => this.#queueEvent(serviceName, { type: 'removed', item })

    const unsub = this.#adapter.subscribe(serviceName, {
      created,
      updated,
      patched,
      removed,
    })
    this.#realtime.add(serviceName)

    return () => {
      this.#realtime.delete(serviceName)
      unsub()
    }
  }

  #processEvent(serviceName, event) {
    this.#eventQueue.push({
      serviceName,
      type: event.type,
      items: Array.isArray(event.item) ? event.item : [event.item],
    })

    this.#processQueuedEvents()
  }

  #queueEvent(serviceName, event) {
    this.#eventQueue.push({
      serviceName,
      type: event.type,
      items: Array.isArray(event.item) ? event.item : [event.item],
    })

    if (!this.#eventBatchProcessingTimer) {
      // process all events in a short interval as a batch later
      if (this.#eventBatchProcessingInterval) {
        this.#eventBatchProcessingTimer = setTimeout(() => {
          this.#processQueuedEvents()
          this.#eventBatchProcessingTimer = null
        }, this.#eventBatchProcessingInterval)
      } else {
        // batching is disabled, process each event immediately
        this.#processQueuedEvents()
      }
    }
  }

  #processQueuedEvents() {
    if (this.#eventQueue.length === 0) {
      return
    }

    // Group events by service
    const eventsByService = {}
    for (const event of this.#eventQueue) {
      eventsByService[event.serviceName] = eventsByService[event.serviceName] || []
      eventsByService[event.serviceName].push(event)
    }

    for (const [serviceName, events] of Object.entries(eventsByService)) {
      this.#transactOverServiceByName(serviceName, (service, touch) => {
        const appliedEvents = []
        for (const event of events) {
          const { type, items } = event
          for (const item of items) {
            if (type === 'created') {
              const itemId = this.#adapter.getId(item)
              service.entities.set(itemId, item)
              appliedEvents.push(event)
            } else if (type === 'updated' || type === 'patched') {
              const itemId = this.#adapter.getId(item)
              const currItem = service.entities.get(itemId)
              if (!currItem || !this.#adapter.isItemStale(currItem, item)) {
                service.entities.set(itemId, item)
                appliedEvents.push(event)
              }
            } else if (type === 'removed') {
              const itemId = this.#adapter.getId(item)
              service.entities.delete(itemId)
              appliedEvents.push(event)
            }
          }
        }

        // Update queries only for non-stale items
        if (appliedEvents.length > 0) {
          this.#updateQueriesFromEvents(service, appliedEvents, touch)
        }
      })

      // Refetch refetchable queries if needed
      this.#refetchRefetchableQueries(serviceName)
    }

    this.#eventQueue = []
  }

  #updateQueriesFromEvents(service, appliedEvents, touch) {
    for (const { type, items } of appliedEvents) {
      for (const item of items) {
        const itemId = this.#adapter.getId(item)

        if (!service.itemQueryIndex.has(itemId)) {
          service.itemQueryIndex.set(itemId, new Set())
        }
        const itemQueryIndex = service.itemQueryIndex.get(itemId)

        for (const [queryId, query] of service.queries) {
          let matches

          if (query.config.realtime !== 'merge') {
            continue
          }

          if (type === 'find' && query.config.fetchPolicy === 'network-only') {
            continue
          }

          if (type === 'removed') {
            matches = false
          } else {
            matches = query.filterItem(item)
          }

          const hasItem = itemQueryIndex.has(queryId)
          if (hasItem && !matches) {
            // remove
            const query = service.queries.get(queryId)
            service.queries.set(queryId, {
              ...query,
              state: {
                ...query.state,
                meta: this.#adapter.itemRemoved(query.state.meta),
                data:
                  query.desc.method === 'get'
                    ? null
                    : query.state.data.filter(x => this.#adapter.getId(x) !== itemId),
              },
            })
            itemQueryIndex.delete(queryId)
            touch(queryId)
          } else if (hasItem && matches) {
            // update
            service.queries.set(queryId, {
              ...query,
              state: {
                ...query.state,
                data:
                  query.desc.method === 'get'
                    ? item
                    : query.state.data.map(x => (this.#adapter.getId(x) === itemId ? item : x)),
              },
            })
            touch(queryId)
          } else if (matches && query.desc.method === 'find' && query.state.data) {
            service.queries.set(queryId, {
              ...query,
              state: {
                ...query.state,
                meta: this.#adapter.itemAdded(query.state.meta),
                data: query.state.data.concat(item),
              },
            })
            itemQueryIndex.add(queryId)
            touch(queryId)
          }
        }
      }
    }
  }

  #refetchRefetchableQueries(serviceName) {
    const service = this.getState().get(serviceName)
    for (const query of service.queries.values()) {
      if (query.config.realtime === 'refetch' && this.#listenerCount(query.queryId) > 0) {
        this.refetch(query.queryId)
      }
    }
  }

  getState() {
    return this.#state
  }

  #updateState(mutate, { silent = false } = {}) {
    const modifiedQueries = new Set()

    // Modify fn to track changes
    const touch = queryId => modifiedQueries.add(queryId)

    mutate(this.#state, touch)

    if (!silent && modifiedQueries.size > 0) {
      for (const queryId of modifiedQueries) {
        this.#invokeListeners(queryId)
      }
      this.#invokeGlobalListeners()
    }
  }

  #transactOverService(queryId, fn, options) {
    const serviceName = this.#serviceNamesByQueryId.get(queryId)
    this.#transactOverServiceByName(
      serviceName,
      (service, touch) => {
        fn(service, service.queries.get(queryId), touch)
        touch(queryId)
      },
      options,
    )
  }

  #transactOverServiceByName(serviceName, fn, { silent = false } = {}) {
    if (serviceName) {
      // initialise the service structure if needed
      if (!this.getState().get(serviceName)) {
        this.getState().set(serviceName, {
          entities: new Map(),
          queries: new Map(),
          itemQueryIndex: new Map(),
        })
      }

      this.#updateState(
        (state, touch) => {
          fn(state.get(serviceName), touch)
        },
        { silent },
      )
    }
  }

  #fetching({ queryId }) {
    this.#transactOverService(queryId, (service, query) => {
      service.queries.set(queryId, {
        ...query,
        pending: false,
        dirty: false,
        state:
          query.state.status === 'error'
            ? { ...query.state, isFetching: true, status: 'loading', error: null }
            : { ...query.state, isFetching: true },
      })
    })
  }

  #fetched({ queryId, result }) {
    let shouldRefetch = false

    this.#transactOverService(queryId, (service, query) => {
      const { data, meta } = result
      const items = Array.isArray(data) ? data : [data]

      for (const item of items) {
        const itemId = this.#adapter.getId(item)
        service.entities.set(itemId, item)
        if (!service.itemQueryIndex.has(itemId)) {
          service.itemQueryIndex.set(itemId, new Set())
        }
        service.itemQueryIndex.get(itemId).add(queryId)
      }

      shouldRefetch = query.dirty

      service.queries.set(queryId, {
        ...query,
        state: {
          data,
          meta,
          status: 'success',
          isFetching: false,
          error: null,
        },
      })
    })

    if (shouldRefetch && this.#listenerCount(queryId) > 0) {
      this.#queue(queryId)
    }
  }

  #fetchFailed({ queryId, error }) {
    let shouldRefetch = false

    this.#transactOverService(queryId, (service, query) => {
      shouldRefetch = query.dirty

      service.queries.set(queryId, {
        ...query,
        state: {
          data: null,
          meta: {},
          status: 'error',
          isFetching: false,
          error,
        },
      })
    })

    if (shouldRefetch && this.#listenerCount(queryId) > 0) {
      this.#queue(queryId)
    }
  }

  #vacuum({ queryId }) {
    this.#transactOverService(
      queryId,
      (service, query) => {
        if (query) {
          if (query.state.data) {
            for (const item of getItems(query)) {
              const id = this.#adapter.getId(item)
              if (service.itemQueryIndex.has(id)) {
                service.itemQueryIndex.get(id).delete(queryId)
              }
            }
          }
          service.queries.delete(queryId)
          this.#serviceNamesByQueryId.delete(queryId)
        }
      },
      { silent: true },
    )
  }
}

function getItems(query) {
  return Array.isArray(query.state.data) ? query.state.data : [query.state.data]
}
