import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react'
import { formatClock, formatMs } from './format.js'
import { JsonViewer } from './JsonViewer.js'
import { historicalValue } from './historicalValue.js'
import type { TimelineRange } from './TimelineOverview.js'
import { TimelineOverview } from './TimelineOverview.js'
import {
  timelineActivityMatchesFilter,
  type TimelineActivity,
  type TimelineExtent,
} from './timelineModel.js'
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
  { label: 'cache effect', width: 125, minWidth: 90 },
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
  requestedActivityId,
  onRequestedActivityHandled,
  onQuerySelect,
  onCacheEntitySelect,
  onTraceSelect,
  evictedCount = 0,
  payloadsEvicted = 0,
}: {
  activities: readonly TimelineActivity[]
  extent: TimelineExtent | null
  nowPoint: number
  wallClockOffset: number
  filter: string
  visibility: TimelineVisibility
  follow: boolean
  onFollowChange: (value: boolean) => void
  requestedActivityId?: string
  onRequestedActivityHandled?: () => void
  onQuerySelect?: (queryId: string) => void
  onCacheEntitySelect?: (serviceName: string, itemId: string | number) => void
  onTraceSelect?: (traceId: number) => void
  evictedCount?: number
  payloadsEvicted?: number
}) {
  const { colors, styles } = useDevtoolsTheme()
  const scrollRef = useRef<HTMLDivElement>(null)
  const selectedRowRef = useRef<HTMLTableRowElement>(null)
  const scrollPausedFollowRef = useRef(false)
  const [range, setRange] = useState<TimelineRange | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [relatedOnly, setRelatedOnly] = useState<string | null>(null)
  const [availableTableWidth, setAvailableTableWidth] = useState(0)
  const [columnWidths, onColumnResizeStart] = useResizableColumns(COLUMNS)
  const [detailsWidth, onDetailsResizeStart] = useDetailsPaneWidth()
  const hasExtent = extent !== null
  const selected = activities.find(activity => activity.id === selectedId)
  const selectedGraphKeys = new Set(
    selected?.kind === 'fetch'
      ? (selected.graph ?? [])
          .filter(ref => ref.path === '(root)')
          .map(ref => timelineGraphKey(ref.operationId, ref.runId))
      : [],
  )
  const normalizedFilter = filter.trim().toLowerCase()
  const filteredActivities = activities.filter(activity => {
    if (
      visibility === 'errors'
        ? !activity.error
        : visibility !== 'all' && activity.kind !== visibility
    ) {
      return false
    }
    if (!timelineActivityMatchesFilter(activity, normalizedFilter)) return false
    return !relatedOnly || activityHasGraph(activity, relatedOnly)
  })
  const rows = range
    ? filteredActivities.filter(activity => intersects(activity, range, nowPoint))
    : filteredActivities
  const inFlightWriteCount = activities.filter(
    activity => activity.kind === 'write' && activity.status === 'pending',
  ).length
  const projectedWriteCount = activities.filter(
    activity =>
      activity.kind === 'write' && activity.status === 'pending' && activity.write?.optimistic,
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

  useEffect(() => {
    if (relatedOnly && !activities.some(activity => activityHasGraph(activity, relatedOnly))) {
      setRelatedOnly(null)
    }
  }, [activities, relatedOnly])

  useEffect(() => {
    if (!requestedActivityId) return
    if (!activities.some(activity => activity.id === requestedActivityId)) return
    setRange(null)
    setSelectedId(requestedActivityId)
    onFollowChange(false)
    onRequestedActivityHandled?.()
  }, [activities, onFollowChange, onRequestedActivityHandled, requestedActivityId])

  useLayoutEffect(() => {
    const row = selectedRowRef.current
    if (!row || typeof row.scrollIntoView !== 'function') return
    row.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

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
          No timeline activity yet. Recording continues until you press Clear recording.
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
                  related={
                    selectedGraphKeys.size > 0 &&
                    activityMatchesAnyGraph(activity, selectedGraphKeys)
                  }
                  {...(activity.id === selectedId ? { rowRef: selectedRowRef } : {})}
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
            activities={activities}
            wallClockOffset={wallClockOffset}
            width={detailsWidth}
            onResizeStart={onDetailsResizeStart}
            onClose={() => setSelectedId(null)}
            onActivitySelect={activityId => {
              setRange(null)
              setSelectedId(activityId)
              onFollowChange(false)
            }}
            relatedOnly={relatedOnly}
            onRelatedOnlyChange={setRelatedOnly}
            {...(onQuerySelect ? { onQuerySelect } : {})}
            {...(onCacheEntitySelect ? { onCacheEntitySelect } : {})}
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
        <span>{activityCount(rows, 'fetch')} fetches</span>
        <span>{activityCount(rows, 'realtime')} realtime</span>
        <span>{activityCount(rows, 'write')} writes</span>
        <span>{activityCount(rows, 'connection')} connections</span>
        <span>{rows.filter(activity => activity.error).length} errors</span>
        {inFlightWriteCount > 0 ? <span>{inFlightWriteCount} pending writes</span> : null}
        {projectedWriteCount > 0 ? <span>{projectedWriteCount} projected</span> : null}
        {evictedCount > 0 ? <span>{evictedCount} older activities evicted</span> : null}
        {payloadsEvicted > 0 ? <span>{payloadsEvicted} payloads vacuumed</span> : null}
        {relatedOnly ? (
          <button
            type='button'
            onClick={() => setRelatedOnly(null)}
            style={buttonStyle(colors, true)}
          >
            Showing query graph ×
          </button>
        ) : null}
        <span>{formatMs(displayExtent.end - displayExtent.start)} window</span>
        {range ? (
          <button
            type='button'
            aria-label='Clear timeline range'
            data-tooltip='Show the full recording'
            onClick={() => {
              setRange(null)
              setSelectedId(null)
            }}
            style={{ ...buttonStyle(colors, true), marginLeft: 'auto' }}
          >
            {formatOffset(range.start - extent.start)}–{formatOffset(range.end - extent.start)} ×
          </button>
        ) : null}
      </div>
    </>
  )
}

function activityCount(activities: readonly TimelineActivity[], kind: TimelineActivity['kind']) {
  return activities.filter(activity => activity.kind === kind).length
}

function ActivityRow({
  activity,
  selected,
  related,
  rowRef,
  extent,
  nowPoint,
  wallClockOffset,
  onSelect,
}: {
  activity: TimelineActivity
  selected: boolean
  related: boolean
  rowRef?: RefObject<HTMLTableRowElement | null>
  extent: TimelineExtent
  nowPoint: number
  wallClockOffset: number
  onSelect: () => void
}) {
  const { colors, styles } = useDevtoolsTheme()
  return (
    <tr
      ref={rowRef}
      data-timeline-activity={activity.kind}
      aria-selected={selected}
      tabIndex={0}
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
        contentVisibility: 'auto',
        containIntrinsicSize: '0 33px',
        background: selected ? colors.activeButtonBg : related ? colors.relatedRowBg : undefined,
        boxShadow: selected ? `inset 3px 0 ${colors.blue}` : undefined,
        transition: 'background 80ms ease',
      }}
    >
      <td style={{ ...styles.td, ...styles.code, color: colors.faint, whiteSpace: 'nowrap' }}>
        {formatClock(wallClockOffset + activity.startAt, { milliseconds: true })}
      </td>
      <td style={styles.td}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          <ActivityIcon activity={activity} />
          <strong
            data-tooltip={activity.label}
            data-tooltip-overflow=''
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
      <EllipsisCell value={activity.detail || '—'} tooltip={activity.detailTooltip} />
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

function EllipsisCell({
  value,
  error = false,
  tooltip,
}: {
  value: string
  error?: boolean
  tooltip?: string | undefined
}) {
  const { colors, styles } = useDevtoolsTheme()
  return (
    <td
      data-tooltip={tooltip ?? value}
      {...(tooltip ? {} : { 'data-tooltip-overflow': '' })}
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
  activities,
  wallClockOffset,
  width,
  onResizeStart,
  onClose,
  onActivitySelect,
  relatedOnly,
  onRelatedOnlyChange,
  onQuerySelect,
  onCacheEntitySelect,
  onTraceSelect,
}: {
  activity: TimelineActivity
  activities: readonly TimelineActivity[]
  wallClockOffset: number
  width: number
  onResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void
  onClose: () => void
  onActivitySelect: (activityId: string) => void
  relatedOnly: string | null
  onRelatedOnlyChange: (key: string | null) => void
  onQuerySelect?: (queryId: string) => void
  onCacheEntitySelect?: (serviceName: string, itemId: string | number) => void
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
        {activity.serviceName ? <DetailStat label='Service' value={activity.serviceName} /> : null}
        <DetailStat
          label={activity.kind === 'fetch' ? 'Method' : 'Operation'}
          value={activity.operation}
        />
        {activity.detail ? <DetailStat label='Context' value={activity.detail} /> : null}
        <DetailStat label='Status' value={activity.status} />
        <DetailStat label='Trigger' value={activity.trigger} />
        <DetailStat label='Result' value={activity.result} />
        <DetailStat label='Cache effect' value={activity.effect} />
        <DetailStat
          label='Started'
          value={formatClock(wallClockOffset + activity.startAt, { milliseconds: true })}
        />
        <DetailStat
          label='Duration'
          value={activity.durationMs === undefined ? '—' : formatMs(activity.durationMs)}
        />
        {activity.queryId ? (
          <DetailStat label='Query ID' value={activity.queryId} copyValue={activity.queryId} />
        ) : null}
        {activity.write?.type === 'mutation' ? (
          <DetailStat
            label='Cache mode'
            value={activity.write.optimistic ? 'projected immediately' : 'after confirmation'}
          />
        ) : null}
        {activity.write ? (
          <DetailStat label='Write ID' value={activity.write.id} copyValue={activity.write.id} />
        ) : null}
        {activity.traceId !== undefined ? (
          <DetailStat
            label='Trace ID'
            value={`#${activity.traceId}`}
            copyValue={String(activity.traceId)}
          />
        ) : null}
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
      {activity.error ? (
        <DetailBlock>
          <JsonViewer
            value={historicalValue(activity.errorDetails)}
            label='Error details'
            emptyLabel={
              activity.errorDetails?.state === 'evicted'
                ? 'Original error details vacuumed to keep the recording bounded'
                : 'No structured error details captured'
            }
          />
        </DetailBlock>
      ) : null}
      {activity.kind === 'fetch' && activity.graph && activity.graph.length > 0 ? (
        <QueryGraphDetails
          activity={activity}
          activities={activities}
          relatedOnly={relatedOnly}
          onRelatedOnlyChange={onRelatedOnlyChange}
          onActivitySelect={onActivitySelect}
        />
      ) : null}
      {activity.write ? (
        <>
          <DetailBlock>
            <JsonViewer
              value={historicalValue(activity.write.payload)}
              label='Payload'
              emptyLabel={
                activity.write.payload?.state === 'evicted'
                  ? 'Original payload vacuumed to keep the recording bounded'
                  : 'No payload'
              }
            />
          </DetailBlock>
          <DetailBlock>
            <JsonViewer
              value={historicalValue(activity.write.args)}
              label='Arguments'
              emptyLabel={
                activity.write.args?.state === 'evicted'
                  ? 'Original arguments vacuumed to keep the recording bounded'
                  : 'No arguments'
              }
            />
          </DetailBlock>
          {activity.write.args?.state === 'evicted' && activity.livePayload !== undefined ? (
            <DetailBlock>
              <JsonViewer
                value={activity.livePayload}
                label='Current cached entity — original write payload vacuumed'
              />
            </DetailBlock>
          ) : null}
        </>
      ) : activity.kind === 'fetch' ? (
        <>
          {activity.payload !== undefined ? (
            <DetailBlock>
              <JsonViewer
                value={historicalValue(activity.payload)}
                label='Parameters at fetch time'
                emptyLabel='Original parameters vacuumed to keep the recording bounded'
              />
            </DetailBlock>
          ) : null}
          {activity.payload?.state === 'evicted' && activity.livePayload !== undefined ? (
            <DetailBlock>
              <JsonViewer value={activity.livePayload} label='Current query parameters' />
            </DetailBlock>
          ) : null}
          <DetailBlock>
            <JsonViewer
              value={
                activity.data === undefined
                  ? activity.liveData
                  : activity.data.state === 'evicted'
                    ? undefined
                    : activity.data.value
              }
              label={activity.data ? 'Response data at fetch time' : 'Current query data'}
              emptyLabel={
                activity.data?.state === 'evicted'
                  ? 'Original response vacuumed to keep the recording bounded'
                  : 'No query data available'
              }
            />
          </DetailBlock>
          {activity.data?.state === 'evicted' && activity.liveData !== undefined ? (
            <DetailBlock>
              <JsonViewer
                value={activity.liveData}
                label={
                  activity.data?.state === 'evicted'
                    ? 'Current query data — original response vacuumed'
                    : 'Current query data'
                }
              />
            </DetailBlock>
          ) : null}
        </>
      ) : activity.kind === 'realtime' ? (
        <>
          <DetailBlock>
            <JsonViewer
              value={historicalValue(activity.payload)}
              label='Realtime payload'
              emptyLabel={
                activity.payload?.state === 'evicted'
                  ? 'Original payload vacuumed to keep the recording bounded'
                  : 'No realtime payload captured'
              }
            />
          </DetailBlock>
          {activity.payload?.state === 'evicted' && activity.livePayload !== undefined ? (
            <DetailBlock>
              <JsonViewer
                value={activity.livePayload}
                label='Current cached entity — original payload vacuumed'
              />
            </DetailBlock>
          ) : null}
        </>
      ) : activity.kind === 'connection' ? (
        <DetailBlock>
          <JsonViewer
            value={historicalValue(activity.payload)}
            label='Connection event'
            emptyLabel='No connection event captured'
          />
        </DetailBlock>
      ) : null}
      {onQuerySelect && relatedQueryIds(activity).length > 0 ? (
        <DetailSection label='Queries'>
          {relatedQueryIds(activity).map(queryId => (
            <button
              key={queryId}
              type='button'
              onClick={() => onQuerySelect(queryId)}
              style={{ ...buttonStyle(colors, false), width: '100%', textAlign: 'left' }}
            >
              Open query {queryId} →
            </button>
          ))}
        </DetailSection>
      ) : null}
      {activity.entity && onCacheEntitySelect ? (
        <DetailSection label='Cached entity'>
          <button
            type='button'
            onClick={() =>
              onCacheEntitySelect(activity.entity!.serviceName, activity.entity!.itemId)
            }
            style={{ ...buttonStyle(colors, false), width: '100%', textAlign: 'left' }}
          >
            Open {activity.entity.serviceName} #{activity.entity.itemId} in Cache →
          </button>
        </DetailSection>
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

interface QueryGraphRow {
  key: string
  path: string
  role?: 'junction'
  serviceName: string
  activities: TimelineActivity[]
}

function QueryGraphDetails({
  activity,
  activities,
  relatedOnly,
  onRelatedOnlyChange,
  onActivitySelect,
}: {
  activity: TimelineActivity
  activities: readonly TimelineActivity[]
  relatedOnly: string | null
  onRelatedOnlyChange: (key: string | null) => void
  onActivitySelect: (activityId: string) => void
}) {
  const { colors, styles } = useDevtoolsTheme()
  const runs = [
    ...new Map(
      (activity.graph ?? []).map(ref => [timelineGraphKey(ref.operationId, ref.runId), ref]),
    ).entries(),
  ]

  return (
    <DetailSection label='Query graph'>
      {runs.map(([runKey, ref]) => {
        const related = activities.filter(item => activityHasGraph(item, runKey))
        const rows = queryGraphRows(related, ref.operationId, ref.runId)
        return (
          <div key={runKey} style={{ display: 'grid', gap: 5, marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {ref.operationLabel}
              </span>
              <span style={{ color: colors.faint, whiteSpace: 'nowrap' }}>
                {related.length} {related.length === 1 ? 'fetch' : 'fetches'}
              </span>
              <button
                type='button'
                onClick={() => onRelatedOnlyChange(relatedOnly === runKey ? null : runKey)}
                style={{ ...buttonStyle(colors, relatedOnly === runKey), marginLeft: 'auto' }}
              >
                {relatedOnly === runKey ? 'Show all' : 'Show only related'}
              </button>
            </div>
            <div style={{ borderTop: `1px solid ${colors.rowBorder}` }}>
              {rows.map(row => {
                const durations = row.activities
                  .map(item => item.durationMs)
                  .filter((value): value is number => value !== undefined)
                const min = durations.length > 0 ? Math.min(...durations) : undefined
                const max = durations.length > 0 ? Math.max(...durations) : undefined
                return (
                  <button
                    key={row.key}
                    type='button'
                    onClick={() => onActivitySelect(row.activities[0]!.id)}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(110px, 1fr) minmax(70px, .7fr) auto auto',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      minHeight: 27,
                      padding: '3px 0',
                      border: 0,
                      borderBottom: `1px solid ${colors.rowBorder}`,
                      background: 'transparent',
                      color: colors.text,
                      font: 'inherit',
                      textAlign: 'left',
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{ color: row.path === '(root)' ? colors.text : colors.muted }}>
                      {row.path === '(root)'
                        ? 'root'
                        : `nested: ${row.path}${row.role === 'junction' ? ' junction' : ''}`}
                    </span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {row.serviceName}
                    </span>
                    <span style={{ color: colors.faint, whiteSpace: 'nowrap' }}>
                      {row.activities.length > 1 ? `${row.activities.length} ×` : ''}
                    </span>
                    <span style={{ ...styles.code, color: colors.muted, whiteSpace: 'nowrap' }}>
                      {min === undefined
                        ? '—'
                        : min === max
                          ? formatMs(min)
                          : `${formatMs(min)}–${formatMs(max!)}`}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </DetailSection>
  )
}

function queryGraphRows(
  activities: readonly TimelineActivity[],
  operationId: string,
  runId: string,
): QueryGraphRow[] {
  const rows = new Map<string, QueryGraphRow>()
  for (const activity of activities) {
    const ref = activity.graph?.find(
      item => item.operationId === operationId && item.runId === runId,
    )
    if (!ref) continue
    const serviceName = activity.serviceName ?? activity.label
    const key = `${ref.path}\u0000${ref.role ?? ''}\u0000${serviceName}`
    const row = rows.get(key)
    if (row) {
      row.activities.push(activity)
    } else {
      rows.set(key, {
        key,
        path: ref.path,
        ...(ref.role ? { role: ref.role } : {}),
        serviceName,
        activities: [activity],
      })
    }
  }
  return [...rows.values()].sort((a, b) => {
    if (a.path === '(root)') return -1
    if (b.path === '(root)') return 1
    return a.path.localeCompare(b.path) || a.serviceName.localeCompare(b.serviceName)
  })
}

function timelineGraphKey(operationId: string, runId: string): string {
  return `${operationId}\u0000${runId}`
}

function activityHasGraph(activity: TimelineActivity, key: string): boolean {
  return activity.graph?.some(ref => timelineGraphKey(ref.operationId, ref.runId) === key) ?? false
}

function activityMatchesAnyGraph(activity: TimelineActivity, keys: ReadonlySet<string>): boolean {
  return (
    activity.graph?.some(ref => keys.has(timelineGraphKey(ref.operationId, ref.runId))) ?? false
  )
}

function relatedQueryIds(activity: TimelineActivity): string[] {
  return [
    ...new Set([...(activity.queryId ? [activity.queryId] : []), ...(activity.queryIds ?? [])]),
  ]
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
