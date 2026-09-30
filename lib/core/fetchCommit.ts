import type { PageResponse, QueryResponse } from '../adapters/adapter.js'
import { rebaseResponseData, type FetchRebasePlan } from './fetchRebase.js'
import { queryPolicy } from './queryMaintenance.js'
import { commitQuery } from './queryResults.js'
import {
  entityKey,
  type EntityKey,
  type ItemId,
  type ProcessedCacheEvent,
  type ProcessedProjectionEvent,
  type Query,
  type QueuedEvent,
  type ServiceState,
  type TraceCause,
} from './queryTypes.js'
import { applyEventsToService, diffCompleteSet, isCompleteSetQuery } from './windowMaintenance.js'

export type StoreResponse<TMeta> =
  | QueryResponse<unknown, TMeta | undefined>
  | PageResponse<unknown[], TMeta>

interface CompleteSetCommit {
  previousEntities: Map<EntityKey, unknown>
  nextItemIds: Set<EntityKey>
  ignoredItemIds: ReadonlySet<EntityKey>
}

interface EntityAccess {
  getId: (item: unknown) => ItemId | undefined
  isItemStale: (current: unknown, next: unknown) => boolean
}

export interface FetchCommitPlan<TMeta> {
  query: Omit<Query<unknown, TMeta>, 'rows'> & { fetchedAt: number }
  entityEvents: QueuedEvent[]
  completeSet: CompleteSetCommit | null
  replayEvents: readonly ProcessedCacheEvent[]
  deferredMutationLaneKeys: readonly string[]
}

/** Plan against the confirmed lane bases and current overlays without mutating the cache. */
export function buildFetchCommit<TMeta>({
  service,
  query,
  result,
  source,
  rebasePlan,
  pendingMutationEvents,
  getId,
  isItemStale,
  meta,
  fetchedAt,
  cause,
}: EntityAccess & {
  service: ServiceState<TMeta>
  query: Query<unknown, TMeta>
  result: StoreResponse<TMeta>
  source: 'cache' | 'server'
  rebasePlan: FetchRebasePlan
  pendingMutationEvents: readonly ProcessedProjectionEvent[]
  meta: TMeta
  fetchedAt: number
  cause?: TraceCause
}): FetchCommitPlan<TMeta> {
  const policy = queryPolicy(query.maintenance)
  const mode = policy.responseMode
  const queryMutationEvents = mode === 'snapshot' ? [] : pendingMutationEvents
  const latestEventById = new Map(rebasePlan.latestEventById)
  for (const event of queryMutationEvents) latestEventById.set(event.itemId, event)
  const ignoredItemIds = new Set(rebasePlan.itemIds)
  // Every pending mutation protects its canonical entity from a fetch overwrite,
  // including snapshots, whose returned rows deliberately ignore those mutations.
  for (const event of pendingMutationEvents) ignoredItemIds.add(event.itemId)

  const rebased = rebaseResponseData({
    data: result.data,
    mode,
    latestEventById,
    entities: service.entities,
    getId,
    isItemStale,
    canKeepCurrentItem: item =>
      !(
        query.desc.method === 'find' &&
        policy.rebaseMembership &&
        query.maintenance.matches(item) === false
      ),
  })
  const entityEvents: QueuedEvent[] = []
  // Projections never replace complete canonical entities, even at the same revision.
  if (source === 'server' && !query.maintenance.isProjection) {
    for (const item of rebased.items) {
      const id = getId(item)
      if (id === undefined || ignoredItemIds.has(entityKey(id))) continue
      entityEvents.push({
        mode: 'server',
        source: 'fetch',
        serviceName: query.desc.serviceName,
        type: service.entities.has(entityKey(id)) ? 'updated' : 'created',
        item,
        ...(cause === undefined ? {} : { cause }),
      })
    }
  }

  let completeSet: CompleteSetCommit | null = null
  if (isCompleteSetQuery(query)) {
    const previousEntities = new Map<EntityKey, unknown>()
    for (const itemId of query.rows.ids) {
      const entity = service.entities.get(itemId)
      if (entity !== undefined) previousEntities.set(itemId, entity)
    }
    const nextItemIds = new Set(rebased.itemIds)
    // A stale complete response cannot delete a newly created row or resurrect a removal.
    for (const [itemId, event] of latestEventById) {
      if (event.type === 'removed') nextItemIds.delete(itemId)
      else nextItemIds.add(itemId)
    }
    completeSet = { previousEntities, nextItemIds, ignoredItemIds }
  }

  const events = [...rebasePlan.events, ...queryMutationEvents]
  const replayEvents =
    mode === 'entity'
      ? events
      : mode === 'fetch-owned'
        ? events.filter(event => event.mode !== 'server' || event.source !== 'realtime')
        : []
  const pageInfo = 'pageInfo' in result ? result.pageInfo : undefined
  return {
    query: {
      ...query,
      fetchedAt,
      state: {
        status: 'success',
        data: rebased.data,
        meta,
        ...(pageInfo ? { pageInfo } : {}),
        isFetching: false,
        error: null,
      },
    },
    entityEvents,
    completeSet,
    replayEvents,
    deferredMutationLaneKeys: queryMutationEvents.map(event => event.mutationLaneKey),
  }
}

/** Apply entities and query membership before the store publishes any effects. */
export function applyFetchCommit<TMeta>(
  service: ServiceState<TMeta>,
  plan: FetchCommitPlan<TMeta>,
  access: EntityAccess,
): ProcessedCacheEvent[] {
  const { query, completeSet } = plan
  const processedEvents: ProcessedCacheEvent[] = []
  applyEventsToService({
    service,
    serviceName: query.desc.serviceName,
    events: plan.entityEvents,
    ...access,
    processedEvents,
  })
  if (completeSet) {
    service.materialized = { queryId: query.queryId, fetchedAt: query.fetchedAt }
  }
  commitQuery(service, query)
  // Complete-set diffs establish membership; ordinary fetches only establish row values.
  return completeSet
    ? diffCompleteSet({ service, serviceName: query.desc.serviceName, ...completeSet })
    : processedEvents
}
