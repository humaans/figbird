import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { formatClock, formatMs } from './format.js'
import { JsonViewer } from './JsonViewer.js'
import type { TimelineRange } from './TimelineOverview.js'
import { TimelineOverview } from './TimelineOverview.js'
import type { TimelineActivity, TimelineExtent } from './timelineModel.js'
import {
  Badge,
  ColumnResizeHandle,
  DetailBlock,
  DetailSection,
  DetailStat,
  DetailStats,
  DetailsPane,
  buttonStyle,
  toneColor,
  useDetailsPaneWidth,
  useResizableColumns,
  useDevtoolsTheme,
} from './ui.js'

const FOLLOW_THRESHOLD = 24

export type TimelineVisibility = 'all' | 'fetch' | 'realtime' | 'write' | 'connection' | 'errors'

const COLUMNS = [
  { label: 'time', width: 96, minWidth: 78 },
  { label: 'activity', width: 145, minWidth: 100 },
  { label: 'operation', width: 85, minWidth: 70 },
  { label: 'context', width: 120, minWidth: 80 },
  { label: 'status', width: 84, minWidth: 70 },
  { label: 'trigger', width: 100, minWidth: 75 },
  { label: 'cacheEffect', width: 125, minWidth: 90 },
  { label: 'result', width: 115, minWidth: 80 },
  { label: 'duration', width: 74, minWidth: 60 },
  { label: 'waterfall', width: 200, minWidth: 130 },
] as const

export function TimelineActivityTable({
  activities,
  extent,
  nowPoint,
  wallClockOffset,
  filter,
  visibility,
  follow,
  onFollowChange,
  onTraceSelect,
}: {
  activities: readonly TimelineActivity[]
  extent: TimelineExtent | null
  nowPoint: number
  wallClockOffset: number
  filter: string
  visibility: TimelineVisibility
  follow: boolean
  onFollowChange: (value: boolean) => void
  onTraceSelect?: (traceId: number) => void
}) {
  const { colors, styles } = useDevtoolsTheme()
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollPausedFollowRef = useRef(false)
  const [range, setRange] = useState<TimelineRange | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [availableTableWidth, setAvailableTableWidth] = useState(0)
  const [columnWidths, onColumnResizeStart] = useResizableColumns(COLUMNS)
  const [detailsWidth, onDetailsResizeStart] = useDetailsPaneWidth()
  const hasExtent = extent !== null
  const selected = activities.find(activity => activity.id === selectedId)
  const normalizedFilter = filter.trim().toLowerCase()
  const filteredActivities = activities.filter(activity => {
    if (
      visibility === 'errors'
        ? !activity.error
        : visibility !== 'all' && activity.kind !== visibility
    ) {
      return false
    }
    return normalizedFilter ? activity.searchText.includes(normalizedFilter) : true
  })
  const rows = range
    ? filteredActivities.filter(activity => intersects(activity, range, nowPoint))
    : filteredActivities
  const inFlightWriteCount = activities.filter(
    activity => activity.kind === 'write' && activity.status === 'in-flight',
  ).length
  const projectedWriteCount = activities.filter(
    activity =>
      activity.kind === 'write' && activity.status === 'in-flight' && activity.write?.optimistic,
  ).length
  const latestVisibleActivityId = rows.at(-1)?.id
  const waterfallIndex = COLUMNS.length - 1
  const fixedColumnsWidth = columnWidths
    .slice(0, waterfallIndex)
    .reduce((sum, width) => sum + width, 0)
  const waterfallWidth = Math.max(
    columnWidths[waterfallIndex]!,
    availableTableWidth - fixedColumnsWidth,
  )
  const renderedColumnWidths = columnWidths.map((width, index) =>
    index === waterfallIndex ? waterfallWidth : width,
  )
  const totalWidth = renderedColumnWidths.reduce((sum, width) => sum + width, 0)

  useEffect(() => {
    if (follow) setRange(null)
  }, [follow])

  useEffect(() => {
    if (selectedId && !activities.some(activity => activity.id === selectedId)) setSelectedId(null)
  }, [activities, selectedId])

  useEffect(() => setSelectedId(null), [filter, visibility])

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || !follow) return
    scrollPausedFollowRef.current = false
    scroll.scrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight)
  }, [follow, latestVisibleActivityId])

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return

    const measure = () => {
      setAvailableTableWidth(current =>
        current === scroll.clientWidth ? current : scroll.clientWidth,
      )
    }

    measure()
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(measure)
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [hasExtent])

  if (!extent) {
    return (
      <div style={{ ...styles.scroll, height: 'auto', flex: 1, minHeight: 0 }}>
        <div style={{ padding: 16, color: colors.muted }}>
          No timeline activity yet. Recording continues until you press Clear.
        </div>
      </div>
    )
  }

  const displayExtent = range ?? extent
  const visibleSelection =
    selected && rows.some(activity => activity.id === selected.id) ? selected : null

  return (
    <>
      <TimelineOverview
        activities={filteredActivities}
        extent={extent}
        range={range}
        nowPoint={nowPoint}
        onRangeChange={next => {
          setRange(next)
          setSelectedId(null)
          if (next) {
            scrollPausedFollowRef.current = false
            onFollowChange(false)
          }
        }}
      />
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex' }}>
        <div
          ref={scrollRef}
          aria-label='Timeline activity'
          style={{ ...styles.scroll, flex: 1, minWidth: 0 }}
          onScroll={event => {
            const scroll = event.currentTarget
            const distance = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop
            if (distance > FOLLOW_THRESHOLD) {
              if (follow) {
                scrollPausedFollowRef.current = true
                onFollowChange(false)
              }
              return
            }
            if (!follow && scrollPausedFollowRef.current) {
              scrollPausedFollowRef.current = false
              onFollowChange(true)
            }
          }}
        >
          <table style={{ ...styles.table, minWidth: totalWidth, width: totalWidth }}>
            <colgroup>
              {COLUMNS.map((column, index) => (
                <col key={column.label} style={{ width: renderedColumnWidths[index] }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {COLUMNS.map((column, index) => (
                  <th key={column.label} style={{ ...styles.th, position: 'sticky' }}>
                    {column.label}
                    {column.label === 'waterfall' && displayExtent ? (
                      <span style={{ color: colors.faint, marginLeft: 7, fontWeight: 400 }}>
                        {formatOffset(displayExtent.end - displayExtent.start)}
                      </span>
                    ) : null}
                    <ColumnResizeHandle
                      label={column.label}
                      onMouseDown={event => onColumnResizeStart(index, event)}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(activity => (
                <ActivityRow
                  key={activity.id}
                  activity={activity}
                  selected={activity.id === selectedId}
                  extent={displayExtent}
                  nowPoint={nowPoint}
                  wallClockOffset={wallClockOffset}
                  onSelect={() => setSelectedId(activity.id)}
                />
              ))}
            </tbody>
          </table>
          {rows.length === 0 ? (
            <div style={{ padding: 16, color: colors.muted }}>No matching activity recorded.</div>
          ) : null}
        </div>
        {visibleSelection ? (
          <ActivityDetails
            activity={visibleSelection}
            wallClockOffset={wallClockOffset}
            width={detailsWidth}
            onResizeStart={onDetailsResizeStart}
            onClose={() => setSelectedId(null)}
            {...(onTraceSelect ? { onTraceSelect } : {})}
          />
        ) : null}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          minHeight: 27,
          padding: '0 10px',
          flexShrink: 0,
          color: colors.muted,
          borderTop: `1px solid ${colors.border}`,
          background: colors.toolbar,
        }}
      >
        <span>
          {rows.length} / {activities.length} activities
        </span>
        <span>{rows.filter(activity => activity.kind === 'fetch').length} fetches</span>
        <span>{rows.filter(activity => activity.error).length} errors</span>
        {inFlightWriteCount > 0 ? <span>{inFlightWriteCount} writes in flight</span> : null}
        {projectedWriteCount > 0 ? <span>{projectedWriteCount} projected</span> : null}
        <span>{formatMs(displayExtent.end - displayExtent.start)} window</span>
        <span style={{ marginLeft: 'auto' }}>
          {range ? (
            <button
              type='button'
              aria-label='Clear timeline range'
              title='Show the full recording'
              onClick={() => {
                setRange(null)
                setSelectedId(null)
              }}
              style={buttonStyle(colors, true)}
            >
              {formatOffset(range.start - extent.start)}–{formatOffset(range.end - extent.start)} ×
            </button>
          ) : (
            <span style={{ color: colors.faint, whiteSpace: 'nowrap' }}>
              Drag overview to filter time
            </span>
          )}
        </span>
      </div>
    </>
  )
}

function ActivityRow({
  activity,
  selected,
  extent,
  nowPoint,
  wallClockOffset,
  onSelect,
}: {
  activity: TimelineActivity
  selected: boolean
  extent: TimelineExtent
  nowPoint: number
  wallClockOffset: number
  onSelect: () => void
}) {
  const { colors, styles } = useDevtoolsTheme()
  return (
    <tr
      data-timeline-activity={activity.kind}
      aria-selected={selected}
      tabIndex={0}
      title='Select activity details'
      onClick={onSelect}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
      style={{
        cursor: 'pointer',
        outline: 'none',
        background: selected ? colors.activeButtonBg : undefined,
        boxShadow: selected ? `inset 3px 0 ${colors.blue}` : undefined,
      }}
    >
      <td style={{ ...styles.td, ...styles.code, color: colors.faint, whiteSpace: 'nowrap' }}>
        {formatClock(wallClockOffset + activity.startAt, { milliseconds: true })}
      </td>
      <td style={styles.td}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          <ActivityIcon activity={activity} />
          <strong
            title={activity.label}
            style={{
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontWeight: 650,
            }}
          >
            {activity.label}
          </strong>
        </span>
      </td>
      <EllipsisCell value={activity.operation} />
      <EllipsisCell value={activity.detail || '—'} />
      <td style={styles.td}>
        <Badge tone={activity.tone}>{activity.status}</Badge>
      </td>
      <EllipsisCell value={activity.trigger} />
      <EllipsisCell value={activity.effect} />
      <EllipsisCell value={activity.result} error={activity.error} />
      <td style={{ ...styles.td, ...styles.code, color: colors.muted, whiteSpace: 'nowrap' }}>
        {activity.durationMs === undefined ? '—' : formatMs(activity.durationMs)}
      </td>
      <td style={{ ...styles.td, paddingBlock: 0 }}>
        <Waterfall activity={activity} extent={extent} nowPoint={nowPoint} />
      </td>
    </tr>
  )
}

function EllipsisCell({ value, error = false }: { value: string; error?: boolean }) {
  const { colors, styles } = useDevtoolsTheme()
  return (
    <td
      title={value}
      style={{
        ...styles.td,
        color: error ? colors.red : value === '—' ? colors.faint : colors.muted,
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis',
      }}
    >
      {value}
    </td>
  )
}

function ActivityIcon({ activity }: { activity: TimelineActivity }) {
  const { colors } = useDevtoolsTheme()
  const color = toneColor(colors, activity.tone)
  const symbol =
    activity.kind === 'fetch'
      ? '↗'
      : activity.kind === 'realtime'
        ? '◆'
        : activity.kind === 'write'
          ? '✎'
          : '●'
  return (
    <span
      aria-hidden='true'
      style={{
        width: 16,
        flexShrink: 0,
        color,
        font:
          activity.kind === 'fetch' ? '700 15px/1 ui-monospace, monospace' : '11px/1 sans-serif',
        textAlign: 'center',
      }}
    >
      {symbol}
    </span>
  )
}

function Waterfall({
  activity,
  extent,
  nowPoint,
}: {
  activity: TimelineActivity
  extent: TimelineExtent
  nowPoint: number
}) {
  const { colors } = useDevtoolsTheme()
  const duration = Math.max(1, extent.end - extent.start)
  const left = Math.max(0, Math.min(100, ((activity.startAt - extent.start) / duration) * 100))
  const end = activity.endAt ?? nowPoint
  const right = Math.max(left, Math.min(100, ((end - extent.start) / duration) * 100))
  const point = activity.kind === 'realtime' || activity.kind === 'connection'
  const color = toneColor(colors, activity.tone)
  return (
    <div
      style={{
        position: 'relative',
        height: 26,
        overflow: 'hidden',
        backgroundImage: `repeating-linear-gradient(to right, ${colors.rowBorder} 0, ${colors.rowBorder} 1px, transparent 1px, transparent 25%)`,
      }}
    >
      <span
        {...(activity.kind === 'fetch' ? { 'data-timeline-fetch': activity.status } : {})}
        {...(activity.kind === 'connection' && activity.error
          ? { 'data-timeline-outage': 'offline' }
          : {})}
        aria-hidden='true'
        style={{
          position: 'absolute',
          top: point ? 8 : 9,
          left: `${left}%`,
          width: point ? 8 : `max(4px, ${right - left}%)`,
          height: point ? 8 : 7,
          marginLeft: point ? -4 : 0,
          borderRadius: point ? (activity.kind === 'realtime' ? 2 : 999) : 999,
          background: color,
          boxShadow: `0 0 0 1px ${colors.bg}`,
          transform: activity.kind === 'realtime' ? 'rotate(45deg)' : undefined,
        }}
      />
    </div>
  )
}

function ActivityDetails({
  activity,
  wallClockOffset,
  width,
  onResizeStart,
  onClose,
  onTraceSelect,
}: {
  activity: TimelineActivity
  wallClockOffset: number
  width: number
  onResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void
  onClose: () => void
  onTraceSelect?: (traceId: number) => void
}) {
  const { colors } = useDevtoolsTheme()
  return (
    <DetailsPane
      title={
        activity.operation === 'action' ? activity.label : `${activity.label}.${activity.operation}`
      }
      subtitle={activity.write?.type ?? activity.kind}
      width={width}
      onResizeStart={onResizeStart}
      onClose={onClose}
    >
      <DetailStats>
        <DetailStat label='Operation' value={activity.operation} />
        {activity.detail ? <DetailStat label='Context' value={activity.detail} /> : null}
        <DetailStat label='Status' value={activity.status} />
        <DetailStat
          label='Started'
          value={formatClock(wallClockOffset + activity.startAt, { milliseconds: true })}
        />
        <DetailStat label='Trigger' value={activity.trigger} />
        <DetailStat label='Cache effect' value={activity.effect} />
        <DetailStat label='Result' value={activity.result} />
        <DetailStat
          label='Duration'
          value={activity.durationMs === undefined ? '—' : formatMs(activity.durationMs)}
        />
        {activity.serviceName ? <DetailStat label='Service' value={activity.serviceName} /> : null}
        {activity.queryId ? <DetailStat label='Query ID' value={activity.queryId} /> : null}
        {activity.write?.type === 'mutation' ? (
          <DetailStat
            label='Cache mode'
            value={activity.write.optimistic ? 'projected immediately' : 'after confirmation'}
          />
        ) : null}
        {activity.write ? <DetailStat label='Write ID' value={activity.write.id} /> : null}
        {activity.write?.initiatingAction ? (
          <DetailStat label='Action' value={activity.write.initiatingAction.name} />
        ) : null}
        {activity.write?.initiatingAction?.durationMs !== undefined ? (
          <DetailStat
            label='Action duration'
            value={formatMs(activity.write.initiatingAction.durationMs)}
          />
        ) : null}
      </DetailStats>
      {activity.write ? (
        <>
          <DetailBlock>
            <JsonViewer value={activity.write.payload} label='Payload' emptyLabel='No payload' />
          </DetailBlock>
          <DetailBlock>
            <JsonViewer value={activity.write.args} label='Arguments' />
          </DetailBlock>
        </>
      ) : activity.kind === 'fetch' ? (
        <>
          {activity.payload !== undefined ? (
            <DetailBlock>
              <JsonViewer value={activity.payload} label='Parameters' />
            </DetailBlock>
          ) : null}
          <DetailBlock>
            <JsonViewer
              value={activity.data}
              label='Current query data'
              emptyLabel='No query data captured'
            />
          </DetailBlock>
        </>
      ) : activity.kind === 'realtime' ? (
        <DetailBlock>
          <JsonViewer
            value={activity.payload}
            label='Event payload'
            emptyLabel='No event payload captured'
          />
        </DetailBlock>
      ) : activity.kind === 'connection' ? (
        <DetailBlock>
          <JsonViewer
            value={activity.payload}
            label='Connection event'
            emptyLabel='No connection event captured'
          />
        </DetailBlock>
      ) : null}
      {activity.traceId !== undefined && onTraceSelect ? (
        <DetailSection label='Causal trace'>
          <button
            type='button'
            onClick={() => onTraceSelect(activity.traceId!)}
            style={{ ...buttonStyle(colors, true), width: '100%', textAlign: 'left' }}
          >
            Open trace #{activity.traceId} in Events →
          </button>
        </DetailSection>
      ) : null}
    </DetailsPane>
  )
}

function intersects(activity: TimelineActivity, range: TimelineRange, nowPoint: number): boolean {
  const end = activity.endAt ?? nowPoint
  return activity.startAt <= range.end && end >= range.start
}

function formatOffset(value: number): string {
  if (value < 1_000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.round((value % 60_000) / 1_000)
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
}
