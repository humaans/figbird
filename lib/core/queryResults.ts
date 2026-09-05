import { isProjectionQuery } from './queryClassification.js'
import {
  entityKey,
  queryOfParams,
  type EntityKey,
  type Query,
  type ServiceState,
} from './queryTypes.js'

/** Live queries own membership; detached results own their server-returned values. */
export interface QueryRows {
  kind: 'entities' | 'values'
  ids: readonly EntityKey[]
  data: unknown[]
}

/**
 * Commit membership, reverse indexes, and an immutable reader snapshot together.
 * Keep the previous snapshot intact until this boundary: window maintenance needs
 * the row positions from before the event, while readers need stable identities.
 */
export function commitQuery<TMeta>(
  service: ServiceState<TMeta>,
  next: Omit<Query<unknown, TMeta>, 'rows'>,
): void {
  const previous = service.queries.get(next.queryId)
  if (previous?.state === next.state) {
    service.queries.set(next.queryId, { ...next, rows: previous.rows })
    return
  }
  const items =
    next.state.status !== 'success'
      ? []
      : Array.isArray(next.state.data)
        ? next.state.data
        : next.state.data == null
          ? []
          : [next.state.data]
  const ids: EntityKey[] = []
  for (const item of items) {
    const id = service.getId(item)
    if (id !== undefined) ids.push(entityKey(id))
  }
  const ownsValues =
    next.state.status !== 'success' ||
    next.config.realtime === 'disabled' ||
    next.config.fetchPolicy === 'network-only' ||
    isProjectionQuery(queryOfParams(next.desc.params)) ||
    ids.length !== items.length
  const rows: QueryRows = { kind: ownsValues ? 'values' : 'entities', ids, data: items }

  const sameMembership =
    previous?.rows.ids.length === ids.length &&
    ids.every((id, index) => id === previous.rows.ids[index])
  if (sameMembership) {
    rows.ids = previous.rows.ids
  } else {
    const oldIds = new Set(previous?.rows.ids)
    const newIds = new Set(ids)
    for (const id of oldIds) {
      if (newIds.has(id)) continue
      const queries = service.itemQueryIndex.get(id)
      queries?.delete(next.queryId)
      if (queries?.size === 0) service.itemQueryIndex.delete(id)
    }
    for (const id of newIds) {
      if (oldIds.has(id)) continue
      let queries = service.itemQueryIndex.get(id)
      if (!queries) {
        queries = new Set()
        service.itemQueryIndex.set(id, queries)
      }
      queries.add(next.queryId)
    }
  }

  const query = { ...next, rows }
  if (query.state.status === 'success') {
    // Removed entities remain in the previous row position until their event
    // updates membership at this same commit boundary.
    const data =
      rows.kind === 'entities'
        ? rows.ids.map((id, index) => service.entities.get(id) ?? items[index])
        : items
    const previousData = previous?.rows.data
    rows.data =
      previousData &&
      data.length === previousData.length &&
      data.every((item, index) => item === previousData[index])
        ? previousData
        : data
    query.state = {
      ...query.state,
      data: query.desc.method === 'get' ? (rows.data[0] ?? null) : rows.data,
    }
  }
  service.queries.set(next.queryId, query)
}

export function deleteQuery<TMeta>(service: ServiceState<TMeta>, queryId: string): void {
  const query = service.queries.get(queryId)
  if (!query) return
  for (const id of new Set(query.rows.ids)) {
    const queries = service.itemQueryIndex.get(id)
    queries?.delete(queryId)
    if (queries?.size === 0) service.itemQueryIndex.delete(id)
  }
  service.queries.delete(queryId)
}
