import { servedLimit } from '../adapters/queryPage.js'
import { maintainWindow } from './windowDecision.js'
import { sameValue } from './valueEquality.js'
import { commitQuery } from './queryResults.js'
/** Apply entity changes and window decisions to queries before publishing effects. */

import { queryPolicy } from './queryMaintenance.js'
import { isServerMaintained } from './queryClassification.js'
import { ItemRemovedError } from './errors.js'
import {
  entityKey,
  type EntityKey,
  type ItemId,
  queryOfParams,
  type ProcessedCacheEvent,
  type Query,
  type QueryState,
  type QueuedEvent,
  type ServiceState,
} from './queryTypes.js'

export type QueryMembershipScope = 'all-matching' | 'visible-only'

export function createServiceState<TMeta = Record<string, unknown>>(
  getId: (item: unknown) => ItemId | undefined,
): ServiceState<TMeta> {
  return {
    getId,
    entities: new Map(),
    queries: new Map(),
    itemQueryIndex: new Map(),
  }
}

function itemHasKey(
  item: unknown,
  key: EntityKey,
  getId: (item: unknown) => ItemId | undefined,
): boolean {
  const id = getId(item)
  return id !== undefined && entityKey(id) === key
}

/**
 * An unfiltered allPages find (`.all()`), whose response is the service's complete
 * row set. `$sort` doesn't affect which rows are fetched, so a sorted one still is.
 */
export function isCompleteSetQuery<TMeta>(query: Query<unknown, TMeta, unknown>): boolean {
  const q = queryOfParams(query.desc.params)
  return (
    query.desc.method === 'find' &&
    'allPages' in query.config &&
    query.config.allPages === true &&
    (!q || Object.keys(q).every(key => key === '$sort'))
  )
}

export function groupEventsByService<TEvent extends { serviceName: string }>(
  events: readonly TEvent[],
): Record<string, TEvent[]> {
  const eventsByService: Record<string, TEvent[]> = {}
  for (const event of events) {
    if (!eventsByService[event.serviceName]) {
      eventsByService[event.serviceName] = []
    }
    eventsByService[event.serviceName]!.push(event)
  }
  return eventsByService
}

export function applyEventsToService<TMeta>({
  service,
  serviceName,
  events,
  getId,
  isItemStale,
  processedEvents,
}: {
  service: ServiceState<TMeta>
  serviceName: string
  events: QueuedEvent[]
  getId: (item: unknown) => ItemId | undefined
  isItemStale: (curr: unknown, next: unknown) => boolean
  processedEvents: ProcessedCacheEvent[]
}): void {
  for (const event of events) {
    const id = getId(event.item)
    if (id === undefined) continue
    const itemId = entityKey(id)
    const previousItem = service.entities.get(itemId) ?? null
    if (
      event.mode === 'server' &&
      previousItem &&
      (event.type === 'updated' || event.type === 'patched') &&
      isItemStale(previousItem, event.item)
    )
      continue
    if (event.mode === 'server' && event.source === 'fetch' && sameValue(previousItem, event.item))
      continue

    if (event.type === 'removed') service.entities.delete(itemId)
    else service.entities.set(itemId, event.item)
    processedEvents.push({ ...event, serviceName, previousItem, itemId })
  }
}

/**
 * Diff a complete-set fetch (unfiltered allPages — the service's authoritative row
 * set) against the pre-fetch entity cache, expressing the changes as synthetic
 * realtime events. Rows absent from the new set are deleted from the entity cache
 * here (the fetch already upserted the present ones); creations and updates are
 * reported by comparing cached references against the snapshot.
 */
export function diffCompleteSet<TMeta>({
  service,
  serviceName,
  previousEntities,
  nextItemIds,
  ignoredItemIds,
}: {
  service: ServiceState<TMeta>
  serviceName: string
  previousEntities: Map<EntityKey, unknown>
  nextItemIds: Set<EntityKey>
  /** Items changed by events during the fetch; those events already own their diff. */
  ignoredItemIds?: ReadonlySet<EntityKey>
}): ProcessedCacheEvent[] {
  const events: ProcessedCacheEvent[] = []
  for (const [itemId, previousItem] of previousEntities) {
    if (ignoredItemIds?.has(itemId)) continue
    if (!nextItemIds.has(itemId)) {
      service.entities.delete(itemId)
      events.push({
        mode: 'server',
        serviceName,
        type: 'removed',
        item: previousItem,
        previousItem,
        itemId,
        source: 'fetch',
      })
    }
  }
  for (const itemId of nextItemIds) {
    if (ignoredItemIds?.has(itemId)) continue
    const item = service.entities.get(itemId)!
    const previousItem = previousEntities.get(itemId)
    if (!previousItem) {
      events.push({
        mode: 'server',
        serviceName,
        type: 'created',
        item,
        previousItem: null,
        itemId,
        source: 'fetch',
      })
    } else if (previousItem !== item) {
      events.push({
        mode: 'server',
        serviceName,
        type: 'updated',
        item,
        previousItem,
        itemId,
        source: 'fetch',
      })
    }
  }
  return events
}

interface QueryEventContext<TMeta> {
  service: ServiceState<TMeta>
  touch: (queryId: string) => void
  getId: (item: unknown) => ItemId | undefined
  itemAdded: (meta: TMeta) => TMeta
  itemRemoved: (meta: TMeta) => TMeta
}

type QueryEventApplication = 'applied' | 'reconcile' | 'ignored'

function applyVisibleEventEffect<TMeta>(
  context: QueryEventContext<TMeta>,
  queryId: string,
  event: ProcessedCacheEvent,
  effect: 'remove' | 'replace',
): boolean {
  const { service, touch, getId, itemRemoved } = context
  const query = service.queries.get(queryId)
  if (!query) return false

  const { itemId } = event
  if (query.desc.method === 'get' && entityKey(query.desc.resourceId) !== itemId) {
    return false
  }

  const hasItem = service.itemQueryIndex.get(itemId)?.has(queryId) ?? false
  if (effect === 'remove') {
    if (!hasItem || query.state.status !== 'success') return false
    const nextState: QueryState<unknown, TMeta> =
      query.desc.method === 'get'
        ? {
            status: 'error',
            data: null,
            meta: itemRemoved(query.state.meta),
            isFetching: false,
            error: new ItemRemovedError(query.desc.resourceId),
          }
        : {
            ...query.state,
            meta: itemRemoved(query.state.meta),
            data: query.rows.data.filter(item => !itemHasKey(item, itemId, getId)),
          }
    commitQuery(service, { ...query, state: nextState })
    touch(queryId)
    return true
  }

  const item = service.entities.get(itemId) ?? event.item
  if (query.desc.method === 'get') {
    commitQuery(service, {
      ...query,
      state:
        query.state.status === 'success'
          ? { ...query.state, data: item }
          : {
              status: 'success',
              data: item,
              meta: query.state.meta,
              isFetching: query.state.isFetching,
              error: null,
            },
    })
    touch(queryId)
    return true
  }

  if (!hasItem || query.state.status !== 'success') return false
  const data = query.rows.data.map(current => (itemHasKey(current, itemId, getId) ? item : current))
  if (query.maintenance.classification === 'local-exact') {
    sortQueryRows(data, query)
  }
  commitQuery(service, {
    ...query,
    state: { ...query.state, data },
  })
  touch(queryId)
  return true
}

/**
 * Apply only the value-level effect of an already-processed event to one query.
 * Cursor-prefix maintenance uses this after separately proving whether page
 * membership and ordering are unchanged.
 */
export function applyVisibleEventToQuery<TMeta>({
  service,
  queryId,
  event,
  touch,
  getId,
  itemRemoved,
}: {
  service: ServiceState<TMeta>
  queryId: string
  event: ProcessedCacheEvent
  touch: (queryId: string) => void
  getId: (item: unknown) => ItemId | undefined
  itemRemoved: (meta: TMeta) => TMeta
}): boolean {
  return applyVisibleEventEffect(
    {
      service,
      touch,
      getId,
      itemAdded: meta => meta,
      itemRemoved,
    },
    queryId,
    event,
    event.type === 'removed' ? 'remove' : 'replace',
  )
}

function sortQueryRows<TMeta>(rows: unknown[], query: Query<unknown, TMeta, unknown>): unknown[] {
  return query.maintenance.compare ? rows.sort(query.maintenance.compare) : rows
}

function applyMergeEventToQuery<TMeta>(
  context: QueryEventContext<TMeta>,
  queryId: string,
  event: ProcessedCacheEvent,
): QueryEventApplication {
  const { service, touch, getId, itemAdded, itemRemoved } = context
  const query = service.queries.get(queryId)
  if (!query) return 'ignored'

  const { type, item, previousItem, itemId } = event
  if (isServerMaintained(query.maintenance.classification)) {
    // Server windows merge every provable effect locally. An unprovable effect,
    // and every server-authoritative query, reconciles from the server.
    if (query.maintenance.classification !== 'server-window' || query.desc.method !== 'find') {
      return 'reconcile'
    }
    if (query.state.status !== 'success' || !Array.isArray(query.state.data)) return 'ignored'
    const result = maintainWindow(
      {
        rows: query.rows.data,
        skip: query.maintenance.skip,
        limit:
          query.maintenance.limit === undefined
            ? undefined
            : servedLimit(query.state.meta, query.maintenance.limit),
      },
      {
        type,
        item,
        previousItem,
        itemId,
        hasItem: service.itemQueryIndex.get(itemId)?.has(queryId) ?? false,
      },
      {
        matches: query.maintenance.matches,
        compare: query.maintenance.compare,
        keyOf: row => {
          const id = getId(row)
          return id === undefined ? undefined : entityKey(id)
        },
      },
    )
    if (result.type === 'refetch') {
      if (result.replaceVisible) applyVisibleEventEffect(context, queryId, event, 'replace')
      return 'reconcile'
    }
    if (result.type === 'noop') return 'ignored'

    commitQuery(service, {
      ...query,
      state: {
        ...query.state,
        meta:
          result.metaOp === 'added'
            ? itemAdded(query.state.meta)
            : result.metaOp === 'removed'
              ? itemRemoved(query.state.meta)
              : query.state.meta,
        data: result.data,
      },
    })
    touch(queryId)
    return 'applied'
  }

  const matches = type !== 'removed' && query.maintenance.matches(item)
  const hasItem = service.itemQueryIndex.get(itemId)?.has(queryId) ?? false
  if (matches === 'unknown') {
    // Local state can't decide the item: keep membership as it is and ask the
    // server, while a visible row still shows its new values.
    if (hasItem) applyVisibleEventEffect(context, queryId, event, 'replace')
    return 'reconcile'
  }
  if (hasItem) {
    return applyVisibleEventEffect(context, queryId, event, matches ? 'replace' : 'remove')
      ? 'applied'
      : 'ignored'
  }

  if (matches && query.desc.method === 'find' && query.state.status === 'success') {
    commitQuery(service, {
      ...query,
      state: {
        ...query.state,
        meta: itemAdded(query.state.meta),
        data: sortQueryRows(query.rows.data.concat(item), query),
      },
    })
    touch(queryId)
    return 'applied'
  }

  if (
    matches &&
    type === 'created' &&
    query.desc.method === 'get' &&
    entityKey(query.desc.resourceId) === itemId
  ) {
    // Restore a get query when its resource reappears after a removal or rollback.
    return applyVisibleEventEffect(context, queryId, event, 'replace') ? 'applied' : 'ignored'
  }

  return 'ignored'
}

export function updateQueriesFromEvents<TMeta>({
  service,
  appliedItems,
  membershipScope,
  touch,
  getId,
  itemAdded,
  itemRemoved,
  serverMaintainedQueriesToRefetch,
  onEffect,
  excludeQueryId,
  excludeQueryIds,
}: {
  service: ServiceState<TMeta>
  appliedItems: readonly ProcessedCacheEvent[]
  membershipScope: QueryMembershipScope
  touch: (queryId: string) => void
  getId: (item: unknown) => ItemId | undefined
  itemAdded: (meta: TMeta) => TMeta
  itemRemoved: (meta: TMeta) => TMeta
  serverMaintainedQueriesToRefetch: Set<string>
  onEffect?: (queryId: string, effect: 'merged' | 'reconcile') => void
  /** A query whose state already reflects the applied items (e.g. the fetch they came from). */
  excludeQueryId?: string
  excludeQueryIds?: ReadonlySet<string>
}): void {
  const context: QueryEventContext<TMeta> = {
    service,
    touch,
    getId,
    itemAdded,
    itemRemoved,
  }
  for (const event of appliedItems) {
    for (const [queryId, query] of service.queries) {
      if (queryId === excludeQueryId || excludeQueryIds?.has(queryId)) continue
      if (!queryPolicy(query.maintenance).mergeEvents) continue
      const visible = service.itemQueryIndex.get(event.itemId)?.has(queryId) ?? false
      if (membershipScope === 'visible-only' && !visible) continue
      if (
        isServerMaintained(query.maintenance.classification) &&
        event.mode === 'server' &&
        event.source === 'fetch'
      ) {
        if (
          query.maintenance.classification === 'server-window' &&
          service.materialized &&
          service.materialized?.queryId === excludeQueryId
        ) {
          serverMaintainedQueriesToRefetch.add(queryId)
          onEffect?.(queryId, 'reconcile')
          continue
        }
        // New fetch rows may already be counted in another server page's total.
        // Only reconcile known membership when a previously visible row changes.
        if (!visible || query.maintenance.isProjection) continue
        // A sibling fetch may update the canonical entity, but it cannot replace
        // values owned by this query. Root-owned removals still apply.
        if (query.rows.kind === 'values' && event.type !== 'removed') continue
        if (query.maintenance.classification === 'server-window' && event.type !== 'created') {
          const result = applyMergeEventToQuery(context, queryId, event)
          if (result === 'reconcile') {
            serverMaintainedQueriesToRefetch.add(queryId)
            onEffect?.(queryId, 'reconcile')
          } else if (result === 'applied') {
            onEffect?.(queryId, 'merged')
          }
        } else if (
          applyVisibleEventEffect(
            context,
            queryId,
            event,
            event.type === 'removed' ? 'remove' : 'replace',
          )
        ) {
          onEffect?.(queryId, 'merged')
        }
        continue
      }
      const result = applyMergeEventToQuery(context, queryId, event)
      if (result === 'reconcile') {
        serverMaintainedQueriesToRefetch.add(queryId)
        onEffect?.(queryId, 'reconcile')
      } else if (result === 'applied') {
        onEffect?.(queryId, 'merged')
      }
    }
  }
}

export type QueryReapplyResult = 'applied' | 'reconcile' | 'ignored'

/** Rebuild one locally decidable find from the entity cache. */
export function reapplyQueryFromEntities<TMeta>({
  service,
  queryId,
  touch,
  getId,
  itemAdded,
  itemRemoved,
}: {
  service: ServiceState<TMeta>
  queryId: string
  touch: (queryId: string) => void
  getId: (item: unknown) => ItemId | undefined
  itemAdded: (meta: TMeta) => TMeta
  itemRemoved: (meta: TMeta) => TMeta
}): QueryReapplyResult {
  const query = service.queries.get(queryId)
  if (!query || !queryPolicy(query.maintenance).mergeEvents) return 'ignored'
  if (isServerMaintained(query.maintenance.classification)) return 'reconcile'
  if (query.desc.method !== 'find' || query.state.status !== 'success') return 'ignored'
  if (!Array.isArray(query.state.data)) return 'ignored'

  const previousRows = query.rows.data
  const previousKeys = new Set<EntityKey>()
  for (const item of previousRows) {
    const itemId = getId(item)
    if (itemId === undefined) continue
    previousKeys.add(entityKey(itemId))
  }

  // Rows local state can't decide keep their current membership, and the query
  // reconciles with the server once the rebuild is committed.
  let undecided = false
  const candidates = new Map<EntityKey, { id: EntityKey; item: unknown }>()
  for (const [storedId, item] of service.entities) {
    const incomingId = getId(item)
    if (incomingId === undefined) continue
    const match = query.maintenance.matches(item)
    if (match === 'unknown') undecided = true
    if (match === true || (match === 'unknown' && previousKeys.has(storedId))) {
      candidates.set(storedId, { id: storedId, item })
    }
  }

  const retainedKeys = new Set<EntityKey>()
  const nextRows: unknown[] = []
  for (const item of previousRows) {
    const itemId = getId(item)
    if (itemId === undefined) continue
    const key = entityKey(itemId)
    const candidate = candidates.get(key)
    if (!candidate) continue
    retainedKeys.add(key)
    nextRows.push(candidate.item)
  }
  for (const [key, candidate] of candidates) {
    if (!retainedKeys.has(key)) nextRows.push(candidate.item)
  }

  if (query.maintenance.compare) nextRows.sort(query.maintenance.compare)

  const nextKeys = new Set(candidates.keys())
  const added = [...nextKeys].filter(key => !previousKeys.has(key))
  const removed = [...previousKeys].filter(key => !nextKeys.has(key))
  const dataChanged =
    previousRows.length !== nextRows.length ||
    previousRows.some((item, index) => item !== nextRows[index])
  if (!dataChanged && added.length === 0 && removed.length === 0) {
    return undecided ? 'reconcile' : 'ignored'
  }

  let meta = query.state.meta
  for (let index = 0; index < added.length; index += 1) meta = itemAdded(meta)
  for (let index = 0; index < removed.length; index += 1) meta = itemRemoved(meta)
  commitQuery(service, {
    ...query,
    state: { ...query.state, data: nextRows, meta },
  })
  touch(queryId)
  return undecided ? 'reconcile' : 'applied'
}

/** Replay in-flight events over one fetched query without changing disabled snapshots. */
export function replayFetchedQueryFromEvents<TMeta>({
  service,
  queryId,
  events,
  touch,
  getId,
  itemAdded,
  itemRemoved,
}: {
  service: ServiceState<TMeta>
  queryId: string
  events: readonly ProcessedCacheEvent[]
  touch: (queryId: string) => void
  getId: (item: unknown) => ItemId | undefined
  itemAdded: (meta: TMeta) => TMeta
  itemRemoved: (meta: TMeta) => TMeta
}): void {
  const context: QueryEventContext<TMeta> = {
    service,
    touch,
    getId,
    itemAdded,
    itemRemoved,
  }
  for (const event of events) {
    const query = service.queries.get(queryId)
    if (!query || queryPolicy(query.maintenance).responseMode === 'snapshot') return

    const { mergeEvents, replayVisibleEvents } = queryPolicy(query.maintenance)
    if (mergeEvents) {
      const result = applyMergeEventToQuery(context, queryId, event)
      if (result === 'applied' || !replayVisibleEvents) continue
    }
    applyVisibleEventEffect(
      context,
      queryId,
      event,
      event.type === 'removed' ? 'remove' : 'replace',
    )
  }
}
