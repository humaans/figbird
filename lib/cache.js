import { useCallback } from 'react'
import { createContext } from 'kinfolk'
import { useFigbird } from './core'
import { getIn, setIn, unsetIn, matcher as defaultMatcher, forEachObj } from './helpers'

export const { Provider, atom, selector, useSelector, useReducer } = createContext()

export const cache = atom(
  {
    entities: {},
    queries: {},
    refs: {},
    index: {},
  },
  { label: 'figbird' },
)

const reducers = {
  fetched,
  created,
  updated,
  patched,
  removed,
}

export function useDispatch() {
  const { config } = useFigbird()
  const { idField, updatedAtField } = config
  const reducer = useCallback(
    (state, payload) => reducers[payload.event](state, payload, { idField, updatedAtField }),
    [idField, updatedAtField],
  )
  return useReducer(cache, reducer)
}

export function useCache(resourceDescriptor) {
  const {
    serviceName,
    queryId,
    method,
    id,
    params,
    realtime,
    selectData,
    transformResponse,
    matcher,
  } = resourceDescriptor

  const dispatch = useDispatch()

  const cachedData = useSelector(() => {
    const query = getIn(cache(), ['queries', serviceName, queryId])
    if (query) {
      const { data } = query
      const entities = query.entities || getIn(cache(), ['entities', serviceName])
      return selectData(data.map(id => entities[id]))
    } else {
      return null
    }
  }, [serviceName, queryId, selectData])

  const cachedResult = useSelector(() => {
    const query = getIn(cache(), ['queries', serviceName, queryId])
    if (query) {
      const { meta } = query
      return { ...meta, data: cachedData }
    } else {
      return { data: null }
    }
  }, [serviceName, queryId, cachedData])

  const updateCache = useCallback(
    data =>
      dispatch({
        event: 'fetched',
        serviceName,
        queryId,
        method,
        params,
        data: {
          ...transformResponse(data),
          ...(id ? { id } : {}),
        },
        realtime,
        matcher,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dispatch, serviceName, queryId, method, realtime, matcher],
  )

  return [cachedResult, updateCache]
}

function fetched(
  curr,
  { serviceName, data, method, params, queryId, realtime, matcher },
  { idField },
) {
  let next = curr

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
    ...(realtime === 'merge' ? {} : { entities }),
  })

  return next
}

function created(state, { serviceName, item }, config) {
  return updateQueries(state, { serviceName, method: 'create', item }, config)
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

function patched(state, payload, config) {
  return updated(state, payload, config)
}

function removed(curr, { serviceName, item: itemOrItems }, { idField, updatedAtField }) {
  const items = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems]

  const exists = items.some(item => getIn(curr, ['entities', serviceName, idField(item)]))
  if (!exists) return curr

  // updating queries updates state, get a fresh copy
  let next = curr
  next = updateQueries(
    next,
    {
      serviceName,
      method: 'remove',
      item: itemOrItems,
    },
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
        if (!matches) {
          updateCount++
          queries[queryId] = {
            ...query,
            meta: { ...query.meta, total: query.meta.total - 1 },
            data: query.data.filter(id => id !== itemId),
          }
          delete index.queries[queryId]
          index.size -= 1
        }
      } else {
        // only add if query has fetched all of the data..
        // if it hasn't fetched all of the data then leave this
        // up to the consumer of the figbird to decide if data
        // should be refetched
        if (matches && query.data.length <= query.meta.total) {
          updateCount++
          // TODO - sort
          queries[queryId] = {
            ...query,
            meta: { ...query.meta, total: query.meta.total + 1 },
            data: query.data.concat(itemId),
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
