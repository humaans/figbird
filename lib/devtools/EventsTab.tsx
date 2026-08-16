import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { DevtoolsEvent } from './collector.js'
import type { EventVisibility } from './Devtools.js'
import {
  buildActivities,
  buildTraceIndex,
  displayEvent,
  eventDetails,
  eventPayload,
  eventPayloadLabel,
  eventQueryId,
  eventSearchText,
  rawEventRow,
  traceIdsForEvent,
  type ActivityRow,
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
  DetailStats,
  DetailsPane,
  resizableGridTemplate,
  toneColor,
  useDetailsPaneWidth,
  useResizableColumns,
  useDevtoolsTheme,
} from './ui.js'

const EVENT_COLUMNS = [
  { label: 'time', width: 108, minWidth: 84 },
  { label: 'group', width: 112, minWidth: 84 },
  { label: 'service', width: 130, minWidth: 92 },
  { label: 'operation', width: 92, minWidth: 72 },
  { label: 'scope', width: 135, minWidth: 92 },
  { label: 'status', width: 94, minWidth: 74 },
  { label: 'details', width: 300, minWidth: 160 },
] as const

export function EventsTab({
  events,
  filter,
  visibility,
  scopes,
  selectedTraceId,
  onSelectedTraceIdChange,
  onViewQuery,
}: {
  events: DevtoolsEvent[]
  filter: string
  visibility: EventVisibility
  scopes: ReadonlyMap<string, readonly EventQueryScope[]>
  selectedTraceId?: number | null
  onSelectedTraceIdChange?: (traceId: number | null) => void
  onViewQuery?: (queryId: string) => void
}) {
  const { colors, styles } = useDevtoolsTheme()
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null)
  const [columnWidths, onColumnResizeStart] = useResizableColumns(EVENT_COLUMNS)
  const [detailsWidth, onDetailsResizeStart] = useDetailsPaneWidth()
  const gridTemplateColumns = resizableGridTemplate(columnWidths, 6)
  const gridMinWidth =
    columnWidths.reduce((sum, width) => sum + width, 0) + (EVENT_COLUMNS.length - 1) * 10
  const normalizedFilter = filter.trim().toLowerCase()
  const traceIndex = useMemo(() => buildTraceIndex(events), [events])
  const activities = useMemo(
    () => buildActivities(events, traceIndex, scopes, normalizedFilter.length > 0),
    [events, normalizedFilter, scopes, traceIndex],
  )
  const rows: EventListRow[] =
    visibility === 'groups'
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
      visibility === 'groups' && activity ? activity.representative.id : traceEvents.at(-1)!.id,
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
            color: colors.text,
            fontWeight: 400,
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
              {index === 1 && visibility !== 'groups' ? 'raw event' : column.label}
              <ColumnResizeHandle
                label={column.label}
                onMouseDown={event => onColumnResizeStart(index, event)}
              />
            </span>
          ))}
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: 16, color: colors.muted }}>
            No matching {visibility === 'groups' ? 'causal groups' : 'raw events'} recorded.
          </div>
        ) : null}
        {rows.map(row => {
          const item = row.representative
          const queryId = row.queryId
          const queryScopes = queryId ? scopes.get(queryId) : undefined
          return (
            <div
              key={row.key}
              data-event-row=''
              role='button'
              tabIndex={0}
              aria-pressed={item.id === selectedEventId}
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
                contentVisibility: 'auto',
                containIntrinsicSize: '0 33px',
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
              <EllipsisValue value={row.subject} />
              <EllipsisValue value={row.operation} code />
              <EventScopeBadge
                scopes={queryScopes}
                queryId={queryId}
                {...(onViewQuery ? { onViewQuery } : {})}
              />
              <EventStatus status={row.status} tone={row.tone} />
              <span
                style={{
                  ...styles.code,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                data-tooltip={row.details}
                data-tooltip-overflow=''
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
          {...(selectedTraceId !== null && selectedTraceId !== undefined
            ? { traceId: selectedTraceId }
            : {})}
          {...(visibility === 'groups' && selectedActivity ? { group: selectedActivity } : {})}
          relatedEvents={
            selectedTraceId
              ? traceEvents
              : visibility === 'groups'
                ? (selectedActivity?.events ?? [])
                : []
          }
          relatedLabel={
            selectedTraceId
              ? `Causal trace #${selectedTraceId}`
              : visibility === 'groups'
                ? 'Raw events in group'
                : null
          }
          width={detailsWidth}
          onResizeStart={onDetailsResizeStart}
          onClose={() => {
            setSelectedEventId(null)
            onSelectedTraceIdChange?.(null)
          }}
          onSelectEvent={eventId => setSelectedEventId(eventId)}
        />
      ) : null}
    </section>
  )
}

function EventDetails({
  item,
  group,
  traceId,
  relatedEvents,
  relatedLabel,
  width,
  onResizeStart,
  onClose,
  onSelectEvent,
}: {
  item: DevtoolsEvent
  group?: ActivityRow
  traceId?: number
  relatedEvents?: DevtoolsEvent[]
  relatedLabel: string | null
  width: number
  onResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void
  onClose: () => void
  onSelectEvent: (eventId: number) => void
}) {
  const { colors, styles } = useDevtoolsTheme()
  const queryId = group?.queryId ?? eventQueryId(item.event)
  const payload = item.payload?.state === 'evicted' ? undefined : eventPayload(item.event)
  return (
    <DetailsPane
      title={group?.kind ?? item.event.kind}
      subtitle={
        group
          ? `Causal group · ${formatClock(item.wallAt, { milliseconds: true })}`
          : formatClock(item.wallAt, { milliseconds: true })
      }
      width={width}
      onResizeStart={onResizeStart}
      onClose={onClose}
    >
      <DetailStats>
        <DetailStat
          label='Service'
          value={
            group?.subject ?? ('serviceName' in item.event ? item.event.serviceName : 'figbird')
          }
        />
        {group ? <DetailStat label='Operation' value={group.operation} /> : null}
        {group ? <DetailStat label='Status' value={group.status} /> : null}
        {!group && 'type' in item.event ? (
          <DetailStat label='Type' value={item.event.type} />
        ) : null}
        {!group && 'method' in item.event ? (
          <DetailStat label='Method' value={item.event.method} />
        ) : null}
        {queryId ? <DetailStat label='Query ID' value={queryId} copyValue={queryId} /> : null}
        {(group?.traceId ?? traceId) !== undefined ? (
          <DetailStat
            label='Trace ID'
            value={`#${group?.traceId ?? traceId}`}
            copyValue={String(group?.traceId ?? traceId)}
          />
        ) : null}
        {'mutationId' in item.event ? (
          <DetailStat
            label='Write ID'
            value={`mutation:${item.event.mutationId}`}
            copyValue={`mutation:${item.event.mutationId}`}
          />
        ) : null}
        {'actionId' in item.event ? (
          <DetailStat
            label='Write ID'
            value={`action:${item.event.actionId}`}
            copyValue={`action:${item.event.actionId}`}
          />
        ) : null}
        {eventEntityId(item.event) !== undefined ? (
          <DetailStat
            label='Entity ID'
            value={`#${eventEntityId(item.event)}`}
            copyValue={String(eventEntityId(item.event))}
          />
        ) : null}
      </DetailStats>
      <DetailBlock>
        <JsonViewer
          value={payload}
          label={eventPayloadLabel(item.event)}
          emptyLabel={
            item.payload?.state === 'evicted'
              ? 'Payload vacuumed to keep the recording bounded'
              : 'No payload'
          }
        />
      </DetailBlock>
      {relatedEvents && relatedEvents.length > 1 ? (
        <DetailSection label={relatedLabel ?? 'Related raw events'}>
          <div style={{ borderTop: `1px solid ${colors.rowBorder}` }}>
            {relatedEvents.map(traceEvent => (
              <button
                type='button'
                key={traceEvent.id}
                onClick={() => onSelectEvent(traceEvent.id)}
                style={{
                  display: 'grid',
                  width: '100%',
                  gridTemplateColumns: '82px minmax(112px, auto) minmax(0, 1fr)',
                  gap: 8,
                  padding: '7px 0',
                  borderBottom: `1px solid ${colors.rowBorder}`,
                  color: traceEvent.id === item.id ? colors.text : colors.muted,
                  background: traceEvent.id === item.id ? colors.activeButtonBg : 'transparent',
                  border: 0,
                  font: 'inherit',
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                <code style={{ ...styles.code, color: colors.faint }}>
                  {formatClock(traceEvent.wallAt, { milliseconds: true })}
                </code>
                <strong style={{ fontWeight: 600 }}>{traceEvent.event.kind}</strong>
                <span
                  data-tooltip={eventDetails(traceEvent)}
                  data-tooltip-overflow=''
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {eventDetails(traceEvent)}
                </span>
              </button>
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

function eventEntityId(event: DevtoolsEvent['event']): string | number | undefined {
  if (event.kind === 'realtime' || event.kind === 'cache:updated') return event.itemId
  if ('mutationId' in event) return event.id
  return undefined
}

function EventScopeBadge({
  scopes,
  queryId,
  onViewQuery,
}: {
  scopes: readonly EventQueryScope[] | undefined
  queryId: string | undefined
  onViewQuery?: (queryId: string) => void
}) {
  const { colors } = useDevtoolsTheme()
  if (!scopes || scopes.length === 0) {
    return <span style={{ color: colors.faint }}>—</span>
  }
  const scope = scopes[0]!
  const tone = scopes.some(item => item.kind === 'root')
    ? 'amber'
    : scopes.some(item => item.kind === 'nested')
      ? 'blue'
      : 'neutral'
  const badge = (
    <Badge
      tone={tone}
      tooltip={[...scopes.map(item => item.title), queryId ? `query id: ${queryId}` : '']
        .filter(Boolean)
        .join('\n')}
    >
      {scopes.length === 1 ? scope.label : `${scopes.length} scopes`}
    </Badge>
  )
  return queryId && onViewQuery ? (
    <button
      type='button'
      data-tooltip={`Open query ${queryId}`}
      onClick={event => {
        event.stopPropagation()
        onViewQuery(queryId)
      }}
      style={{
        border: 0,
        padding: 0,
        background: 'transparent',
        textAlign: 'left',
        cursor: 'pointer',
      }}
    >
      {badge}
    </button>
  ) : (
    badge
  )
}

function EllipsisValue({ value, code = false }: { value: string; code?: boolean }) {
  const { colors, styles } = useDevtoolsTheme()
  return (
    <span
      data-tooltip={value}
      data-tooltip-overflow=''
      style={{
        ...(code ? styles.code : {}),
        color: colors.muted,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {value || '—'}
    </span>
  )
}

function EventStatus({
  status,
  tone,
}: {
  status: string
  tone: 'green' | 'amber' | 'red' | 'blue' | 'neutral'
}) {
  const { colors } = useDevtoolsTheme()
  return (
    <span
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        color: toneColor(colors, tone),
        fontSize: 11,
        lineHeight: '14px',
      }}
    >
      <span
        aria-hidden='true'
        style={{ width: 6, height: 6, borderRadius: 999, background: 'currentColor' }}
      />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {status}
      </span>
    </span>
  )
}

function EventKind({ kind }: { kind: string }) {
  const { colors } = useDevtoolsTheme()
  return (
    <span
      style={{
        color: colors.text,
        fontWeight: 600,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {kind}
    </span>
  )
}
