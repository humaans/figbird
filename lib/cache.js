import { useMemo } from 'react'
import {
  createAtom,
  createContext as createAtomContext,
  createHooks as createAtomHooks,
} from 'tiny-atom'
import { namespace } from './namespace'
import { getIn, setIn, matcher, forEachObj } from './helpers'

const updater = method => {
  return (
    { get, set, actions },
    { serviceName, entity, data, params, paramsHash },
  ) => {
    const curr = getIn(get(), [namespace])
    let next = curr

    // case: get or one of the realtime events
    if (entity) {
      next = setIn(curr, ['entities', serviceName, entity.id], entity)
      const msg = `${serviceName} ${entity.id}`
      set({ [namespace]: next }, msg)
    }

    // case: find
    if (data) {
      const { data: items, ...meta } = data
      const entities = { ...getIn(curr, ['entities', serviceName]) }
      for (const entity of items) {
        entities[entity.id] = entity
      }

      // update entities
      next = setIn(next, ['entities', serviceName], entities)

      // update queries
      next = setIn(next, ['queries', serviceName, paramsHash], {
        params,
        data: items.map(x => x.id),
        meta,
      })

      const l = items.length
      const msg = `${serviceName} ${l} item${l === 1 ? '' : 's'}`
      set({ [namespace]: next }, msg)
    }

    // finally, if an item has been created or modifed
    // check if it should be added or removed from any existing queries
    if (method === 'create' || method === 'update' || method === 'patch') {
      actions.feathersUpdateQueries({ serviceName, entity })
    }
  }
}

const initialState = () => ({ [namespace]: {} })

const actions = {
  feathersFetched: updater('fetch'),

  feathersCreated: updater('create'),

  feathersUpdated: updater('update'),

  feathersPatched: updater('patch'),

  feathersRemoved({ get, set, actions }, { serviceName, entity }) {
    let curr = getIn(get(), [namespace])

    if (getIn(curr, ['entities', serviceName, entity.id])) {
      // remove this entity from all the queries that reference it
      actions.feathersUpdateQueries({ serviceName, entity, method: 'remove' })

      // updating queries mutated state, get a fresh copy
      curr = getIn(get(), [namespace])

      let next = curr

      // now visit all entities and remove them
      const serviceEntities = { ...getIn(curr, ['entities', serviceName]) }
      delete serviceEntities[entity.id]
      next = setIn(next, ['entities', serviceName], serviceEntities)
      const msg = `removed ${serviceName} ${entity.id}`
      set({ [namespace]: next }, msg)
    }
  },

  feathersUpdateQueries({ get, set }, { serviceName, entity, method }) {
    const curr = getIn(get(), [namespace])
    const queries = { ...getIn(curr, ['queries', serviceName]) }

    let updateCount = 0

    forEachObj(queries, (query, key) => {
      // optimisation, if method is remove, we want to force remove the object
      // from cache, which means we don't need to match using matcher
      const matches =
        method === 'remove' ? false : matcher(query.params.query)(entity)

      if (query.data.includes(entity.id)) {
        if (!matches) {
          updateCount++
          queries[key] = {
            ...query,
            meta: { ...query.meta, total: query.meta.total - 1 },
            data: query.data.filter(id => id !== entity.id),
          }
        }
      } else {
        // only add if query has fetched all of the data..
        // if it hasn't fetched all of the data then leave this
        // up to the consumer of the figbird to decide if data
        // should be refetched
        if (matches && query.data.length <= query.meta.total) {
          updateCount++
          // TODO - sort
          queries[key] = {
            ...query,
            meta: { ...query.meta, total: query.meta.total + 1 },
            data: query.data.concat(entity.id),
          }
        }
      }
    })

    if (updateCount > 0) {
      const c = updateCount
      const next = setIn(curr, ['queries', serviceName], queries)
      const msg = `updated ${c} ${c === 1 ? 'query' : 'queries'}`
      set({ [namespace]: next }, msg)
    }
  },

  feathersListening({ get, set }, { serviceName, listening }) {
    const curr = getIn(get(), [namespace])
    const next = setIn(curr, ['meta', serviceName, 'listening'], listening)
    const msg = `${serviceName} ${
      listening ? 'listening' : 'stopped listening'
    }`
    set({ [namespace]: next }, msg)
  },
}

export const useCacheInstance = atom => {
  return useMemo(() => {
    atom = atom || createAtom()

    // Create an atom context and a set of hooks separate from the
    // main context used in tiny-atom. This way our store and actions
    // and everything do not interfere with the main atom. Use this
    // secondary context even if we use an existing atom – there is no
    // issue with that.
    const { AtomContext, Provider: AtomProvider } = createAtomContext()
    const { useSelector } = createAtomHooks(AtomContext)

    // configur atom with initial state and figbird actions
    atom.fuse({ state: initialState(), actions })

    return { atom, AtomProvider, useSelector }
  }, [])
}
