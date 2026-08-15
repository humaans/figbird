import type { FigbirdEvent } from '../core/events.js'
import type { DevtoolsEvent, DevtoolsSnapshot, QueryRecord, WriteRecord } from './collector.js'
import { buildTraceIndex, displayEvent, traceIdsForEvent } from './eventModel.js'
import { formatMs } from './format.js'
import type { DevtoolsModel } from './model.js'

export type TimelineActivityKind = 'fetch' | 'realtime' | 'connection' | 'write'
export type TimelineActivityTone = 'green' | 'amber' | 'red' | 'blue' | 'neutral'

export interface TimelineActivity {
  id: string
  kind: TimelineActivityKind
  startAt: number
  endAt?: number
  label: string
  detail: string
  status: string
  tone: TimelineActivityTone
  trigger: string
  effect: string
  result: string
  serviceName?: string
  queryId?: string
  traceId?: number
  durationMs?: number
  payload?: unknown
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
    ...snapshot.writes
      .filter(write => write.startedAt >= snapshot.timeline.startedAt)
      .map(writeActivity),
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
  realtime: ReadonlyMap<string, DevtoolsEvent>
  traceEvents: ReadonlyMap<number, readonly DevtoolsEvent[]>
}

function buildEventContext(events: readonly DevtoolsEvent[]): EventContext {
  const traceIndex = buildTraceIndex(events)
  const fetchStarts = new Map<number, DevtoolsEvent>()
  const fetchTerminals = new Map<number, DevtoolsEvent>()
  const realtime = new Map<string, DevtoolsEvent>()
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
    if (event.kind === 'realtime') realtime.set(realtimeKey(item.at, event.serviceName), item)
    for (const traceId of traceIdsForEvent(event, traceIndex)) {
      const related = traceEvents.get(traceId) ?? []
      related.push(item)
      traceEvents.set(traceId, related)
    }
  }
  return { fetchStarts, fetchTerminals, realtime, traceEvents }
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
        failed ? '' : 'cache refreshed',
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
        start?.event.kind === 'fetch:start'
          ? start.event.params
          : query.method === 'get'
            ? query.resourceId
            : query.query
      return searchable({
        id: `fetch:${span.fetchId ?? `${query.queryId}:${span.startAt}:${index}`}`,
        kind: 'fetch',
        startAt: span.startAt,
        ...(span.endAt === undefined ? {} : { endAt: span.endAt }),
        label: `${query.serviceName}.${query.method}`,
        detail: [query.resourceId === undefined ? '' : `#${query.resourceId}`, scope ?? '']
          .filter(Boolean)
          .join(' · '),
        status: failed ? 'failed' : pending ? 'fetching' : 'complete',
        tone: failed ? 'red' : pending ? 'blue' : 'green',
        trigger,
        effect,
        result,
        serviceName: query.serviceName,
        queryId: query.queryId,
        ...(traceId === undefined ? {} : { traceId }),
        durationMs,
        ...(payload === undefined ? {} : { payload }),
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
    const raw = context.realtime.get(realtimeKey(item.at, item.serviceName))
    const event = raw?.event.kind === 'realtime' ? raw.event : undefined
    const traceEvents =
      item.traceId === undefined ? [] : (context.traceEvents.get(item.traceId) ?? [])
    const effect = cacheEffect(traceEvents, 'received')
    const fetches = traceEvents.filter(related => related.event.kind === 'fetch:start').length
    const result = [
      event?.type ?? 'event',
      event?.itemId === undefined ? '' : `#${event.itemId}`,
      fetches > 0 ? `${fetches} ${fetches === 1 ? 'fetch' : 'fetches'} triggered` : '',
    ]
      .filter(Boolean)
      .join(' · ')
    return searchable({
      id: `realtime:${item.at}:${item.serviceName}:${index}`,
      kind: 'realtime',
      startAt: item.at,
      endAt: item.at,
      label: `${item.serviceName} realtime`,
      detail: event ? `${event.type}${event.itemId === undefined ? '' : ` #${event.itemId}`}` : '',
      status: 'received',
      tone: 'blue',
      trigger: 'socket event',
      effect,
      result,
      serviceName: item.serviceName,
      ...(item.traceId === undefined ? {} : { traceId: item.traceId }),
      durationMs: 0,
      ...(event?.item === undefined ? {} : { payload: event.item }),
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
  const status = connectionStatus(event)
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
    label: status,
    detail: connectionDetail(event),
    status: failed
      ? event.kind === 'connection:disconnected'
        ? 'offline'
        : 'failed'
      : 'connected',
    tone: failed ? 'red' : 'green',
    trigger: 'transport',
    effect: sweep?.kind === 'reconnect:sweep' ? `reconnect sweep ${sweep.phase}` : '—',
    result: result || '—',
    ...(event.traceId === undefined ? {} : { traceId: event.traceId }),
    durationMs: 0,
    payload: displayEvent(event),
    error: failed,
  })
}

function writeActivity(write: WriteRecord): TimelineActivity {
  const failed = write.status === 'error' || write.status === 'rollback'
  const label =
    write.type === 'action'
      ? (write.name ?? '(anonymous action)')
      : `${write.serviceName ?? ''}.${write.method ?? ''}${write.itemId === undefined ? '' : ` #${write.itemId}`}`
  return searchable({
    id: `write:${write.id}`,
    kind: 'write',
    startAt: write.startedAt,
    ...(write.endedAt === undefined ? {} : { endAt: write.endedAt }),
    label,
    detail: write.type,
    status: write.status,
    tone: failed ? 'red' : write.status === 'in-flight' ? 'amber' : 'green',
    trigger: write.type === 'action' ? 'action' : 'UI mutation',
    effect: write.optimistic
      ? write.rolledBack
        ? 'optimistic rollback'
        : 'optimistic cache'
      : '—',
    result: write.error ?? (write.status === 'in-flight' ? 'pending' : 'complete'),
    ...(write.serviceName === undefined ? {} : { serviceName: write.serviceName }),
    ...(write.traceId === undefined ? {} : { traceId: write.traceId }),
    ...(write.durationMs === undefined ? {} : { durationMs: write.durationMs }),
    ...(write.args === undefined ? {} : { payload: write.args }),
    error: failed,
  })
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
      merged > 0 ? `${merged} merged` : '',
      reconcile > 0 ? `${reconcile} reconcile` : '',
      merged === 0 && reconcile === 0 && updated ? 'cache updated' : '',
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

function connectionStatus(event: Extract<FigbirdEvent, { kind: `connection:${string}` }>): string {
  switch (event.kind) {
    case 'connection:connected':
      return 'Connected'
    case 'connection:disconnected':
      return 'Disconnected'
    case 'connection:reconnected':
      return 'Reconnected'
    case 'connection:error':
      return event.phase === 'connect' ? 'Connection error' : 'Reconnect error'
    case 'connection:reconnect-failed':
      return 'Reconnection failed'
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

function realtimeKey(at: number, serviceName: string): string {
  return `${at}:${serviceName}`
}

function searchable(activity: Omit<TimelineActivity, 'searchText'>): TimelineActivity {
  return {
    ...activity,
    searchText: [
      activity.kind,
      activity.label,
      activity.detail,
      activity.status,
      activity.trigger,
      activity.effect,
      activity.result,
      activity.durationMs === undefined ? '' : formatMs(activity.durationMs),
    ]
      .join(' ')
      .toLowerCase(),
  }
}
