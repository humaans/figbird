import { useMemo } from 'react'
import {
  createAtom,
  createContext as createAtomContext,
  createHooks as createAtomHooks,
} from 'tiny-atom'
import { namespace } from './namespace'
import { getIn, setIn, unsetIn, matcher, forEachObj } from './helpers'

const initialState = () => ({
  [namespace]: {
    entities: {},
    queries: {},
    refs: {},
    index: {},
  },
})

const actions = ({ idField, updatedAtField }) => ({
  feathersFetched: fetched(idField, updatedAtField),
  feathersCreated: created(idField, updatedAtField),
  feathersUpdated: updated(idField, updatedAtField),
  feathersPatched: updated(idField, updatedAtField),
  feathersRemoved: removed(idField, updatedAtField),
  feathersUpdateQueries: updateQuery(idField, updatedAtField),
})

function fetched(idField, updatedAtField) {
  return (
    { get, set, actions },
    { serviceName, data, method, params, queryId, realtime, additionalFilters, additionalOperators }
  ) => {
    const curr = getIn(get(), [namespace])
    let next = curr

    const { data: items, ...meta } = data
    const entities = realtime === 'merge' ? { ...getIn(curr, ['entities', serviceName]) } : {}
    const index = realtime === 'merge' ? { ...getIn(curr, ['index', serviceName]) } : {}
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
      additionalFilters,
      additionalOperators,
      ...(realtime === 'merge' ? {} : { entities }),
    })

    const l = items.length
    const msg = `${serviceName} ${l} item${l === 1 ? '' : 's'}`
    set({ [namespace]: next }, msg)
  }
}

function created(idField, updatedAtField) {
  return ({ get, set, actions }, { serviceName, item }) => {
    actions.feathersUpdateQueries({ serviceName, method: 'create', item })
  }
}

// applies to both update and patch
function updated(idField, updatedAtField) {
  return ({ get, set, actions }, { serviceName, item }) => {
    const itemId = idField(item)
    const curr = getIn(get(), [namespace])

    const currItem = getIn(curr, ['entities', serviceName, itemId])

    // check 1 to see if we should discard this update
    if (!currItem) {
      return
    }

    // check 2 to see if we should discard this update
    const currUpdatedAt = updatedAtField(currItem)
    const nextUpdatedAt = updatedAtField(item)
    if (nextUpdatedAt && nextUpdatedAt < currUpdatedAt) {
      return
    }

    const next = setIn(curr, ['entities', serviceName, itemId], item)
    const msg = `${serviceName} ${itemId}`
    set({ [namespace]: next }, msg)

    actions.feathersUpdateQueries({ serviceName, method: 'update', item })
  }
}

function removed(idField) {
  return ({ get, set, actions }, { serviceName, item }) => {
    let curr = getIn(get(), [namespace])

    const currItem = getIn(curr, ['entities', serviceName, idField(item)])

    if (!currItem) {
      return
    }

    // remove this item from all the queries that reference it
    actions.feathersUpdateQueries({ serviceName, method: 'remove', item })

    // updating queries updates state, get a fresh copy
    curr = getIn(get(), [namespace])

    // now remove it from entities
    const serviceEntities = { ...getIn(curr, ['entities', serviceName]) }
    delete serviceEntities[idField(item)]
    const next = setIn(curr, ['entities', serviceName], serviceEntities)
    const msg = `removed ${serviceName} ${idField(item)}`
    set({ [namespace]: next }, msg)
  }
}

// TODO - consider splitting into each updater method
function updateQuery(idField, updatedAtField) {
  return function feathersUpdateQueries({ get, set }, { serviceName, method, item }) {
    const itemId = idField(item)
    const curr = getIn(get(), [namespace])
    const queries = { ...getIn(curr, ['queries', serviceName]) }
    const index = { ...getIn(curr, ['index', serviceName, itemId]) }
    index.queries = { ...index.queries }

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
        matches = matcher(query.params.query, {
          filters: query.additionalFilters,
          operators: query.additionalOperators,
        })(item)
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
      let next = curr

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
      }

      const msg = `updated ${updateCount} ${updateCount === 1 ? 'query' : 'queries'}`
      set({ [namespace]: next }, msg)
    }
  }
}

export const useCacheInstance = (atom, config) => {
  return useMemo(() => {
    atom = atom || createAtom()

    // Create an atom context and a set of hooks separate from the
    // main context used in tiny-atom. This way our store and actions
    // and everything do not interfere with the main atom. Use this
    // secondary context even if we use an existing atom – there is no
    // issue with that.
    const { AtomContext, Provider: AtomProvider } = createAtomContext()
    const { useSelector } = createAtomHooks(AtomContext)

    // configure atom with initial state and figbird actions
    atom.fuse({ state: initialState(), actions: actions(config) })

    return { atom, AtomProvider, useSelector }
  }, [])
}
