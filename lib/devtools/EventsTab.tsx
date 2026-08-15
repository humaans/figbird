import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { DevtoolsEvent } from './collector.js'
import { compactJson, formatClock, formatMs, prettyJson } from './format.js'
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
  scopes,
}: {
  events: DevtoolsEvent[]
  filter: string
  scopes: ReadonlyMap<string, readonly EventQueryScope[]>
}) {
  const { colors, styles } = useDevtoolsTheme()
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null)
  const [detailsWidth, onDetailsResizeStart] = useDetailsPaneWidth()
  const rows = events
    .filter(item => {
      if (!filter) return true
      return eventSearchText(item, scopes.get(eventQueryId(item.event) ?? ''))
        .toLowerCase()
        .includes(filter.toLowerCase())
    })
    .reverse()
  const selectedEvent = events.find(item => item.id === selectedEventId)
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
          <span>Event</span>
          <span>Scope</span>
          <span>Details</span>
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: 16, color: colors.muted }}>No matching events recorded.</div>
        ) : null}
        {rows.map(item => {
          const queryId = eventQueryId(item.event)
          const queryScopes = queryId ? scopes.get(queryId) : undefined
          const details = eventDetails(item)
          return (
            <div
              key={item.id}
              role='button'
              tabIndex={0}
              aria-pressed={item.id === selectedEventId}
              title='Select event details'
              onClick={() => setSelectedEventId(item.id)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setSelectedEventId(item.id)
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
              <EventKind kind={item.event.kind} />
              <EventScopeBadge scopes={queryScopes} queryId={queryId} />
              <span
                style={{
                  ...styles.code,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={details}
              >
                {details}
              </span>
            </div>
          )
        })}
      </div>
      {selectedEvent ? (
        <EventDetails
          item={selectedEvent}
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
  width,
  onResizeStart,
  onClose,
}: {
  item: DevtoolsEvent
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
        <pre
          style={{
            ...styles.code,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            margin: 0,
            padding: 10,
            color: payload === undefined ? colors.faint : colors.text,
            background: colors.panel2,
            borderRadius: 4,
          }}
        >
          {payload === undefined ? 'No payload' : prettyJson(payload)}
        </pre>
      </DetailSection>
      <DetailSection label='Full event'>
        <pre
          style={{
            ...styles.code,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            margin: 0,
            color: colors.muted,
          }}
        >
          {prettyJson(displayEvent(item.event))}
        </pre>
      </DetailSection>
    </DetailsPane>
  )
}

function eventPayload(event: DevtoolsEvent['event']): unknown {
  switch (event.kind) {
    case 'realtime':
      return event.item
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
      return event.serviceName
    case 'realtime':
      return joinEventParts([
        event.serviceName,
        event.type,
        event.itemId === undefined ? '' : `#${event.itemId}`,
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
