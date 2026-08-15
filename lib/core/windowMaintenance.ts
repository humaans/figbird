/**
 * Window maintenance and realtime event application — the pure algebra the query
 * store orchestrates. Everything here is a plain function over explicit inputs
 * (service state, queries, queued events); no store instance, no side channels.
 *
 * The heart of the module is `mergeEventIntoWindow`, which decides whether a
 * realtime event's effect on a server-window query ($limit/$skip/$sort) is
 * *provable* from local state — merging locally when it is, and reporting
 * "refetch" when it is not. The soundness argument lives on the function.
 */

import { isServerMaintained } from './queryClassification.js'
import { ItemRemovedError } from './errors.js'
import { buildComparator } from './sort.js'
import {
  entityKey,
  type EntityKey,
  type ItemId,
  queryOfParams,
  type EventType,
  type ProcessedRealtimeEvent,
  type Query,
  type QueryState,
  type QueuedEvent,
  type ServiceState,
} from './queryTypes.js'

export function createServiceState<TMeta = Record<string, unknown>>(): ServiceState<TMeta> {
  return {
    entities: new Map(),
    queries: new Map(),
    itemQueryIndex: new Map(),
  }
}

function getQueryItems<TMeta = Record<string, unknown>>(
  query: Query<unknown, TMeta, unknown>,
): unknown[] {
  return Array.isArray(query.state.data)
    ? query.state.data
    : query.state.data
      ? [query.state.data]
      : []
}

function itemHasKey(
  item: unknown,
  key: EntityKey,
  getId: (item: unknown) => ItemId | undefined,
): boolean {
  const id = getId(item)
  return id !== undefined && entityKey(id) === key
}

export function addQueryToItemIndex<TMeta>(
  service: ServiceState<TMeta>,
  itemId: ItemId,
  queryId: string,
): void {
  const key = entityKey(itemId)
  if (!service.itemQueryIndex.has(key)) {
    service.itemQueryIndex.set(key, new Set())
  }
  service.itemQueryIndex.get(key)!.add(queryId)
}

export function removeQueryFromItemIndex<TMeta>({
  service,
  query,
  queryId,
  getId,
}: {
  service: ServiceState<TMeta>
  query: Query<unknown, TMeta, unknown>
  queryId: string
  getId: (item: unknown) => ItemId | undefined
}): void {
  for (const item of getQueryItems(query)) {
    const id = getId(item)
    if (id !== undefined) {
      removeQueryFromItemIndexById(service, id, queryId)
    }
  }
}

export function removeQueryFromItemIndexById<TMeta>(
  service: ServiceState<TMeta>,
  itemId: ItemId,
  queryId: string,
): void {
  const key = entityKey(itemId)
  const queryIds = service.itemQueryIndex.get(key)
  if (!queryIds) return
  queryIds.delete(queryId)
  if (queryIds.size === 0) {
    service.itemQueryIndex.delete(key)
  }
}

// `$sort` doesn't affect which rows are fetched, so a sorted-but-unfiltered
// allPages query still proves the complete row set.
export function isUnfilteredFindQuery(params: unknown): boolean {
  const q = queryOfParams(params)
  return !q || Object.keys(q).every(key => key === '$sort')
}

/** Split window operators off a query so the rest can feed the local matcher. */
export function splitWindow(q: Record<string, unknown> | undefined): {
  filters: Record<string, unknown> | undefined
  sort: Record<string, number> | undefined
  limit: number | undefined
  skip: number
} {
  if (!q) return { filters: undefined, sort: undefined, limit: undefined, skip: 0 }
  const { $sort, $limit, $skip, ...filters } = q
  return {
    filters: Object.keys(filters).length > 0 ? filters : undefined,
    sort: $sort as Record<string, number> | undefined,
    limit: $limit as number | undefined,
    skip: ($skip as number | undefined) ?? 0,
  }
}

/** First index whose row sorts strictly after the item — ties insert after their equals. */
function findInsertIndex(
  rows: unknown[],
  item: unknown,
  cmp: (a: unknown, b: unknown) => number,
): number {
  let lo = 0
  let hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cmp(item, rows[mid]) < 0) {
      hi = mid
    } else {
      lo = mid + 1
    }
  }
  return lo
}

export function groupQueuedEvents(events: QueuedEvent[]): Record<string, QueuedEvent[]> {
  const eventsByService: Record<string, QueuedEvent[]> = {}
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
  processedEvents: ProcessedRealtimeEvent[]
}): void {
  for (const event of events) {
    const { type, items } = event
    for (const [index, item] of items.entries()) {
      const cause = event.causes?.[index]
      if (type === 'created') {
        const incomingId = getId(item)
        if (incomingId !== undefined) {
          const itemId = entityKey(incomingId)
          const previousItem = service.entities.get(itemId) ?? null
          service.entities.set(itemId, item)
          processedEvents.push({
            serviceName,
            type,
            item,
            previousItem,
            itemId,
            source: event.source,
            ...(cause === undefined ? {} : { cause }),
            ...(event.origin === 'projection'
              ? { origin: event.origin, mutationLaneKey: event.mutationLaneKey }
              : { origin: event.origin }),
          })
        }
      } else if (type === 'updated' || type === 'patched') {
        const incomingId = getId(item)
        if (incomingId !== undefined) {
          const itemId = entityKey(incomingId)
          const currItem = service.entities.get(itemId)
          if (event.origin === 'projection' || !currItem || !isItemStale(currItem, item)) {
            service.entities.set(itemId, item)
            processedEvents.push({
              serviceName,
              type,
              item,
              previousItem: currItem ?? null,
              itemId,
              source: event.source,
              ...(cause === undefined ? {} : { cause }),
              ...(event.origin === 'projection'
                ? { origin: event.origin, mutationLaneKey: event.mutationLaneKey }
                : { origin: event.origin }),
            })
          }
        }
      } else if (type === 'removed') {
        const incomingId = getId(item)
        if (incomingId !== undefined) {
          const itemId = entityKey(incomingId)
          const previousItem = service.entities.get(itemId) ?? null
          service.entities.delete(itemId)
          processedEvents.push({
            serviceName,
            type,
            item,
            previousItem,
            itemId,
            source: event.source,
            ...(cause === undefined ? {} : { cause }),
            ...(event.origin === 'projection'
              ? { origin: event.origin, mutationLaneKey: event.mutationLaneKey }
              : { origin: event.origin }),
          })
        }
      }
    }
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
}): ProcessedRealtimeEvent[] {
  const events: ProcessedRealtimeEvent[] = []
  for (const [itemId, previousItem] of previousEntities) {
    if (ignoredItemIds?.has(itemId)) continue
    if (!nextItemIds.has(itemId)) {
      service.entities.delete(itemId)
      events.push({
        origin: 'authoritative',
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
        origin: 'authoritative',
        serviceName,
        type: 'created',
        item,
        previousItem: null,
        itemId,
        source: 'fetch',
      })
    } else if (previousItem !== item) {
      events.push({
        origin: 'authoritative',
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
  defaultSort: Record<string, number> | undefined
}

type QueryEventApplication = 'applied' | 'reconcile' | 'ignored'

function applyVisibleEventEffect<TMeta>(
  context: QueryEventContext<TMeta>,
  queryId: string,
  event: ProcessedRealtimeEvent,
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
            data: (query.state.data as unknown[]).filter(item => !itemHasKey(item, itemId, getId)),
          }
    service.queries.set(queryId, { ...query, state: nextState })
    removeQueryFromItemIndexById(service, itemId, queryId)
    touch(queryId)
    return true
  }

  const item = service.entities.get(itemId) ?? event.item
  if (query.desc.method === 'get') {
    service.queries.set(queryId, {
      ...query,
      state: {
        status: 'success',
        data: item,
        meta: query.state.meta,
        isFetching: false,
        error: null,
      },
    })
    addQueryToItemIndex(service, itemId, queryId)
    touch(queryId)
    return true
  }

  if (!hasItem || query.state.status !== 'success') return false
  service.queries.set(queryId, {
    ...query,
    state: {
      ...query.state,
      data: (query.state.data as unknown[]).map(current =>
        itemHasKey(current, itemId, getId) ? item : current,
      ),
    },
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
  event: ProcessedRealtimeEvent
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
      defaultSort: undefined,
    },
    queryId,
    event,
    event.type === 'removed' ? 'remove' : 'replace',
  )
}

function applyMergeEventToQuery<TMeta>(
  context: QueryEventContext<TMeta>,
  queryId: string,
  event: ProcessedRealtimeEvent,
): QueryEventApplication {
  const { service, touch, getId, itemAdded, itemRemoved, defaultSort } = context
  const query = service.queries.get(queryId)
  if (!query) return 'ignored'

  const { type, item, previousItem, itemId } = event
  if (isServerMaintained(query.classification)) {
    // Server windows merge every provable effect locally. An unprovable effect,
    // and every server-authoritative query, reconciles from the server.
    if (query.classification !== 'server-window' || query.desc.method !== 'find') {
      return 'reconcile'
    }
    const result = mergeEventIntoWindow({
      query,
      type,
      item,
      previousItem,
      itemId,
      hasItem: service.itemQueryIndex.get(itemId)?.has(queryId) ?? false,
      getId,
      ...(defaultSort !== undefined ? { defaultSort } : {}),
    })
    if (result.action === 'refetch') return 'reconcile'
    if (result.action === 'noop' || query.state.status !== 'success') return 'ignored'

    service.queries.set(queryId, {
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
    if (result.enteredWindow) addQueryToItemIndex(service, itemId, queryId)
    if (result.leftWindow) removeQueryFromItemIndexById(service, itemId, queryId)
    if (result.evictedId !== undefined) {
      removeQueryFromItemIndexById(service, result.evictedId, queryId)
    }
    touch(queryId)
    return 'applied'
  }

  const matches = type !== 'removed' && query.filterItem(item)
  const hasItem = service.itemQueryIndex.get(itemId)?.has(queryId) ?? false
  if (hasItem) {
    return applyVisibleEventEffect(context, queryId, event, matches ? 'replace' : 'remove')
      ? 'applied'
      : 'ignored'
  }

  if (matches && query.desc.method === 'find' && query.state.status === 'success') {
    service.queries.set(queryId, {
      ...query,
      state: {
        ...query.state,
        meta: itemAdded(query.state.meta),
        data: (query.state.data as unknown[]).concat(item),
      },
    })
    addQueryToItemIndex(service, itemId, queryId)
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
  touch,
  getId,
  itemAdded,
  itemRemoved,
  serverMaintainedQueriesToRefetch,
  excludeQueryId,
  defaultSort,
}: {
  service: ServiceState<TMeta>
  appliedItems: readonly ProcessedRealtimeEvent[]
  touch: (queryId: string) => void
  getId: (item: unknown) => ItemId | undefined
  itemAdded: (meta: TMeta) => TMeta
  itemRemoved: (meta: TMeta) => TMeta
  serverMaintainedQueriesToRefetch: Set<string>
  /** A query whose state already reflects the applied items (e.g. the fetch they came from). */
  excludeQueryId?: string
  /** The backend's implicit order for queries without `$sort` — see QueryStore options. */
  defaultSort?: Record<string, number> | undefined
}): Map<string, 'merged' | 'reconcile'> {
  const context: QueryEventContext<TMeta> = {
    service,
    touch,
    getId,
    itemAdded,
    itemRemoved,
    defaultSort,
  }
  const effects = new Map<string, 'merged' | 'reconcile'>()
  for (const event of appliedItems) {
    for (const [queryId, query] of service.queries) {
      if (queryId === excludeQueryId || query.config.realtime !== 'merge') continue
      if (query.desc.method === 'find' && query.config.fetchPolicy === 'network-only') continue
      const result = applyMergeEventToQuery(context, queryId, event)
      if (result === 'reconcile') {
        serverMaintainedQueriesToRefetch.add(queryId)
        effects.set(queryId, 'reconcile')
      } else if (result === 'applied') {
        effects.set(queryId, 'merged')
      }
    }
  }
  return effects
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
  defaultSort,
}: {
  service: ServiceState<TMeta>
  queryId: string
  touch: (queryId: string) => void
  getId: (item: unknown) => ItemId | undefined
  itemAdded: (meta: TMeta) => TMeta
  itemRemoved: (meta: TMeta) => TMeta
  defaultSort?: Record<string, number> | undefined
}): QueryReapplyResult {
  const query = service.queries.get(queryId)
  if (!query || query.config.realtime !== 'merge') return 'ignored'
  if (query.desc.method === 'find' && query.config.fetchPolicy === 'network-only') return 'ignored'
  if (isServerMaintained(query.classification)) return 'reconcile'
  if (query.desc.method !== 'find' || query.state.status !== 'success') return 'ignored'
  if (!Array.isArray(query.state.data)) return 'ignored'

  const candidates = new Map<EntityKey, { id: EntityKey; item: unknown }>()
  for (const [storedId, item] of service.entities) {
    const incomingId = getId(item)
    if (incomingId === undefined || !query.filterItem(item)) continue
    candidates.set(storedId, { id: storedId, item })
  }

  const previousRows = query.state.data as unknown[]
  const previousKeys = new Set<EntityKey>()
  for (const item of previousRows) {
    const itemId = getId(item)
    if (itemId === undefined) continue
    previousKeys.add(entityKey(itemId))
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

  const { sort } = splitWindow(queryOfParams(query.desc.params))
  const effectiveSort = sort ?? defaultSort
  if (effectiveSort) nextRows.sort(buildComparator(effectiveSort))

  const nextKeys = new Set(candidates.keys())
  const added = [...nextKeys].filter(key => !previousKeys.has(key))
  const removed = [...previousKeys].filter(key => !nextKeys.has(key))
  const dataChanged =
    previousRows.length !== nextRows.length ||
    previousRows.some((item, index) => item !== nextRows[index])
  if (!dataChanged && added.length === 0 && removed.length === 0) return 'ignored'

  for (const key of removed) {
    removeQueryFromItemIndexById(service, key, queryId)
  }
  for (const key of added) {
    const candidate = candidates.get(key)
    if (candidate) addQueryToItemIndex(service, candidate.id, queryId)
  }

  let meta = query.state.meta
  for (let index = 0; index < added.length; index += 1) meta = itemAdded(meta)
  for (let index = 0; index < removed.length; index += 1) meta = itemRemoved(meta)
  service.queries.set(queryId, {
    ...query,
    state: { ...query.state, data: nextRows, meta },
  })
  touch(queryId)
  return 'applied'
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
  defaultSort,
}: {
  service: ServiceState<TMeta>
  queryId: string
  events: readonly ProcessedRealtimeEvent[]
  touch: (queryId: string) => void
  getId: (item: unknown) => ItemId | undefined
  itemAdded: (meta: TMeta) => TMeta
  itemRemoved: (meta: TMeta) => TMeta
  defaultSort?: Record<string, number> | undefined
}): void {
  const context: QueryEventContext<TMeta> = {
    service,
    touch,
    getId,
    itemAdded,
    itemRemoved,
    defaultSort,
  }
  for (const event of events) {
    const query = service.queries.get(queryId)
    if (!query || query.config.realtime === 'disabled') return

    const canMerge =
      query.config.realtime === 'merge' &&
      !(query.desc.method === 'find' && query.config.fetchPolicy === 'network-only')
    const needsVisibleFallback =
      query.config.realtime === 'refetch' ||
      query.config.fetchPolicy === 'network-only' ||
      isServerMaintained(query.classification)
    if (canMerge) {
      const result = applyMergeEventToQuery(context, queryId, event)
      if (result === 'applied' || !needsVisibleFallback) continue
    }
    applyVisibleEventEffect(
      context,
      queryId,
      event,
      event.type === 'removed' ? 'remove' : 'replace',
    )
  }
}

type WindowMergeResult =
  | { action: 'noop' }
  | { action: 'refetch' }
  | {
      action: 'merge'
      data: unknown[]
      metaOp: 'added' | 'removed' | null
      /** The event item entered the visible window — add it to the query index. */
      enteredWindow: boolean
      /** The event item left the visible window — drop it from the query index. */
      leftWindow: boolean
      /** A row evicted to make room — its query-index entry must be dropped too. */
      evictedId?: ItemId
    }

/**
 * Try to merge one realtime event into a server-window find without a refetch.
 *
 * The soundness argument: the visible rows are a contiguous run of the server
 * result (positions `$skip .. $skip + rows.length`), and the window's predicate is
 * locally evaluable (anything non-local classifies server-authoritative). So an
 * event's effect on the window is provable whenever the item's position relative
 * to the run's boundaries is known:
 *
 * - a patch to a visible row that keeps its membership and sort position updates
 *   in place — no order knowledge needed when the sort keys didn't change;
 * - an underfilled window (`rows.length < $limit`) is the final page, so past-the-
 *   end inserts and removals of visible rows resolve like local-exact;
 * - an item sorting strictly inside the run belongs there — insert it and evict
 *   the overflow row (which slides back in on the next fetch of a later window);
 * - membership changes provably beyond the window only adjust the meta total.
 *
 * Everything unprovable returns `refetch` — the previous behavior for every event.
 * Order is judged by `$sort` when present, else the configured `defaultSort` (the
 * backend's implicit order). With neither, visible patches keep their position and
 * appends to an underfilled first page go to the end — membership stays exact,
 * order is approximate until the next fetch, which is the accepted trade.
 * Boundary ties refetch: the server's tiebreak decides membership there.
 */
function mergeEventIntoWindow<TMeta>({
  query,
  type,
  item,
  previousItem,
  itemId,
  hasItem,
  getId,
  defaultSort,
}: {
  query: Query<unknown, TMeta, unknown>
  type: EventType
  item: unknown
  previousItem: unknown | null
  itemId: EntityKey
  hasItem: boolean
  getId: (item: unknown) => ItemId | undefined
  defaultSort?: Record<string, number> | undefined
}): WindowMergeResult {
  const state = query.state
  if (state.status !== 'success' || !Array.isArray(state.data)) return { action: 'noop' }

  const q = queryOfParams(query.desc.params)
  const { sort, limit, skip } = splitWindow(q)
  const effectiveSort = sort ?? defaultSort
  const cmp = effectiveSort ? buildComparator(effectiveSort) : null
  const rows = state.data as unknown[]
  const full = limit !== undefined && rows.length >= limit
  const matches = type !== 'removed' && query.filterItem(item)
  const last = rows.length > 0 ? rows[rows.length - 1] : undefined
  // Is an invisible member provably past the window? At skip 0 everything before
  // the window is visible, so invisible ⇒ beyond; at an offset we need the
  // comparator to prove it sorts after the last visible row.
  const beyondWindow = (x: unknown) =>
    skip === 0 ? true : cmp !== null && last !== undefined && cmp(x, last) > 0
  // Prior result-set membership: judged by the cached previous entity when there is
  // one; a removed event carries the full removed record, which serves the same
  // purpose when the row was never cached (it lived beyond the window).
  const wasMember =
    previousItem != null
      ? query.filterItem(previousItem)
      : type === 'removed' && query.filterItem(item)

  if (!hasItem) {
    if (!matches) {
      // Invisible before and after — only the result-set total can be affected.
      if (!wasMember) return { action: 'noop' }
      if (beyondWindow(previousItem ?? item)) {
        return {
          action: 'merge',
          data: rows,
          metaOp: 'removed',
          enteredWindow: false,
          leftWindow: false,
        }
      }
      // Left the result set from before the window — the page shifts.
      return { action: 'refetch' }
    }

    // The item belongs to the result set now. A created item is certainly new; a
    // cached non-matching previous certainly entered; an uncached patch at an
    // offset window may have come from anywhere, including an earlier page.
    const metaOp =
      type === 'created' || (previousItem != null && !wasMember) ? ('added' as const) : null
    if (skip > 0 && previousItem == null && type !== 'created') {
      return { action: 'refetch' }
    }
    if (wasMember && !beyondWindow(previousItem)) {
      // It was in the result set before the window start — its move shifts the page.
      return { action: 'refetch' }
    }
    if (full && rows.length === 0) {
      // `$limit: 0` — a count-only window.
      if (metaOp === null) return { action: 'noop' }
      return { action: 'merge', data: rows, metaOp, enteredWindow: false, leftWindow: false }
    }
    if (!cmp) {
      if (skip > 0 || full) return { action: 'refetch' }
      // No order knowledge: membership is certain (underfilled first page = the
      // complete result set), position is approximate — append.
      return {
        action: 'merge',
        data: [...rows, item],
        metaOp,
        enteredWindow: true,
        leftWindow: false,
      }
    }
    if (rows.length === 0) {
      if (skip > 0) return { action: 'refetch' }
      return { action: 'merge', data: [item], metaOp, enteredWindow: true, leftWindow: false }
    }
    const i = findInsertIndex(rows, item, cmp)
    if (i === 0 && skip > 0) return { action: 'refetch' } // sorts before the page
    if (i === rows.length) {
      if (!full) {
        // Underfilled window = the final page: past-the-end still belongs here.
        return {
          action: 'merge',
          data: [...rows, item],
          metaOp,
          enteredWindow: true,
          leftWindow: false,
        }
      }
      if (cmp(item, rows[rows.length - 1]!) === 0) {
        return { action: 'refetch' } // tied with the boundary row
      }
      // Strictly past a full window: the total changes, the visible rows don't.
      if (metaOp === null) return { action: 'noop' }
      return { action: 'merge', data: rows, metaOp, enteredWindow: false, leftWindow: false }
    }
    const data = [...rows.slice(0, i), item, ...rows.slice(i)]
    let evictedId: ItemId | undefined
    if (limit !== undefined && data.length > limit) {
      const evicted = data.pop()
      evictedId = evicted !== undefined ? getId(evicted) : undefined
    }
    return {
      action: 'merge',
      data,
      metaOp,
      enteredWindow: true,
      leftWindow: false,
      ...(evictedId !== undefined ? { evictedId } : {}),
    }
  }

  if (!matches) {
    // A visible row leaves. On a full window the replacement row is unknown.
    if (full) return { action: 'refetch' }
    return {
      action: 'merge',
      data: rows.filter(row => !itemHasKey(row, itemId, getId)),
      metaOp: 'removed',
      enteredWindow: false,
      leftWindow: true,
    }
  }

  // Visible and still matching: update in place unless its sort position moved.
  const index = rows.findIndex(row => itemHasKey(row, itemId, getId))
  if (index === -1) return { action: 'refetch' } // index/data disagree — reconcile
  if (!cmp || cmp(rows[index]!, item) === 0) {
    // Sort keys unchanged (or order unknown — keep the position rather than guess).
    return {
      action: 'merge',
      data: rows.map(row => (itemHasKey(row, itemId, getId) ? item : row)),
      metaOp: null,
      enteredWindow: false,
      leftWindow: false,
    }
  }
  // The row moved: re-place it within the contiguous run.
  const without = rows.filter(row => !itemHasKey(row, itemId, getId))
  if (without.length === 0) {
    return { action: 'merge', data: [item], metaOp: null, enteredWindow: false, leftWindow: false }
  }
  const i = findInsertIndex(without, item, cmp)
  if (i === 0 && skip > 0) return { action: 'refetch' } // may move before the page
  if (i === without.length && full) {
    // May move past the window while an unseen row takes its place.
    return { action: 'refetch' }
  }
  return {
    action: 'merge',
    data: [...without.slice(0, i), item, ...without.slice(i)],
    metaOp: null,
    enteredWindow: false,
    leftWindow: false,
  }
}
