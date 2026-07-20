import type { DevtoolsEvent } from './collector.js'
import { compactJson, formatMs, pad2, pad3 } from './format.js'
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
      {rows.map((item, index) => {
        const queryId = eventQueryId(item.event)
        const queryScopes = queryId ? scopes.get(queryId) : undefined
        const details = eventDetails(item)
        return (
          <div key={`${item.at}:${index}`} style={styles.eventRow}>
            <span style={{ ...styles.code, color: colors.faint }}>
              {formatEventTimestamp(item)}
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
    formatEventTimestamp(item),
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
    case 'reconcile:scheduled':
    case 'reconcile:deferred':
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
    case 'reconcile:scheduled':
      return joinEventParts([event.serviceName, event.mode])
    case 'reconcile:deferred':
      return joinEventParts([event.serviceName, event.reason])
    case 'prepare:start':
    case 'prefetch:start':
      return event.name ?? event.key
    case 'prepare:end':
    case 'prefetch:end':
      return joinEventParts([event.key, formatMs(event.durationMs)])
    case 'realtime':
      return joinEventParts([
        event.serviceName,
        event.type,
        event.itemId === undefined ? '' : `#${event.itemId}`,
      ])
    case 'mutate:start':
      return joinEventParts([
        `${event.serviceName}.${event.method}`,
        `mutation ${event.mutationId}`,
        event.id === undefined ? '' : `#${event.id}`,
        event.optimistic ? 'optimistic' : '',
      ])
    case 'mutate:end':
      return joinEventParts([
        `${event.serviceName}.${event.method}`,
        `mutation ${event.mutationId}`,
        event.id === undefined ? '' : `#${event.id}`,
        event.optimistic ? 'optimistic' : '',
        formatMs(event.durationMs),
      ])
    case 'mutate:error':
      return joinEventParts([
        `${event.serviceName}.${event.method}`,
        `mutation ${event.mutationId}`,
        event.id === undefined ? '' : `#${event.id}`,
        event.optimistic ? 'optimistic' : '',
        formatMs(event.durationMs),
        errorMessage(event.error),
      ])
    case 'mutate:rollback':
      return joinEventParts([
        `${event.serviceName}.${event.method}`,
        `mutation ${event.mutationId}`,
        event.id === undefined ? '' : `#${event.id}`,
      ])
    case 'action:start':
      return joinEventParts([`action ${event.actionId}`, event.name ?? '(anonymous)'])
    case 'action:end':
      return joinEventParts([
        `action ${event.actionId}`,
        event.name ?? '(anonymous)',
        formatMs(event.durationMs),
      ])
    case 'action:error':
      return joinEventParts([
        `action ${event.actionId}`,
        event.name ?? '(anonymous)',
        formatMs(event.durationMs),
        errorMessage(event.error),
      ])
    default:
      return genericEventDetails(event)
  }
}

function genericEventDetails(event: DevtoolsEvent['event']): string {
  return Object.entries(event as unknown as Record<string, unknown>)
    .filter(([key]) => key !== 'kind' && key !== 'queryId' && key !== 'error')
    .map(([key, value]) => `${key} ${formatEventValue(value)}`)
    .filter(Boolean)
    .join(' · ')
}

function joinEventParts(parts: string[]): string {
  return parts.filter(Boolean).join(' · ')
}

function formatEventValue(value: unknown): string {
  if (value instanceof Error) return value.message
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return compactJson(value)
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

function formatEventTimestamp(item: DevtoolsEvent): string {
  const value = item.wallAt ?? item.at
  if (value < 946_684_800_000) return formatOffset(value)
  const date = new Date(value)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}.${pad3(date.getMilliseconds())}`
}

function formatOffset(value: number): string {
  return `${Math.round(value)}ms`
}
