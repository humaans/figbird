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

  constructor() {
    // TODO!?
    this.config = {
      idField: defaultIdField,
      updatedAtField: defaultUpdatedAtField,
    }
  }

  get() {
    return this.#state
  }

  set(fn) {
    this.#state = fn(this.#state)
    this.#listeners.forEach(listener => listener(this.#state))
  }

  subscribe(fn) {
    this.#listeners.add(fn)
    return () => {
      this.#listeners.delete(fn)
    }
  }

  fetching(payload) {
    const { config } = this
    this.set(curr => fetching(curr, payload, config))
  }

  fetched(payload) {
    const { config } = this
    this.set(curr => fetched(curr, payload, config))
  }

  fetchFailed(payload) {
    const { config } = this
    this.set(curr => fetchFailed(curr, payload, config))
  }

  created(payload) {
    const { config } = this
    this.set(curr => created(curr, payload, config))
  }

  updated(payload) {
    const { config } = this
    this.set(curr => updated(curr, payload, config))
  }

  patched(payload) {
    const { config } = this
    this.set(curr => patched(curr, payload, config))
  }

  removed(payload) {
    const { config } = this
    this.set(curr => removed(curr, payload, config))
  }
}

function fetching(
  curr,
  { serviceName, data, method, params, queryId, realtime, matcher },
  { idField },
) {
  let next = curr

  // existing query being refetched!
  if (getIn(next, ['queries', serviceName, queryId])) {
    next = updateIn(next, ['queries', serviceName, queryId], query =>
      query.status === 'error'
        ? {
            ...nextQuery,
            status: 'loading',
            error: null,
            fetching: true,
          }
        : {
            ...nextQuery,
            fetching: true,
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
      matcher,
      status: 'loading',
      fetching: true,
      error: null,
    })

    // update queryId index
    if (getIn(next, ['lookups', 'serviceNamesByQueryId', queryId]) !== serviceName) {
      next = setIn(next, ['lookups', 'serviceNamesByQueryId', queryId], serviceName)
    }
  }

  return next
}

function fetched(
  curr,
  { serviceName, data, method, params, queryId, realtime, matcher },
  { idField },
) {
  // we already inserted this response to cache
  const prevData = getIn(curr, ['queries', serviceName, queryId, 'res'])
  if (prevData === data) {
    return curr
  }

  let next = curr

  next = unsetIn(next, ['queries', serviceName, queryId, 'error'])

  const { data: items, ...meta } = data
  const entities = realtime === 'merge' ? { ...getIn(next, ['entities', serviceName]) } : {}
  const index = realtime === 'merge' ? { ...getIn(next, ['index', serviceName]) } : {}
  for (const item of items) {
    const itemId = idField(item)
    entities[itemId] = item

    if (realtime === 'merge') {
      const itemIndex = { ...index[itemId] }
      itemIndex.queries = { ...itemIndex.queries, [queryId]: true }
      itemIndex.size = itemIndex.size ? itemIndex.size + 1 : 1
      index[itemId] = itemIndex
    }
  }

  if (realtime === 'merge') {
    // update entities
    next = setIn(next, ['entities', serviceName], entities)
    next = setIn(next, ['index', serviceName], index)
  }

  // update queries
  next = setIn(next, ['queries', serviceName, queryId], {
    params,
    data: items.map(x => idField(x)),
    meta,
    method,
    realtime,
    matcher,
    res: data,
    status: 'success',
    fetching: false,
    ...(realtime === 'merge' ? {} : { entities }),
  })

  // update queryId index
  if (getIn(next, ['lookups', 'serviceNamesByQueryId', queryId]) !== serviceName) {
    next = setIn(next, ['lookups', 'serviceNamesByQueryId', queryId], serviceName)
  }

  return next
}

function fetchFailed(curr, { queryId, serviceName, error }) {
  let next = curr

  next = mergeIn(next, ['queries', serviceName, queryId], {
    data: null,
    meta: {},
    res: null,
    status: 'error',
    fetching: false,
    error,
  })

  // update queryId index
  if (getIn(next, ['lookups', 'serviceNamesByQueryId', queryId]) !== serviceName) {
    next = setIn(next, ['lookups', 'serviceNamesByQueryId', queryId], serviceName)
  }

  return next
}

function created(curr, { serviceName, item }, config) {
  return updateQueries(curr, { serviceName, method: 'create', item }, config)
}

function updated(curr, { serviceName, item }, { idField, updatedAtField }) {
  const itemId = idField(item)

  const currItem = getIn(curr, ['entities', serviceName, itemId])

  // check to see if we should discard this update
  if (currItem) {
    const currUpdatedAt = updatedAtField(currItem)
    const nextUpdatedAt = updatedAtField(item)
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

  return updateQueries(next, { serviceName, method: 'update', item }, { idField, updatedAtField })
}

function patched(curr, payload, config) {
  return updated(curr, payload, config)
}

function removed(curr, { serviceName, item: itemOrItems }, { idField, updatedAtField }) {
  const items = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems]

  const exists = items.some(item => getIn(curr, ['entities', serviceName, idField(item)]))
  if (!exists) return curr

  // updating queries updates state, get a fresh copy
  let next = curr
  next = updateQueries(
    next,
    { serviceName, method: 'remove', item: itemOrItems },
    { idField, updatedAtField },
  )

  // now remove it from entities
  const serviceEntities = { ...getIn(next, ['entities', serviceName]) }
  const removedIds = []
  for (const item of items) {
    delete serviceEntities[idField(item)]
    next = setIn(next, ['entities', serviceName], serviceEntities)
    removedIds.push(idField(item))
  }
  return next
}

function updateQueries(
  curr,
  { serviceName, method, item: itemOrItems },
  { idField, updatedAtField },
) {
  const items = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems]
  let next = curr

  for (const item of items) {
    const itemId = idField(item)
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
        if (!matches && query.data.includes(itemId)) {
          updateCount++
          queries[queryId] = {
            ...query,
            data: query.data.filter(id => id !== itemId),
          }
          if (typeof query.meta.total === 'number' && query.meta.total >= 0) {
            query.meta = { ...query.meta }
            query.meta.total = Math.max(query.meta.total - 1, 0)
          }
          delete index.queries[queryId]
          index.size -= 1
        }
      } else {
        if (matches && !query.data.includes(itemId)) {
          updateCount++
          // TODO - sort
          queries[queryId] = {
            ...query,
            data: query.data.concat(itemId),
          }
          if (typeof query.meta.total === 'number' && query.meta.total >= 0) {
            query.meta = { ...query.meta }
            query.meta.total = Math.max(query.meta.total + 1, 0)
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
