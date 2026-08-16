import type { FigbirdEvent } from '../core/events.js'
import type { QueryGraphRef } from '../core/queryTypes.js'
import type {
  DevtoolsSnapshot,
  QueryRecord,
  TimelineTraceSummary,
  WriteRecord,
} from './collector.js'
import {
  EVICTED_VALUE,
  historicalValue,
  retainedValue,
  type HistoricalValue,
} from './historicalValue.js'
import { displayEvent } from './eventModel.js'
import { compactJson, formatMs } from './format.js'
import type { DevtoolsModel } from './model.js'

export type TimelineActivityKind = 'fetch' | 'realtime' | 'connection' | 'write'
export type TimelineActivityTone = 'green' | 'amber' | 'red' | 'blue' | 'neutral'

export interface TimelineGraphRef extends QueryGraphRef {
  operationLabel: string
}

const ACTION_WRAPPER_START_TOLERANCE_MS = 10

export interface TimelineActivity {
  id: string
  kind: TimelineActivityKind
  startAt: number
  endAt?: number
  label: string
  operation: string
  detail: string
  detailTooltip?: string
  status: string
  tone: TimelineActivityTone
  trigger: string
  effect: string
  result: string
  serviceName?: string
  queryId?: string
  queryIds?: string[]
  graph?: readonly TimelineGraphRef[]
  traceId?: number
  entity?: { serviceName: string; itemId: string | number }
  durationMs?: number
  payload?: HistoricalValue
  livePayload?: unknown
  data?: HistoricalValue
  liveData?: unknown
  errorDetails?: HistoricalValue
  write?: {
    id: string
    type: WriteRecord['type']
    optimistic: boolean
    payload?: HistoricalValue
    args?: HistoricalValue<readonly unknown[]>
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
  const traces = new Map(snapshot.timeline.traces.map(trace => [trace.traceId, trace]))
  const activities = [
    ...buildFetchActivities(snapshot.queries, model, nowPoint),
    ...buildRealtimeActivities(snapshot, traces),
    ...snapshot.timeline.connection.map((item, index) =>
      connectionActivity(item.at, item.event, index, traces),
    ),
    ...buildWriteActivities(
      snapshot.writes.filter(write => write.startedAt >= snapshot.timeline.startedAt),
      snapshot,
    ),
  ]
  return activities.sort(compareTimelineActivities)
}

function compareTimelineActivities(first: TimelineActivity, second: TimelineActivity): number {
  const startMillisecond = Math.round(first.startAt) - Math.round(second.startAt)
  if (startMillisecond !== 0) return first.startAt - second.startAt

  if (first.kind === 'fetch' && second.kind === 'fetch') {
    const rootPriority = Number(!isRootFetch(first)) - Number(!isRootFetch(second))
    if (rootPriority !== 0) return rootPriority

    const firstSequence = fetchSequence(first)
    const secondSequence = fetchSequence(second)
    if (firstSequence !== undefined && secondSequence !== undefined) {
      const sequence = firstSequence - secondSequence
      if (sequence !== 0) return sequence
    }
  }

  const kindPriority = timelineKindPriority(first.kind) - timelineKindPriority(second.kind)
  if (kindPriority !== 0) return kindPriority

  return first.startAt - second.startAt || first.id.localeCompare(second.id)
}

function timelineKindPriority(kind: TimelineActivityKind): number {
  switch (kind) {
    case 'fetch':
      return 0
    case 'realtime':
      return 1
    case 'connection':
      return 2
    case 'write':
      return 3
  }
}

function isRootFetch(activity: TimelineActivity): boolean {
  if (activity.kind !== 'fetch') return false
  if (activity.graph?.some(ref => ref.path === '(root)')) return true
  return activity.detail
    .split(' · ')
    .flatMap(part => part.split(','))
    .some(part => part.trim() === 'root')
}

function fetchSequence(activity: TimelineActivity): number | undefined {
  const match = /^fetch:(\d+)$/.exec(activity.id)
  return match ? Number(match[1]) : undefined
}

export function timelineExtent(
  activities: readonly TimelineActivity[],
  _startedAt: number,
  nowPoint: number,
): TimelineExtent | null {
  if (activities.length === 0) return null
  const earliest = Math.min(...activities.map(activity => activity.startAt))
  const latest = Math.max(...activities.map(activity => activity.endAt ?? nowPoint))
  const start = earliest
  return { start, end: Math.max(start + 1_000, latest) }
}

function buildFetchActivities(
  queries: readonly QueryRecord[],
  model: DevtoolsModel,
  nowPoint: number,
): TimelineActivity[] {
  const operationLabels = new Map(
    model.operations.map(operation => [
      operation.key,
      operation.composition?.operation ??
        `${operation.summary.serviceName}.${operation.summary.method}`,
    ]),
  )
  return queries.flatMap(query =>
    query.spans.map((span, index) => {
      const traceId = span.traceIds?.[0]
      const failed = span.ok === false
      const pending = span.endAt === undefined
      const itemCount = pending ? undefined : (span.itemCount ?? query.itemCount)
      const durationMs = span.durationMs ?? Math.max(0, (span.endAt ?? nowPoint) - span.startAt)
      const scopes = model.scopesByQueryId.get(query.queryId) ?? []
      const scope = [...new Set(scopes.map(item => normalizeScopeLabel(item.label)))].join(', ')
      const scopeTooltip =
        scopes.length > 1
          ? [
              `Shared by ${scopes.length} query operations`,
              ...new Set(scopes.map(item => item.title)),
            ].join('\n')
          : undefined
      const effect = failed ? '—' : 'cache refreshed'
      const trigger = fetchTrigger(span.reason, span.causeKinds)
      const result = failed
        ? (query.lastError?.message ?? 'failed')
        : pending
          ? 'pending'
          : `${itemCount ?? 0} ${itemCount === 1 ? 'row' : 'rows'}`
      const payload = span.params
      const livePayload = query.method === 'get' ? query.resourceId : query.query
      const capturedErrorDetails = span.errorDetails
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
        ...(scopeTooltip ? { detailTooltip: scopeTooltip } : {}),
        status: failed ? 'error' : pending ? 'pending' : 'success',
        tone: failed ? 'red' : pending ? 'blue' : 'green',
        trigger,
        effect,
        result,
        serviceName: query.serviceName,
        queryId: query.queryId,
        ...(span.graph && span.graph.length > 0
          ? {
              graph: span.graph.map(ref => ({
                ...ref,
                operationLabel: operationLabels.get(ref.operationId) ?? ref.operationId,
              })),
            }
          : {}),
        ...(traceId === undefined ? {} : { traceId }),
        durationMs,
        ...(payload === undefined ? {} : { payload }),
        ...(query.present && livePayload !== undefined ? { livePayload } : {}),
        ...(span.result === undefined ? {} : { data: span.result }),
        ...(query.present && query.data !== undefined ? { liveData: query.data } : {}),
        ...(capturedErrorDetails === undefined ? {} : { errorDetails: capturedErrorDetails }),
        error: failed,
      })
    }),
  )
}

function normalizeScopeLabel(label: string): string {
  const parts = label
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
  return [...new Set(parts)].join(', ')
}

function buildRealtimeActivities(
  snapshot: DevtoolsSnapshot,
  traces: ReadonlyMap<number, TimelineTraceSummary>,
): TimelineActivity[] {
  return snapshot.timeline.realtime.map((item, index) => {
    const trace = item.traceId === undefined ? undefined : traces.get(item.traceId)
    const queryIds = trace?.queryIds ?? []
    const effect = cacheEffect(trace, '—')
    const fetches = trace?.fetches ?? 0
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
  traces: ReadonlyMap<number, TimelineTraceSummary>,
): TimelineActivity {
  const failed =
    event.kind === 'connection:disconnected' ||
    event.kind === 'connection:error' ||
    event.kind === 'connection:reconnect-failed'
  const trace = event.traceId === undefined ? undefined : traces.get(event.traceId)
  const fetches = trace?.fetches ?? 0
  const operation = connectionOperation(event)
  const result = [
    'transport' in event ? (event.transport ?? '') : '',
    'attempt' in event && event.attempt !== undefined ? `attempt ${event.attempt}` : '',
    trace?.sweptQueries !== undefined
      ? `${trace.sweptQueries} ${trace.sweptQueries === 1 ? 'query swept' : 'queries swept'}`
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
    payload: retainedValue(displayEvent(event)),
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
  const payload = writePayload(write)
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
    ...(write.errorDetails === undefined ? {} : { errorDetails: write.errorDetails }),
    ...(write.serviceName === undefined || write.itemId === undefined
      ? {}
      : {
          livePayload: cachedEntityValue(snapshot, write.serviceName, write.itemId),
        }),
    write: {
      id: write.id,
      type: write.type,
      optimistic: write.optimistic ?? false,
      ...(payload ? { payload } : {}),
      ...(write.args ? { args: write.args } : {}),
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

function writePayload(write: WriteRecord): HistoricalValue | undefined {
  if (!write.args) return undefined
  if (write.args.state === 'evicted') return EVICTED_VALUE
  const args = write.args.value
  if (args.length === 0) return undefined
  if (write.type === 'action') return retainedValue(args.length === 1 ? args[0] : args)
  if (write.method === 'create') return retainedValue(args[0])
  if (write.method === 'update' || write.method === 'patch') return retainedValue(args[1])
  if (write.method === 'remove') return undefined
  return retainedValue(args.length === 1 ? args[0] : args)
}

function cacheEffect(trace: TimelineTraceSummary | undefined, fallback: string): string {
  const merged = trace?.mergedQueries ?? 0
  const reconcile = trace?.reconciledQueries ?? 0
  return (
    [
      merged > 0 ? `${merged} ${merged === 1 ? 'query updated' : 'queries updated'}` : '',
      reconcile > 0
        ? `${reconcile} ${reconcile === 1 ? 'refetch scheduled' : 'refetches scheduled'}`
        : '',
      merged === 0 && reconcile === 0 && trace?.cacheUpdated ? 'cache refreshed' : '',
    ]
      .filter(Boolean)
      .join(' · ') || fallback
  )
}

function fetchTrigger(
  reason: string | undefined,
  causeKinds: readonly string[] | undefined,
): string {
  if (reason) return reason.replace('-', ' ')
  return causeKinds?.[0]?.replace('-', ' ') ?? 'request'
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
    historicalValue(activity.payload),
    historicalValue(activity.data),
    activity.livePayload,
    activity.liveData,
    historicalValue(activity.write?.args),
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
