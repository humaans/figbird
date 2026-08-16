import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { DevtoolsEvent } from './collector.js'
import type { EventVisibility } from './Devtools.js'
import {
  buildActivities,
  buildTraceIndex,
  displayEvent,
  eventDetails,
  eventPayload,
  eventQueryId,
  eventSearchText,
  eventTone,
  rawEventRow,
  traceIdsForEvent,
  type EventListRow,
} from './eventModel.js'
import { formatClock } from './format.js'
import { JsonViewer } from './JsonViewer.js'
import type { EventQueryScope } from './model.js'
import {
  Badge,
  ColumnResizeHandle,
  DetailBlock,
  DetailSection,
  DetailStat,
  DetailsPane,
  resizableGridTemplate,
  toneColor,
  useDetailsPaneWidth,
  useResizableColumns,
  useDevtoolsTheme,
} from './ui.js'

const EVENT_COLUMNS = [
  { label: 'Time', width: 108, minWidth: 84 },
  { label: 'Activity', width: 132, minWidth: 96 },
  { label: 'Scope', width: 140, minWidth: 96 },
  { label: 'Details', width: 360, minWidth: 180 },
] as const

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
  const [columnWidths, onColumnResizeStart] = useResizableColumns(EVENT_COLUMNS)
  const [detailsWidth, onDetailsResizeStart] = useDetailsPaneWidth()
  const gridTemplateColumns = resizableGridTemplate(columnWidths, 3)
  const gridMinWidth =
    columnWidths.reduce((sum, width) => sum + width, 0) + (EVENT_COLUMNS.length - 1) * 10
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
            gridTemplateColumns,
            minWidth: gridMinWidth,
            position: 'sticky',
            top: 0,
            zIndex: 1,
            background: colors.bg,
            color: colors.muted,
            fontWeight: 600,
            borderBottom: `1px solid ${colors.border}`,
          }}
        >
          {EVENT_COLUMNS.map((column, index) => (
            <span
              key={column.label}
              style={{
                position: 'relative',
                alignSelf: 'stretch',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              {index === 1 && visibility !== 'activity' ? 'Event' : column.label}
              <ColumnResizeHandle
                label={column.label}
                onMouseDown={event => onColumnResizeStart(index, event)}
              />
            </span>
          ))}
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
                gridTemplateColumns,
                minWidth: gridMinWidth,
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
      <DetailBlock>
        <JsonViewer
          value={payload}
          label={item.event.kind === 'realtime' ? 'Realtime payload' : 'Event payload'}
          emptyLabel='No payload'
        />
      </DetailBlock>
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
      <DetailBlock>
        <JsonViewer value={displayEvent(item.event)} label='Full event' />
      </DetailBlock>
    </DetailsPane>
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
  const tone = scopes.some(item => item.kind === 'root')
    ? 'amber'
    : scopes.some(item => item.kind === 'nested')
      ? 'blue'
      : 'neutral'
  return (
    <Badge
      tone={tone}
      title={[...scopes.map(item => item.title), queryId ? `query id: ${queryId}` : '']
        .filter(Boolean)
        .join('\n')}
    >
      {scopes.length === 1 ? scope.label : `${scopes.length} scopes`}
    </Badge>
  )
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
