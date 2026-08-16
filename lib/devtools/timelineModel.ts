import type { FigbirdEvent } from '../core/events.js'
import type {
  DevtoolsEvent,
  DevtoolsSnapshot,
  PayloadRetentionState,
  QueryRecord,
  WriteRecord,
} from './collector.js'
import { buildTraceIndex, displayEvent, traceIdsForEvent } from './eventModel.js'
import { compactJson, formatMs } from './format.js'
import type { DevtoolsModel } from './model.js'

export type TimelineActivityKind = 'fetch' | 'realtime' | 'connection' | 'write'
export type TimelineActivityTone = 'green' | 'amber' | 'red' | 'blue' | 'neutral'

const ACTION_WRAPPER_START_TOLERANCE_MS = 10

export interface TimelineActivity {
  id: string
  kind: TimelineActivityKind
  startAt: number
  endAt?: number
  label: string
  operation: string
  detail: string
  status: string
  tone: TimelineActivityTone
  trigger: string
  effect: string
  result: string
  serviceName?: string
  queryId?: string
  queryIds?: string[]
  traceId?: number
  entity?: { serviceName: string; itemId: string | number }
  durationMs?: number
  payload?: unknown
  payloadState?: PayloadRetentionState
  livePayload?: unknown
  data?: unknown
  dataState?: PayloadRetentionState
  liveData?: unknown
  write?: {
    id: string
    type: WriteRecord['type']
    optimistic: boolean
    payload: unknown
    args: readonly unknown[]
    argsState?: PayloadRetentionState
    initiatingAction?: {
      id: string
      name: string
      durationMs?: number
    }
  }
  error: boolean
  searchText: string
}

export interface TimelineExtent {
  start: number
  end: number
}

export function buildTimelineActivities(
  snapshot: DevtoolsSnapshot,
  model: DevtoolsModel,
  nowPoint: number,
): TimelineActivity[] {
  const eventContext = buildEventContext(snapshot.events)
  const activities = [
    ...buildFetchActivities(snapshot.queries, model, eventContext, nowPoint),
    ...buildRealtimeActivities(snapshot, eventContext),
    ...snapshot.timeline.connection.map((item, index) =>
      connectionActivity(item.at, item.event, index, eventContext),
    ),
    ...buildWriteActivities(
      snapshot.writes.filter(write => write.startedAt >= snapshot.timeline.startedAt),
      snapshot,
    ),
  ]
  return activities.sort((a, b) => a.startAt - b.startAt || a.id.localeCompare(b.id))
}

export function timelineExtent(
  activities: readonly TimelineActivity[],
  startedAt: number,
  nowPoint: number,
): TimelineExtent | null {
  if (activities.length === 0) return null
  const earliest = Math.min(...activities.map(activity => activity.startAt))
  const latest = Math.max(...activities.map(activity => activity.endAt ?? nowPoint))
  const start = startedAt > 0 ? Math.min(startedAt, earliest) : earliest
  return { start, end: Math.max(start + 1_000, latest) }
}

interface EventContext {
  fetchStarts: ReadonlyMap<number, DevtoolsEvent>
  fetchTerminals: ReadonlyMap<number, DevtoolsEvent>
  traceEvents: ReadonlyMap<number, readonly DevtoolsEvent[]>
}

function buildEventContext(events: readonly DevtoolsEvent[]): EventContext {
  const traceIndex = buildTraceIndex(events)
  const fetchStarts = new Map<number, DevtoolsEvent>()
  const fetchTerminals = new Map<number, DevtoolsEvent>()
  const traceEvents = new Map<number, DevtoolsEvent[]>()
  for (const item of events) {
    const event = item.event
    if (event.kind === 'fetch:start' && event.fetchId !== undefined) {
      fetchStarts.set(event.fetchId, item)
    }
    if (
      (event.kind === 'fetch:end' || event.kind === 'fetch:error') &&
      event.fetchId !== undefined
    ) {
      fetchTerminals.set(event.fetchId, item)
    }
    for (const traceId of traceIdsForEvent(event, traceIndex)) {
      const related = traceEvents.get(traceId) ?? []
      related.push(item)
      traceEvents.set(traceId, related)
    }
  }
  return { fetchStarts, fetchTerminals, traceEvents }
}

function buildFetchActivities(
  queries: readonly QueryRecord[],
  model: DevtoolsModel,
  context: EventContext,
  nowPoint: number,
): TimelineActivity[] {
  return queries.flatMap(query =>
    query.spans.map((span, index) => {
      const start = span.fetchId === undefined ? undefined : context.fetchStarts.get(span.fetchId)
      const terminal =
        span.fetchId === undefined ? undefined : context.fetchTerminals.get(span.fetchId)
      const traceId = span.traceIds?.[0]
      const traceEvents = traceId === undefined ? [] : (context.traceEvents.get(traceId) ?? [])
      const terminalEvent = terminal?.event
      const failed = span.ok === false || terminalEvent?.kind === 'fetch:error'
      const pending = span.endAt === undefined
      const itemCount =
        terminalEvent?.kind === 'fetch:end'
          ? terminalEvent.itemCount
          : pending
            ? undefined
            : query.itemCount
      const durationMs =
        terminalEvent?.kind === 'fetch:end' || terminalEvent?.kind === 'fetch:error'
          ? terminalEvent.durationMs
          : (span.endAt ?? nowPoint) - span.startAt
      const scope = model.scopesByQueryId
        .get(query.queryId)
        ?.map(item => item.label)
        .join(', ')
      const effect = cacheEffect(
        traceEvents.filter(
          item => item.event.kind !== 'cache:updated' || item.event.source === 'fetch',
        ),
        failed ? '—' : 'cache refreshed',
      )
      const trigger = fetchTrigger(
        span.reason ?? (start?.event.kind === 'fetch:start' ? start.event.reason : undefined),
        start?.event.kind === 'fetch:start' ? start.event.causes : undefined,
      )
      const result = failed
        ? terminalEvent?.kind === 'fetch:error'
          ? terminalEvent.error.message
          : (query.lastError?.message ?? 'failed')
        : pending
          ? 'pending'
          : `${itemCount ?? 0} ${itemCount === 1 ? 'row' : 'rows'}`
      const payload =
        span.paramsState === 'retained'
          ? span.params
          : start?.event.kind === 'fetch:start' && start.payloadState !== 'evicted'
            ? start.event.params
            : undefined
      const payloadState: PayloadRetentionState | undefined =
        payload !== undefined
          ? 'retained'
          : span.paramsState === 'evicted' || start?.payloadState === 'evicted'
            ? 'evicted'
            : undefined
      const livePayload = query.method === 'get' ? query.resourceId : query.query
      return searchable({
        id: `fetch:${span.fetchId ?? `${query.queryId}:${span.startAt}:${index}`}`,
        kind: 'fetch',
        startAt: span.startAt,
        ...(span.endAt === undefined ? {} : { endAt: span.endAt }),
        label: query.serviceName,
        operation: query.method,
        detail: [query.resourceId === undefined ? '' : `#${query.resourceId}`, scope ?? '']
          .filter(Boolean)
          .join(' · '),
        status: failed ? 'error' : pending ? 'pending' : 'success',
        tone: failed ? 'red' : pending ? 'blue' : 'green',
        trigger,
        effect,
        result,
        serviceName: query.serviceName,
        queryId: query.queryId,
        ...(traceId === undefined ? {} : { traceId }),
        durationMs,
        ...(payload === undefined ? {} : { payload }),
        ...(payloadState ? { payloadState } : {}),
        ...(query.present && livePayload !== undefined ? { livePayload } : {}),
        ...(span.result === undefined ? {} : { data: span.result }),
        ...(span.resultState ? { dataState: span.resultState } : {}),
        ...(query.present && query.data !== undefined ? { liveData: query.data } : {}),
        error: failed,
      })
    }),
  )
}

function buildRealtimeActivities(
  snapshot: DevtoolsSnapshot,
  context: EventContext,
): TimelineActivity[] {
  return snapshot.timeline.realtime.map((item, index) => {
    const traceEvents =
      item.traceId === undefined ? [] : (context.traceEvents.get(item.traceId) ?? [])
    const queryIds = affectedQueryIds(traceEvents)
    const effect = cacheEffect(traceEvents, '—')
    const fetches = traceEvents.filter(related => related.event.kind === 'fetch:start').length
    const result = fetches > 0 ? `${fetches} ${fetches === 1 ? 'fetch' : 'fetches'} triggered` : '—'
    return searchable({
      id: `realtime:${item.at}:${item.serviceName}:${index}`,
      kind: 'realtime',
      startAt: item.at,
      endAt: item.at,
      label: item.serviceName,
      operation: normalizeRealtimeOperation(item.type),
      detail: item.itemId === undefined ? '' : `#${item.itemId}`,
      status: 'received',
      tone: 'blue',
      trigger: 'realtime event',
      effect,
      result,
      serviceName: item.serviceName,
      ...(queryIds.length > 0 ? { queryIds } : {}),
      ...(item.traceId === undefined ? {} : { traceId: item.traceId }),
      ...(item.itemId === undefined
        ? {}
        : { entity: { serviceName: item.serviceName, itemId: item.itemId } }),
      durationMs: 0,
      ...(item.payload === undefined ? {} : { payload: item.payload }),
      ...(item.payloadState ? { payloadState: item.payloadState } : {}),
      ...(item.itemId === undefined
        ? {}
        : {
            livePayload: cachedEntityValue(snapshot, item.serviceName, item.itemId),
          }),
      error: false,
    })
  })
}

function connectionActivity(
  at: number,
  event: Extract<FigbirdEvent, { kind: `connection:${string}` }>,
  index: number,
  context: EventContext,
): TimelineActivity {
  const failed =
    event.kind === 'connection:disconnected' ||
    event.kind === 'connection:error' ||
    event.kind === 'connection:reconnect-failed'
  const traceEvents =
    event.traceId === undefined ? [] : (context.traceEvents.get(event.traceId) ?? [])
  const sweep = traceEvents.find(item => item.event.kind === 'reconnect:sweep')?.event
  const fetches = traceEvents.filter(item => item.event.kind === 'fetch:start').length
  const operation = connectionOperation(event)
  const result = [
    'transport' in event ? (event.transport ?? '') : '',
    'attempt' in event && event.attempt !== undefined ? `attempt ${event.attempt}` : '',
    sweep?.kind === 'reconnect:sweep' && sweep.queryCount !== undefined
      ? `${sweep.queryCount} ${sweep.queryCount === 1 ? 'query swept' : 'queries swept'}`
      : '',
    fetches > 0 ? `${fetches} ${fetches === 1 ? 'fetch' : 'fetches'}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return searchable({
    id: `connection:${at}:${event.kind}:${index}`,
    kind: 'connection',
    startAt: at,
    endAt: at,
    label: 'socket',
    operation,
    detail: connectionDetail(event),
    status:
      event.kind === 'connection:disconnected'
        ? event.reconnecting
          ? 'reconnecting'
          : 'offline'
        : failed
          ? 'error'
          : 'connected',
    tone:
      event.kind === 'connection:disconnected' && event.reconnecting
        ? 'blue'
        : failed
          ? 'red'
          : 'green',
    trigger: 'transport',
    effect: '—',
    result: result || '—',
    ...(event.traceId === undefined ? {} : { traceId: event.traceId }),
    durationMs: 0,
    payload: displayEvent(event),
    error: failed,
  })
}

function buildWriteActivities(
  writes: readonly WriteRecord[],
  snapshot: DevtoolsSnapshot,
): TimelineActivity[] {
  const mutations = writes.filter(write => write.type === 'mutation')
  const collapsedActionIds = new Set<string>()
  const actionByMutationId = new Map<string, WriteRecord>()
  const actions = writes
    .filter(
      write => write.type === 'action' && write.status === 'success' && write.endedAt !== undefined,
    )
    .sort((a, b) => (a.durationMs ?? Infinity) - (b.durationMs ?? Infinity))

  for (const action of actions) {
    const candidates = mutations.filter(mutation => actionContainsMutation(action, mutation))
    if (candidates.length !== 1) continue

    const mutation = candidates[0]!
    if (actionByMutationId.has(mutation.id)) continue
    collapsedActionIds.add(action.id)
    actionByMutationId.set(mutation.id, action)
  }

  return writes
    .filter(write => !collapsedActionIds.has(write.id))
    .map(write => writeActivity(write, snapshot, actionByMutationId.get(write.id)))
}

function actionContainsMutation(action: WriteRecord, mutation: WriteRecord): boolean {
  if (action.endedAt === undefined) return false
  if (mutation.startedAt < action.startedAt) return false
  if (mutation.startedAt - action.startedAt > ACTION_WRAPPER_START_TOLERANCE_MS) return false
  return (mutation.endedAt ?? Infinity) <= action.endedAt
}

function writeActivity(
  write: WriteRecord,
  snapshot: DevtoolsSnapshot,
  initiatingAction?: WriteRecord,
): TimelineActivity {
  const failed = write.status === 'error' || write.status === 'rollback'
  const status =
    write.status === 'in-flight'
      ? 'pending'
      : write.status === 'rollback'
        ? 'rolled back'
        : write.status
  const label =
    write.type === 'action'
      ? (write.name ?? '(anonymous action)')
      : (write.serviceName ?? 'mutation')
  const operation = write.type === 'action' ? 'action' : (write.method ?? 'mutate')
  const actionName = initiatingAction?.name ?? (initiatingAction ? '(anonymous action)' : undefined)
  return searchable({
    id: `write:${write.id}`,
    kind: 'write',
    startAt: write.startedAt,
    ...(write.endedAt === undefined ? {} : { endAt: write.endedAt }),
    label,
    operation,
    detail:
      write.type === 'mutation'
        ? [
            write.itemId === undefined ? '' : `#${write.itemId}`,
            actionName ? `${actionName} action` : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : '',
    status,
    tone: failed ? 'red' : write.status === 'in-flight' ? 'blue' : 'green',
    trigger: initiatingAction || write.type === 'action' ? 'action' : 'UI mutation',
    effect: write.optimistic ? (write.rolledBack ? 'rolled back' : 'projected') : '—',
    result:
      write.error ??
      (write.status === 'in-flight'
        ? 'pending'
        : write.status === 'rollback'
          ? 'rolled back'
          : 'complete'),
    ...(write.serviceName === undefined ? {} : { serviceName: write.serviceName }),
    ...(write.serviceName === undefined || write.itemId === undefined
      ? {}
      : { entity: { serviceName: write.serviceName, itemId: write.itemId } }),
    ...(write.traceId === undefined ? {} : { traceId: write.traceId }),
    ...(write.durationMs === undefined ? {} : { durationMs: write.durationMs }),
    ...(write.serviceName === undefined || write.itemId === undefined
      ? {}
      : {
          livePayload: cachedEntityValue(snapshot, write.serviceName, write.itemId),
        }),
    write: {
      id: write.id,
      type: write.type,
      optimistic: write.optimistic ?? false,
      payload: writePayload(write),
      args: write.args ?? [],
      ...(write.argsState ? { argsState: write.argsState } : {}),
      ...(initiatingAction && actionName
        ? {
            initiatingAction: {
              id: initiatingAction.id,
              name: actionName,
              ...(initiatingAction.durationMs === undefined
                ? {}
                : { durationMs: initiatingAction.durationMs }),
            },
          }
        : {}),
    },
    error: failed,
  })
}

function writePayload(write: WriteRecord): unknown {
  const args = write.args
  if (!args || args.length === 0) return undefined
  if (write.type === 'action') return args.length === 1 ? args[0] : args
  if (write.method === 'create') return args[0]
  if (write.method === 'update' || write.method === 'patch') return args[1]
  if (write.method === 'remove') return undefined
  return args.length === 1 ? args[0] : args
}

function cacheEffect(events: readonly DevtoolsEvent[], fallback: string): string {
  const outcomes = new Map<string, 'merged' | 'reconcile'>()
  let updated = false
  for (const item of events) {
    if (item.event.kind !== 'cache:updated') continue
    updated = true
    for (const effect of item.event.queryEffects) outcomes.set(effect.queryId, effect.outcome)
  }
  const merged = [...outcomes.values()].filter(outcome => outcome === 'merged').length
  const reconcile = [...outcomes.values()].filter(outcome => outcome === 'reconcile').length
  return (
    [
      merged > 0 ? `${merged} ${merged === 1 ? 'query updated' : 'queries updated'}` : '',
      reconcile > 0
        ? `${reconcile} ${reconcile === 1 ? 'refetch scheduled' : 'refetches scheduled'}`
        : '',
      merged === 0 && reconcile === 0 && updated ? 'cache refreshed' : '',
    ]
      .filter(Boolean)
      .join(' · ') || fallback
  )
}

function fetchTrigger(
  reason: string | undefined,
  causes: readonly { kind: string }[] | undefined,
): string {
  if (reason) return reason.replace('-', ' ')
  const cause = causes?.[0]?.kind
  return cause ? cause.replace('-', ' ') : 'request'
}

function affectedQueryIds(events: readonly DevtoolsEvent[]): string[] {
  const ids = new Set<string>()
  for (const item of events) {
    if (item.event.kind !== 'cache:updated') continue
    for (const effect of item.event.queryEffects) ids.add(effect.queryId)
  }
  return [...ids]
}

function normalizeRealtimeOperation(type: string | undefined): string {
  switch (type) {
    case 'created':
      return 'create'
    case 'updated':
      return 'update'
    case 'patched':
      return 'patch'
    case 'removed':
      return 'remove'
    default:
      return type ?? 'event'
  }
}

function connectionOperation(
  event: Extract<FigbirdEvent, { kind: `connection:${string}` }>,
): string {
  switch (event.kind) {
    case 'connection:connected':
      return 'connected'
    case 'connection:disconnected':
      return 'disconnected'
    case 'connection:reconnected':
      return 'reconnected'
    case 'connection:error':
      return event.phase === 'connect' ? 'connect error' : 'reconnect error'
    case 'connection:reconnect-failed':
      return 'reconnect failed'
  }
}

function connectionDetail(event: Extract<FigbirdEvent, { kind: `connection:${string}` }>): string {
  switch (event.kind) {
    case 'connection:connected':
    case 'connection:reconnected':
      return ['transport' in event ? event.transport : '', event.connectionId ?? '']
        .filter(Boolean)
        .join(' · ')
    case 'connection:disconnected':
      return event.reason ?? 'connection lost'
    case 'connection:error':
      return event.error.message
    case 'connection:reconnect-failed':
      return event.error?.message ?? 'attempts exhausted'
  }
}

function searchable(activity: Omit<TimelineActivity, 'searchText'>): TimelineActivity {
  return {
    ...activity,
    searchText: [
      activity.kind,
      activity.label,
      activity.operation,
      activity.detail,
      activity.status,
      activity.trigger,
      activity.effect,
      activity.result,
      activity.serviceName ?? '',
      activity.queryId ?? '',
      ...(activity.queryIds ?? []),
      activity.traceId === undefined ? '' : String(activity.traceId),
      activity.entity ? String(activity.entity.itemId) : '',
      activity.write?.id ?? '',
      activity.durationMs === undefined ? '' : formatMs(activity.durationMs),
    ]
      .join(' ')
      .toLowerCase(),
  }
}

export function timelineActivityMatchesFilter(
  activity: TimelineActivity,
  normalizedFilter: string,
): boolean {
  if (!normalizedFilter) return true
  if (activity.searchText.includes(normalizedFilter)) return true
  return [
    activity.payload,
    activity.data,
    activity.livePayload,
    activity.liveData,
    activity.write?.args,
  ].some(
    value => value !== undefined && compactJson(value).toLowerCase().includes(normalizedFilter),
  )
}

function cachedEntityValue(
  snapshot: DevtoolsSnapshot,
  serviceName: string,
  itemId: string | number,
): unknown {
  return snapshot.cache
    ?.find(service => service.serviceName === serviceName)
    ?.entities.find(entity => entity.id === String(itemId))?.value
}
