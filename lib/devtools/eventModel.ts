import type { DevtoolsEvent } from './collector.js'
import { compactJson, formatClock, formatMs } from './format.js'
import type { EventQueryScope } from './model.js'

export interface TraceIndex {
  byFetchId: ReadonlyMap<number, readonly number[]>
}

export interface EventListRow {
  key: string
  representative: DevtoolsEvent
  kind: string
  subject: string
  operation: string
  status: string
  tone: 'green' | 'amber' | 'red' | 'blue' | 'neutral'
  details: string
  queryId?: string
  traceId?: number
}

export interface ActivityRow extends EventListRow {
  events: DevtoolsEvent[]
  searchText: string
}

export function eventPayload(event: DevtoolsEvent['event']): unknown {
  switch (event.kind) {
    case 'realtime':
      return event.item
    case 'cache:updated':
      return { before: event.previousItem, after: event.item, queries: event.queryEffects }
    case 'fetch:start':
      return event.params
    case 'mutate:start':
    case 'mutate:update':
    case 'action:start':
      return event.args
    case 'fetch:error':
    case 'mutate:error':
    case 'action:error':
    case 'connection:error':
      return { name: event.error.name, message: event.error.message }
    case 'connection:connected':
    case 'connection:disconnected':
    case 'connection:reconnected':
    case 'connection:reconnect-failed':
    case 'reconnect:sweep':
    case 'reconcile:decision':
    case 'reconcile:started':
      return displayEvent(event)
    default:
      return undefined
  }
}

export function eventPayloadLabel(event: DevtoolsEvent['event']): string {
  switch (event.kind) {
    case 'fetch:start':
      return 'Parameters'
    case 'fetch:end':
      return 'Fetch result'
    case 'mutate:start':
    case 'mutate:update':
    case 'action:start':
      return 'Arguments'
    case 'mutate:end':
    case 'mutate:rollback':
      return 'Mutation result'
    case 'action:end':
      return 'Action result'
    case 'realtime':
      return 'Realtime payload'
    case 'fetch:error':
    case 'mutate:error':
    case 'action:error':
    case 'connection:error':
    case 'connection:reconnect-failed':
      return 'Error'
    case 'connection:connected':
    case 'connection:disconnected':
    case 'connection:reconnected':
    case 'reconnect:sweep':
      return 'Connection event'
    case 'cache:updated':
      return 'Cache change'
    case 'reconcile:decision':
    case 'reconcile:started':
      return 'Reconciliation event'
    default:
      return 'Instrumentation data'
  }
}

export function displayEvent(event: DevtoolsEvent['event']): unknown {
  if ('error' in event && event.error) {
    return { ...event, error: { name: event.error.name, message: event.error.message } }
  }
  return event
}

export function rawEventRow(item: DevtoolsEvent, index: TraceIndex): EventListRow {
  const queryId = eventQueryId(item.event)
  const traceId = traceIdsForEvent(item.event, index)[0]
  return {
    key: `event:${item.id}`,
    representative: item,
    kind: item.event.kind,
    subject: eventSubject(item.event),
    operation: eventOperation(item.event),
    ...eventStatus(item.event),
    details: eventDetails(item),
    ...(queryId === undefined ? {} : { queryId }),
    ...(traceId === undefined ? {} : { traceId }),
  }
}

export function buildActivities(
  events: readonly DevtoolsEvent[],
  index: TraceIndex,
  scopes?: ReadonlyMap<string, readonly EventQueryScope[]>,
): ActivityRow[] {
  const grouped = new Map<string, { traceId?: number; events: DevtoolsEvent[] }>()
  for (const item of events) {
    const traceIds = traceIdsForEvent(item.event, index)
    const add = (key: string, traceId?: number) => {
      const group = grouped.get(key) ?? {
        ...(traceId === undefined ? {} : { traceId }),
        events: [],
      }
      group.events.push(item)
      grouped.set(key, group)
    }
    if (traceIds.length > 0) {
      for (const traceId of traceIds) add(`trace:${traceId}`, traceId)
    } else {
      add(activityGroupKey(item))
    }
  }

  return [...grouped.entries()]
    .map(([key, group]) => {
      const representative = activityRepresentative(group.events)
      const kind = activityKind(key, representative)
      const details = activityDetails(key, representative, group.events)
      const identity = activityIdentity(key, representative.event)
      const lifecycle = activityStatus(key, group.events)
      const queryId = group.events.map(item => eventQueryId(item.event)).find(Boolean)
      return {
        key,
        representative,
        events: group.events,
        kind,
        ...identity,
        ...lifecycle,
        details,
        searchText: [
          kind,
          identity.subject,
          identity.operation,
          lifecycle.status,
          details,
          ...group.events.map(item =>
            eventSearchText(item, scopes?.get(eventQueryId(item.event) ?? '')),
          ),
        ]
          .join(' ')
          .toLowerCase(),
        ...(queryId === undefined ? {} : { queryId }),
        ...(group.traceId === undefined ? {} : { traceId: group.traceId }),
      }
    })
    .sort((a, b) => b.representative.wallAt - a.representative.wallAt)
}

function activityGroupKey(item: DevtoolsEvent): string {
  const event = item.event
  if (isMutationEvent(event)) return `mutation:${event.mutationId}`
  switch (event.kind) {
    case 'action:start':
    case 'action:end':
    case 'action:error':
      return `action:${event.actionId}`
    default:
      return `event:${item.id}`
  }
}

function activityRepresentative(events: readonly DevtoolsEvent[]): DevtoolsEvent {
  const start = events.find(
    item => item.event.kind === 'mutate:start' || item.event.kind === 'action:start',
  )
  if (start) return start

  const connection = events.find(item => item.event.kind.startsWith('connection:'))
  if (connection) return connection

  const mutationCache = events.find(
    item =>
      item.event.kind === 'cache:updated' &&
      (item.event.source === 'mutation' || item.event.source === 'optimistic'),
  )
  if (mutationCache) return mutationCache

  return (
    events.find(item => item.event.kind === 'realtime') ??
    events.find(item => item.event.kind === 'cache:updated' && item.event.source === 'devtools') ??
    events.find(item => item.event.kind === 'fetch:start') ??
    events.find(item => item.event.kind === 'cache:updated') ??
    events[0]!
  )
}

function activityKind(key: string, representative: DevtoolsEvent): string {
  if (isMutationEvent(representative.event) || key.startsWith('mutation:')) return 'mutation'
  if (key.startsWith('action:') || representative.event.kind === 'action:start') return 'action'
  const event = representative.event
  if (event.kind.startsWith('connection:')) return 'connection'
  if (event.kind.startsWith('fetch:')) return 'fetch'
  if (event.kind.startsWith('reconcile:')) return 'reconcile'
  if (event.kind === 'cache:updated') {
    if (event.source === 'devtools') return 'cache edit'
    if (event.source === 'optimistic') return 'optimistic'
    if (event.source === 'mutation') return 'mutation cache'
    return 'cache'
  }
  return event.kind
}

function activityDetails(
  key: string,
  representative: DevtoolsEvent,
  events: readonly DevtoolsEvent[],
): string {
  if (isMutationEvent(representative.event) || key.startsWith('mutation:')) {
    return mutationActivityDetails(representative, events)
  }
  if (key.startsWith('action:') || representative.event.kind === 'action:start') {
    return actionActivityDetails(representative, events)
  }

  const event = representative.event
  if (event.kind.startsWith('connection:')) {
    const sweep = events.find(item => item.event.kind === 'reconnect:sweep')?.event
    const fetches = events.filter(
      item => item.event.kind === 'fetch:end' || item.event.kind === 'fetch:error',
    ).length
    return joinEventParts([
      eventDetails(representative),
      sweep?.kind === 'reconnect:sweep' && sweep.queryCount !== undefined
        ? pluralActivity(sweep.queryCount, 'query swept', 'queries swept')
        : '',
      fetches > 0 ? pluralActivity(fetches, 'fetch', 'fetches') : '',
    ])
  }

  if (event.kind === 'realtime') {
    const effects = activityQueryEffects(events)
    const fetches = events.filter(item => item.event.kind === 'fetch:start').length
    return joinEventParts([
      `${event.serviceName} ${event.type}${event.itemId === undefined ? '' : ` #${event.itemId}`}`,
      effects.merged > 0 ? pluralActivity(effects.merged, 'query updated', 'queries updated') : '',
      effects.reconcile > 0
        ? pluralActivity(effects.reconcile, 'refetch scheduled', 'refetches scheduled')
        : '',
      fetches > 0 ? pluralActivity(fetches, 'fetch', 'fetches') : '',
    ])
  }

  if (event.kind === 'cache:updated') {
    const effects = activityQueryEffects(events)
    return joinEventParts([
      `${event.serviceName} #${event.itemId}`,
      event.source === 'devtools'
        ? 'edited in memory'
        : event.source === 'optimistic'
          ? 'optimistic cache update'
          : event.source === 'mutation'
            ? 'mutation applied to cache'
            : `${event.source} cache update`,
      effects.merged > 0 ? pluralActivity(effects.merged, 'query updated', 'queries updated') : '',
      effects.reconcile > 0
        ? pluralActivity(effects.reconcile, 'refetch scheduled', 'refetches scheduled')
        : '',
    ])
  }

  if (event.kind === 'fetch:start') {
    const terminal = [...events]
      .reverse()
      .find(item => item.event.kind === 'fetch:end' || item.event.kind === 'fetch:error')
    const attempts = events.filter(item => item.event.kind === 'fetch:start').length
    return joinEventParts([
      `${event.serviceName}.${event.method}`,
      event.reason ?? '',
      terminal?.event.kind === 'fetch:end'
        ? pluralActivity(terminal.event.itemCount, 'row', 'rows')
        : terminal?.event.kind === 'fetch:error'
          ? errorMessage(terminal.event.error)
          : '',
      terminal?.event.kind === 'fetch:end' || terminal?.event.kind === 'fetch:error'
        ? formatMs(terminal.event.durationMs)
        : '',
      attempts > 1 ? pluralActivity(attempts - 1, 'retry', 'retries') : '',
    ])
  }

  return eventDetails(representative)
}

function activityQueryEffects(events: readonly DevtoolsEvent[]): {
  merged: number
  reconcile: number
} {
  const outcomes = new Map<string, 'merged' | 'reconcile'>()
  for (const item of events) {
    if (item.event.kind !== 'cache:updated') continue
    for (const effect of item.event.queryEffects) outcomes.set(effect.queryId, effect.outcome)
  }
  return {
    merged: [...outcomes.values()].filter(outcome => outcome === 'merged').length,
    reconcile: [...outcomes.values()].filter(outcome => outcome === 'reconcile').length,
  }
}

function mutationActivityDetails(
  representative: DevtoolsEvent,
  events: readonly DevtoolsEvent[],
): string {
  if (representative.event.kind !== 'mutate:start') return eventDetails(representative)
  const start = representative.event
  const terminal = [...events]
    .reverse()
    .find(
      item =>
        item.event.kind === 'mutate:end' ||
        item.event.kind === 'mutate:error' ||
        item.event.kind === 'mutate:rollback',
    )
  return joinEventParts([
    `${start.serviceName}.${start.method}${start.id === undefined ? '' : ` #${start.id}`}`,
    start.optimistic ? 'optimistic' : 'confirmed',
    terminal?.event.kind === 'mutate:error'
      ? errorMessage(terminal.event.error)
      : terminal?.event.kind === 'mutate:rollback'
        ? 'rolled back'
        : terminal?.event.kind === 'mutate:end'
          ? 'success'
          : 'pending',
    terminal?.event.kind === 'mutate:end' || terminal?.event.kind === 'mutate:error'
      ? formatMs(terminal.event.durationMs)
      : '',
  ])
}

function actionActivityDetails(
  representative: DevtoolsEvent,
  events: readonly DevtoolsEvent[],
): string {
  if (representative.event.kind !== 'action:start') return eventDetails(representative)
  const start = representative.event
  const terminal = [...events]
    .reverse()
    .find(item => item.event.kind === 'action:end' || item.event.kind === 'action:error')
  return joinEventParts([
    start.name ?? '(anonymous action)',
    terminal?.event.kind === 'action:error'
      ? errorMessage(terminal.event.error)
      : terminal?.event.kind === 'action:end'
        ? 'success'
        : 'pending',
    terminal?.event.kind === 'action:end' || terminal?.event.kind === 'action:error'
      ? formatMs(terminal.event.durationMs)
      : '',
  ])
}

function isMutationEvent(
  event: DevtoolsEvent['event'],
): event is Extract<DevtoolsEvent['event'], { mutationId: number }> {
  return 'mutationId' in event
}

function pluralActivity(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`
}

export function buildTraceIndex(events: readonly DevtoolsEvent[]): TraceIndex {
  const byFetchId = new Map<number, readonly number[]>()
  for (const item of events) {
    const event = item.event
    if (event.kind !== 'fetch:start' || event.fetchId === undefined) continue
    const traceIds = traceIdsFromCauses(event.causes)
    if (traceIds.length > 0) byFetchId.set(event.fetchId, traceIds)
  }
  return { byFetchId }
}

export function traceIdsForEvent(event: DevtoolsEvent['event'], index: TraceIndex): number[] {
  const direct = 'traceId' in event && event.traceId !== undefined ? [event.traceId] : []
  const caused = 'causes' in event ? traceIdsFromCauses(event.causes) : []
  const fetch =
    'fetchId' in event && event.fetchId !== undefined
      ? (index.byFetchId.get(event.fetchId) ?? [])
      : []
  return [...new Set([...direct, ...caused, ...fetch])]
}

function traceIdsFromCauses(
  causes: readonly { kind: string; traceId?: number }[] | undefined,
): number[] {
  return causes?.flatMap(cause => (cause.traceId === undefined ? [] : [cause.traceId])) ?? []
}

export function eventSearchText(item: DevtoolsEvent, scopes?: readonly EventQueryScope[]): string {
  const payload = eventPayload(item.event)
  const status = eventStatus(item.event).status
  return [
    formatClock(item.wallAt, { milliseconds: true }),
    item.event.kind,
    eventSubject(item.event),
    eventOperation(item.event),
    status,
    eventQueryId(item.event) ?? '',
    ...(scopes?.map(scope => scope.label) ?? []),
    eventDetails(item),
    payload === undefined ? '' : compactJson(payload),
    compactJson(displayEvent(item.event)),
  ].join(' ')
}

export function eventQueryId(event: DevtoolsEvent['event']): string | undefined {
  switch (event.kind) {
    case 'fetch:start':
    case 'fetch:end':
    case 'fetch:error':
    case 'reconcile:started':
    case 'reconcile:decision':
      return event.queryId
    case 'cache:updated':
      return event.queryEffects[0]?.queryId
    default:
      return undefined
  }
}

export function eventDetails(item: DevtoolsEvent): string {
  const event = item.event
  switch (event.kind) {
    case 'fetch:start':
      return joinEventParts([
        `${event.serviceName}.${event.method}`,
        event.resourceId === undefined ? '' : `#${event.resourceId}`,
        event.params === undefined ? '' : `params ${compactJson(event.params)}`,
      ])
    case 'fetch:end':
      return joinEventParts([
        `${event.serviceName}.${event.method}`,
        `${event.itemCount} ${event.itemCount === 1 ? 'row' : 'rows'}`,
        formatMs(event.durationMs),
      ])
    case 'fetch:error':
      return joinEventParts([
        `${event.serviceName}.${event.method}`,
        formatMs(event.durationMs),
        errorMessage(event.error),
      ])
    case 'reconcile:started':
      return joinEventParts([event.serviceName, 'reconciliation started'])
    case 'reconcile:decision':
      return joinEventParts([event.serviceName, event.decision])
    case 'reconnect:sweep':
      return joinEventParts([
        `sweep ${event.phase}`,
        event.queryCount === undefined ? '' : `${event.queryCount} queries`,
        event.delayMs > 0 ? `${formatMs(event.delayMs)} jitter` : '',
      ])
    case 'realtime':
      return joinEventParts([
        event.serviceName,
        event.type,
        event.itemId === undefined ? '' : `#${event.itemId}`,
      ])
    case 'cache:updated':
      return joinEventParts([
        `${event.serviceName} ${event.type} #${event.itemId}`,
        event.source,
        `${event.queryEffects.filter(effect => effect.outcome === 'merged').length} merged`,
        `${event.queryEffects.filter(effect => effect.outcome === 'reconcile').length} reconcile`,
      ])
    case 'connection:connected':
      return joinEventParts([
        'connected',
        event.transport ?? '',
        event.connectionId ? `socket ${event.connectionId}` : '',
      ])
    case 'connection:disconnected':
      return joinEventParts([
        event.reason ?? 'connection lost',
        event.reconnecting ? 'will reconnect' : 'reconnect disabled',
      ])
    case 'connection:reconnected':
      return joinEventParts([
        event.attempt === undefined ? 'reconnected' : `reconnected after attempt ${event.attempt}`,
        event.transport ?? '',
        event.connectionId ? `socket ${event.connectionId}` : '',
      ])
    case 'connection:error':
      return joinEventParts([event.phase, errorMessage(event.error)])
    case 'connection:reconnect-failed':
      return joinEventParts([
        'reconnection attempts exhausted',
        event.error ? errorMessage(event.error) : '',
      ])
    case 'mutate:start':
    case 'mutate:update':
    case 'mutate:end':
    case 'mutate:error':
    case 'mutate:rollback':
      return joinEventParts([
        `${event.serviceName}.${event.method}`,
        `mutation ${event.mutationId}`,
        event.id === undefined ? '' : `#${event.id}`,
        'optimistic' in event && event.optimistic ? 'optimistic' : '',
        'durationMs' in event ? formatMs(event.durationMs) : '',
        'error' in event ? errorMessage(event.error) : '',
      ])
    case 'action:start':
    case 'action:end':
    case 'action:error':
      return joinEventParts([
        `action ${event.actionId}`,
        event.name ?? '(anonymous)',
        'durationMs' in event ? formatMs(event.durationMs) : '',
        'error' in event ? errorMessage(event.error) : '',
      ])
    default: {
      const exhaustive: never = event
      return exhaustive
    }
  }
}

function activityIdentity(
  key: string,
  event: DevtoolsEvent['event'],
): { subject: string; operation: string } {
  if (key.startsWith('action:') || event.kind === 'action:start') {
    return {
      subject: 'action',
      operation: event.kind === 'action:start' ? (event.name ?? '(anonymous)') : 'run',
    }
  }
  return { subject: eventSubject(event), operation: eventOperation(event) }
}

function activityStatus(
  key: string,
  events: readonly DevtoolsEvent[],
): { status: string; tone: 'green' | 'amber' | 'red' | 'blue' | 'neutral' } {
  const representative = activityRepresentative(events).event
  if (key.startsWith('mutation:') || isMutationEvent(representative)) {
    const terminal = [...events]
      .reverse()
      .find(item => ['mutate:end', 'mutate:error', 'mutate:rollback'].includes(item.event.kind))
    if (!terminal) return { status: 'pending', tone: 'blue' }
    return eventStatus(terminal.event)
  }
  if (key.startsWith('action:') || representative.kind === 'action:start') {
    const terminal = [...events]
      .reverse()
      .find(item => item.event.kind === 'action:end' || item.event.kind === 'action:error')
    return terminal ? eventStatus(terminal.event) : { status: 'pending', tone: 'blue' }
  }
  if (
    representative.kind === 'realtime' ||
    representative.kind === 'cache:updated' ||
    representative.kind.startsWith('connection:')
  ) {
    return eventStatus(representative)
  }
  const terminal = [...events]
    .reverse()
    .find(item => item.event.kind === 'fetch:end' || item.event.kind === 'fetch:error')
  if (terminal) return eventStatus(terminal.event)
  return eventStatus(events.at(-1)!.event)
}

function eventSubject(event: DevtoolsEvent['event']): string {
  if ('serviceName' in event) return event.serviceName
  if (event.kind.startsWith('connection:')) return 'socket'
  if (event.kind === 'reconnect:sweep') return 'socket'
  if (
    event.kind === 'action:start' ||
    event.kind === 'action:end' ||
    event.kind === 'action:error'
  ) {
    return event.name ?? 'action'
  }
  return 'figbird'
}

function eventOperation(event: DevtoolsEvent['event']): string {
  if (event.kind === 'realtime' || event.kind === 'cache:updated') {
    return normalizeRealtimeOperation(event.type)
  }
  if ('method' in event) return event.method
  if (event.kind.startsWith('connection:')) return event.kind.slice('connection:'.length)
  if (event.kind.startsWith('fetch:')) return event.kind.slice('fetch:'.length)
  if (event.kind.startsWith('reconcile:')) return event.kind.slice('reconcile:'.length)
  if (event.kind === 'reconnect:sweep') return 'sweep'
  if (event.kind.startsWith('action:')) return 'action'
  return event.kind
}

function eventStatus(event: DevtoolsEvent['event']): {
  status: string
  tone: 'green' | 'amber' | 'red' | 'blue' | 'neutral'
} {
  switch (event.kind) {
    case 'fetch:start':
    case 'mutate:start':
    case 'mutate:update':
    case 'action:start':
    case 'reconcile:started':
      return { status: 'pending', tone: 'blue' }
    case 'fetch:end':
    case 'mutate:end':
    case 'action:end':
      return { status: 'success', tone: 'green' }
    case 'fetch:error':
    case 'mutate:error':
    case 'action:error':
    case 'connection:error':
    case 'connection:reconnect-failed':
      return { status: 'error', tone: 'red' }
    case 'mutate:rollback':
      return { status: 'rolled back', tone: 'red' }
    case 'realtime':
      return { status: 'received', tone: 'blue' }
    case 'cache:updated':
      return event.source === 'optimistic'
        ? { status: 'projected', tone: 'amber' }
        : { status: 'success', tone: 'green' }
    case 'connection:connected':
    case 'connection:reconnected':
      return { status: 'connected', tone: 'green' }
    case 'connection:disconnected':
      return event.reconnecting
        ? { status: 'reconnecting', tone: 'blue' }
        : { status: 'offline', tone: 'red' }
    case 'reconnect:sweep':
      return { status: event.phase, tone: 'blue' }
    case 'reconcile:decision':
      return { status: event.decision, tone: 'neutral' }
  }
}

function normalizeRealtimeOperation(type: string): string {
  switch (type) {
    case 'created':
      return 'create'
    case 'updated':
      return 'update'
    case 'patched':
      return 'patch'
    case 'removed':
      return 'remove'
  }
  return type
}

function joinEventParts(parts: string[]): string {
  return parts.filter(Boolean).join(' · ')
}

function errorMessage(error: Error): string {
  return error.message || String(error)
}
