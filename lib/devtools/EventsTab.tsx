import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { DevtoolsEvent } from './collector.js'
import type { EventVisibility } from './Devtools.js'
import { compactJson, formatClock, formatMs } from './format.js'
import { JsonViewer } from './JsonViewer.js'
import type { EventQueryScope } from './model.js'
import {
  DetailSection,
  DetailStat,
  DetailsPane,
  toneColor,
  useDetailsPaneWidth,
  useDevtoolsTheme,
} from './ui.js'

export function EventsTab({
  events,
  filter,
  visibility,
  scopes,
  selectedTraceId,
  onSelectedTraceIdChange,
}: {
  events: DevtoolsEvent[]
  filter: string
  visibility: EventVisibility
  scopes: ReadonlyMap<string, readonly EventQueryScope[]>
  selectedTraceId?: number | null
  onSelectedTraceIdChange?: (traceId: number | null) => void
}) {
  const { colors, styles } = useDevtoolsTheme()
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null)
  const [detailsWidth, onDetailsResizeStart] = useDetailsPaneWidth()
  const traceIndex = useMemo(() => buildTraceIndex(events), [events])
  const activities = useMemo(() => buildActivities(events, traceIndex), [events, traceIndex])
  const normalizedFilter = filter.toLowerCase()
  const rows: EventListRow[] =
    visibility === 'activity'
      ? activities.filter(activity =>
          normalizedFilter ? activity.searchText.includes(normalizedFilter) : true,
        )
      : events
          .filter(item => {
            if (!normalizedFilter) return true
            return eventSearchText(item, scopes.get(eventQueryId(item.event) ?? ''))
              .toLowerCase()
              .includes(normalizedFilter)
          })
          .reverse()
          .map(item => rawEventRow(item, traceIndex))
  const selectedEvent = events.find(item => item.id === selectedEventId)
  const selectedActivity = activities.find(
    activity => activity.representative.id === selectedEventId,
  )
  const traceEvents = useMemo(
    () =>
      selectedTraceId
        ? events.filter(item => traceIdsForEvent(item.event, traceIndex).includes(selectedTraceId))
        : [],
    [events, selectedTraceId, traceIndex],
  )

  useEffect(() => {
    if (!selectedTraceId || traceEvents.length === 0) return
    if (
      selectedEvent &&
      traceIdsForEvent(selectedEvent.event, traceIndex).includes(selectedTraceId)
    ) {
      return
    }
    const activity = activities.find(item => item.traceId === selectedTraceId)
    setSelectedEventId(
      visibility === 'activity' && activity ? activity.representative.id : traceEvents.at(-1)!.id,
    )
  }, [activities, selectedEvent, selectedTraceId, traceEvents, traceIndex, visibility])
  return (
    <section style={{ height: '100%', display: 'flex', minWidth: 0 }}>
      <div style={{ ...styles.scroll, flex: 1, minWidth: 0 }}>
        <div
          style={{
            ...styles.eventRow,
            position: 'sticky',
            top: 0,
            zIndex: 1,
            background: colors.bg,
            color: colors.muted,
            fontWeight: 600,
            borderBottom: `1px solid ${colors.border}`,
          }}
        >
          <span>Time</span>
          <span>{visibility === 'activity' ? 'Activity' : 'Event'}</span>
          <span>Scope</span>
          <span>Details</span>
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: 16, color: colors.muted }}>
            No matching {visibility === 'activity' ? 'activity' : 'events'} recorded.
          </div>
        ) : null}
        {rows.map(row => {
          const item = row.representative
          const queryId = row.queryId
          const queryScopes = queryId ? scopes.get(queryId) : undefined
          return (
            <div
              key={row.key}
              role='button'
              tabIndex={0}
              aria-pressed={item.id === selectedEventId}
              title='Select event details'
              onClick={() => {
                setSelectedEventId(item.id)
                onSelectedTraceIdChange?.(row.traceId ?? null)
              }}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setSelectedEventId(item.id)
                  onSelectedTraceIdChange?.(row.traceId ?? null)
                }
              }}
              style={{
                ...styles.eventRow,
                cursor: 'pointer',
                outline: 'none',
                background: item.id === selectedEventId ? colors.activeButtonBg : undefined,
                boxShadow: item.id === selectedEventId ? `inset 3px 0 ${colors.blue}` : undefined,
              }}
            >
              <span style={{ ...styles.code, color: colors.faint }}>
                {formatClock(item.wallAt, { milliseconds: true })}
              </span>
              <EventKind kind={row.kind} />
              <EventScopeBadge scopes={queryScopes} queryId={queryId} />
              <span
                style={{
                  ...styles.code,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={row.details}
              >
                {row.details}
              </span>
            </div>
          )
        })}
      </div>
      {selectedEvent ? (
        <EventDetails
          item={selectedEvent}
          relatedEvents={
            selectedTraceId
              ? traceEvents
              : visibility === 'activity'
                ? (selectedActivity?.events ?? [])
                : []
          }
          relatedLabel={
            selectedTraceId
              ? `Causal trace #${selectedTraceId}`
              : visibility === 'activity'
                ? 'Related activity'
                : null
          }
          width={detailsWidth}
          onResizeStart={onDetailsResizeStart}
          onClose={() => setSelectedEventId(null)}
        />
      ) : null}
    </section>
  )
}

function EventDetails({
  item,
  relatedEvents,
  relatedLabel,
  width,
  onResizeStart,
  onClose,
}: {
  item: DevtoolsEvent
  relatedEvents?: DevtoolsEvent[]
  relatedLabel: string | null
  width: number
  onResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void
  onClose: () => void
}) {
  const { colors, styles } = useDevtoolsTheme()
  const queryId = eventQueryId(item.event)
  const payload = eventPayload(item.event)
  return (
    <DetailsPane
      title={item.event.kind}
      subtitle={formatClock(item.wallAt, { milliseconds: true })}
      width={width}
      onResizeStart={onResizeStart}
      onClose={onClose}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: '8px 16px',
          marginBottom: 16,
        }}
      >
        {'serviceName' in item.event ? (
          <DetailStat label='Service' value={item.event.serviceName} />
        ) : null}
        {'type' in item.event ? <DetailStat label='Type' value={item.event.type} /> : null}
        {'method' in item.event ? <DetailStat label='Method' value={item.event.method} /> : null}
        {queryId ? <DetailStat label='Query ID' value={queryId} /> : null}
      </div>
      <DetailSection label={item.event.kind === 'realtime' ? 'Realtime payload' : 'Event payload'}>
        <JsonViewer value={payload} emptyLabel='No payload' />
      </DetailSection>
      {relatedEvents && relatedEvents.length > 1 ? (
        <DetailSection label={relatedLabel ?? 'Related activity'}>
          <div style={{ borderTop: `1px solid ${colors.rowBorder}` }}>
            {relatedEvents.map(traceEvent => (
              <div
                key={traceEvent.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '82px minmax(112px, auto) minmax(0, 1fr)',
                  gap: 8,
                  padding: '7px 0',
                  borderBottom: `1px solid ${colors.rowBorder}`,
                  color: traceEvent.id === item.id ? colors.text : colors.muted,
                  background: traceEvent.id === item.id ? colors.activeButtonBg : 'transparent',
                }}
              >
                <code style={{ ...styles.code, color: colors.faint }}>
                  {formatClock(traceEvent.wallAt, { milliseconds: true })}
                </code>
                <strong style={{ fontWeight: 600 }}>{traceEvent.event.kind}</strong>
                <span
                  title={eventDetails(traceEvent)}
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {eventDetails(traceEvent)}
                </span>
              </div>
            ))}
          </div>
        </DetailSection>
      ) : null}
      <DetailSection label='Full event'>
        <JsonViewer value={displayEvent(item.event)} />
      </DetailSection>
    </DetailsPane>
  )
}

function eventPayload(event: DevtoolsEvent['event']): unknown {
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

function displayEvent(event: DevtoolsEvent['event']): unknown {
  if ('error' in event && event.error) {
    return { ...event, error: { name: event.error.name, message: event.error.message } }
  }
  return event
}

function EventScopeBadge({
  scopes,
  queryId,
}: {
  scopes: readonly EventQueryScope[] | undefined
  queryId: string | undefined
}) {
  const { colors } = useDevtoolsTheme()
  if (!scopes || scopes.length === 0) {
    return <span style={{ color: colors.faint }}>-</span>
  }
  const scope = scopes[0]!
  const background = scopes.some(item => item.kind === 'root')
    ? colors.amber
    : scopes.some(item => item.kind === 'nested')
      ? colors.blue
      : colors.muted
  return (
    <span
      title={[...scopes.map(item => item.title), queryId ? `query id: ${queryId}` : '']
        .filter(Boolean)
        .join('\n')}
      style={{
        display: 'inline-block',
        maxWidth: 150,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: colors.bg,
        background,
        borderRadius: 3,
        padding: '1px 6px',
        fontSize: 11,
        fontWeight: 700,
        lineHeight: '17px',
      }}
    >
      {scopes.length === 1 ? scope.label : `${scopes.length} scopes`}
    </span>
  )
}

interface TraceIndex {
  byFetchId: ReadonlyMap<number, readonly number[]>
}

interface EventListRow {
  key: string
  representative: DevtoolsEvent
  kind: string
  details: string
  queryId?: string
  traceId?: number
}

interface ActivityRow extends EventListRow {
  events: DevtoolsEvent[]
  searchText: string
}

function rawEventRow(item: DevtoolsEvent, index: TraceIndex): EventListRow {
  const queryId = eventQueryId(item.event)
  const traceId = traceIdsForEvent(item.event, index)[0]
  return {
    key: `event:${item.id}`,
    representative: item,
    kind: item.event.kind,
    details: eventDetails(item),
    ...(queryId === undefined ? {} : { queryId }),
    ...(traceId === undefined ? {} : { traceId }),
  }
}

function buildActivities(events: readonly DevtoolsEvent[], index: TraceIndex): ActivityRow[] {
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
      const queryId = group.events.map(item => eventQueryId(item.event)).find(Boolean)
      return {
        key,
        representative,
        events: group.events,
        kind,
        details,
        searchText: [kind, details, ...group.events.map(item => eventSearchText(item))]
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
  switch (event.kind) {
    case 'mutate:start':
    case 'mutate:update':
    case 'mutate:end':
    case 'mutate:error':
    case 'mutate:rollback':
      return `mutation:${event.mutationId}`
    case 'action:start':
    case 'action:end':
    case 'action:error':
      return `action:${event.actionId}`
    default:
      return `event:${item.id}`
  }
}

function activityRepresentative(events: readonly DevtoolsEvent[]): DevtoolsEvent {
  const mutationOrActionStart = events.find(
    item => item.event.kind === 'mutate:start' || item.event.kind === 'action:start',
  )
  if (mutationOrActionStart) return mutationOrActionStart

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
  if (key.startsWith('mutation:')) return 'mutation'
  if (key.startsWith('action:')) return 'action'
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
  if (key.startsWith('mutation:')) return mutationActivityDetails(representative, events)
  if (key.startsWith('action:')) return actionActivityDetails(representative, events)

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
      effects.merged > 0 ? pluralActivity(effects.merged, 'query merged', 'queries merged') : '',
      effects.reconcile > 0
        ? pluralActivity(effects.reconcile, 'query reconciled', 'queries reconciled')
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
        ? pluralActivity(effects.reconcile, 'query reconciled', 'queries reconciled')
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
          : 'in flight',
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
          ? 'completed'
          : 'in flight',
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
        ? 'completed'
        : 'in flight',
    terminal?.event.kind === 'action:end' || terminal?.event.kind === 'action:error'
      ? formatMs(terminal.event.durationMs)
      : '',
  ])
}

function pluralActivity(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function buildTraceIndex(events: readonly DevtoolsEvent[]): TraceIndex {
  const byFetchId = new Map<number, readonly number[]>()
  for (const item of events) {
    const event = item.event
    if (event.kind !== 'fetch:start' || event.fetchId === undefined) continue
    const traceIds = traceIdsFromCauses(event.causes)
    if (traceIds.length > 0) byFetchId.set(event.fetchId, traceIds)
  }
  return { byFetchId }
}

function traceIdsForEvent(event: DevtoolsEvent['event'], index: TraceIndex): number[] {
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

function eventSearchText(item: DevtoolsEvent, scopes?: readonly EventQueryScope[]): string {
  return [
    formatClock(item.wallAt, { milliseconds: true }),
    item.event.kind,
    eventQueryId(item.event) ?? '',
    ...(scopes?.map(scope => scope.label) ?? []),
    eventDetails(item),
  ].join(' ')
}

function eventQueryId(event: DevtoolsEvent['event']): string | undefined {
  switch (event.kind) {
    case 'fetch:start':
    case 'fetch:end':
    case 'fetch:error':
    case 'reconcile:started':
    case 'reconcile:decision':
      return event.queryId
    default:
      return undefined
  }
}

function eventDetails(item: DevtoolsEvent): string {
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
        `${event.itemCount} ${event.itemCount === 1 ? 'item' : 'items'}`,
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

function joinEventParts(parts: string[]): string {
  return parts.filter(Boolean).join(' · ')
}

function errorMessage(error: Error): string {
  return error.message || String(error)
}

function EventKind({ kind }: { kind: string }) {
  const { colors } = useDevtoolsTheme()
  return (
    <span
      style={{
        color: toneColor(colors, eventTone(kind)),
        fontWeight: 600,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
      title={kind}
    >
      {kind}
    </span>
  )
}

function eventTone(kind: string): 'green' | 'amber' | 'red' | 'blue' | 'neutral' {
  if (kind === 'connection' || kind === 'fetch' || kind === 'cache edit') return 'blue'
  if (kind === 'mutation' || kind === 'mutation cache' || kind === 'optimistic') return 'amber'
  if (kind === 'action') return 'green'
  if (kind === 'connection:connected' || kind === 'connection:reconnected') return 'green'
  if (
    kind === 'connection:disconnected' ||
    kind === 'connection:error' ||
    kind === 'connection:reconnect-failed'
  ) {
    return 'red'
  }
  if (kind.endsWith(':error') || kind.endsWith(':rollback')) return 'red'
  if (kind === 'realtime') return 'blue'
  if (kind.endsWith(':update')) return 'blue'
  if (kind.endsWith(':start')) return 'amber'
  if (kind.endsWith(':end')) return 'green'
  return 'neutral'
}
