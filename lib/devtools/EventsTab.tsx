import type { DevtoolsEvent } from './collector.js'
import { compactJson, formatClock, formatMs } from './format.js'
import type { EventQueryScope } from './model.js'
import { toneColor, useDevtoolsTheme } from './ui.js'

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
  const rows = events
    .filter(item => {
      if (!filter) return true
      return eventSearchText(item, scopes.get(eventQueryId(item.event) ?? ''))
        .toLowerCase()
        .includes(filter.toLowerCase())
    })
    .reverse()
  return (
    <div style={styles.scroll}>
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
      {rows.map(item => {
        const queryId = eventQueryId(item.event)
        const queryScopes = queryId ? scopes.get(queryId) : undefined
        const details = eventDetails(item)
        return (
          <div key={item.id} style={styles.eventRow}>
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
  )
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
    case 'mutate:start':
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
  if (kind.endsWith(':error') || kind.endsWith(':rollback')) return 'red'
  if (kind === 'realtime') return 'blue'
  if (kind.endsWith(':start')) return 'amber'
  if (kind.endsWith(':end')) return 'green'
  return 'neutral'
}
