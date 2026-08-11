import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DevtoolsSnapshot, QueryRecord, QuerySpan } from './collector.js'
import { compactJson, formatClock, formatMs, now } from './format.js'
import type { DevtoolsModel, EventQueryScope } from './model.js'
import {
  TimelineOverview,
  TIMELINE_LABEL_WIDTH as LABEL_WIDTH,
  type TimelineViewport,
} from './TimelineOverview.js'
import { buttonStyle, useDevtoolsTheme } from './ui.js'

const MIN_TRACK_WIDTH = 680
const PIXELS_PER_SECOND = 64
const END_GUTTER_MS = 1_000
const GRID_TICK_MS = 5_000
const FOLLOW_THRESHOLD = 24

type RawTimelineLane =
  | {
      kind: 'query'
      id: string
      label: string
      context: string
      detail: string
      firstAt: number
      query: QueryRecord
    }
  | {
      kind: 'realtime'
      id: string
      label: string
      detail: string
      firstAt: number
      ticks: number[]
    }

type VisibleTimelineLane =
  | {
      kind: 'query'
      id: string
      label: string
      context: string
      detail: string
      firstAt: number
      bars: QuerySpan[]
    }
  | {
      kind: 'realtime'
      id: string
      label: string
      detail: string
      firstAt: number
      ticks: number[]
    }

interface TimelineLayout {
  start: number
  end: number
  trackWidth: number
  ticks: number[]
}

export function TimelineFollowControl({
  value,
  onChange,
}: {
  value: boolean
  onChange: (value: boolean) => void
}) {
  const { colors } = useDevtoolsTheme()
  return (
    <button
      type='button'
      aria-label={value ? 'Pause live timeline' : 'Resume live timeline'}
      aria-pressed={value}
      onClick={() => onChange(!value)}
      title={
        value
          ? 'Following new timeline activity. Scroll left or click to pause.'
          : 'Return to the latest timeline activity.'
      }
      style={{
        ...buttonStyle(colors, value),
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <span
        aria-hidden='true'
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: value ? colors.green : colors.faint,
        }}
      />
      {value ? 'Live' : 'Resume live'}
    </button>
  )
}

export function TimelineTab({
  snapshot,
  model,
  follow,
  onFollowChange,
}: {
  snapshot: DevtoolsSnapshot
  model: DevtoolsModel
  follow: boolean
  onFollowChange: (value: boolean) => void
}) {
  const { colors, styles } = useDevtoolsTheme()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<TimelineViewport>({ left: 0, width: 1 })
  const rawLanes = useMemo(() => {
    const realtimeByService = new Map<string, number[]>()
    for (const item of snapshot.timeline.realtime) {
      const ticks = realtimeByService.get(item.serviceName) ?? []
      ticks.push(item.at)
      realtimeByService.set(item.serviceName, ticks)
    }
    const queryLanes: RawTimelineLane[] = snapshot.queries
      .filter(query => query.spans.length > 0)
      .map(query => {
        const scopes = model.scopesByQueryId.get(query.queryId)
        return {
          kind: 'query',
          id: `query:${query.queryId}`,
          label: `${query.serviceName}.${query.method}`,
          context: timelineScopeLabel(scopes),
          detail: timelineQueryDetail(query, scopes),
          firstAt: Math.min(...query.spans.map(span => span.startAt)),
          query,
        }
      })
    const realtimeLanes: RawTimelineLane[] = [...realtimeByService].map(([serviceName, ticks]) => ({
      kind: 'realtime',
      id: `realtime:${serviceName}`,
      label: `${serviceName} realtime`,
      detail: `All retained realtime events emitted by ${serviceName}`,
      firstAt: Math.min(...ticks),
      ticks,
    }))
    return [...queryLanes, ...realtimeLanes]
  }, [model.scopesByQueryId, snapshot.queries, snapshot.timeline.realtime])
  const hasInFlight = rawLanes.some(
    lane => lane.kind === 'query' && lane.query.spans.some(span => span.endAt === undefined),
  )
  const nowPoint = useTimelineNow(hasInFlight)
  const wallClockOffset = Date.now() - now()
  const layout = timelineLayout(rawLanes, snapshot.timeline.startedAt, nowPoint)
  const lanes: VisibleTimelineLane[] = rawLanes.map(lane =>
    lane.kind === 'query'
      ? {
          kind: lane.kind,
          id: lane.id,
          label: lane.label,
          context: lane.context,
          detail: lane.detail,
          firstAt: lane.firstAt,
          bars: lane.query.spans,
        }
      : lane,
  )
  const laneOrder = new Map(snapshot.timeline.laneOrder.map((id, index) => [id, index]))
  lanes.sort((a, b) => {
    const recordedOrder =
      (laneOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (laneOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    if (recordedOrder !== 0) return recordedOrder
    const first = a.firstAt - b.firstAt
    if (first !== 0) return first
    return a.id.localeCompare(b.id)
  })
  const trackWidth = layout?.trackWidth
  const updateViewport = useCallback(() => {
    const scroll = scrollRef.current
    if (!scroll || trackWidth === undefined) return
    const visibleTrackWidth = Math.max(1, scroll.clientWidth - LABEL_WIDTH)
    const next = {
      left: Math.max(0, Math.min(1, scroll.scrollLeft / trackWidth)),
      width: Math.max(0, Math.min(1, visibleTrackWidth / trackWidth)),
    }
    setViewport(current =>
      Math.abs(current.left - next.left) < 0.0001 && Math.abs(current.width - next.width) < 0.0001
        ? current
        : next,
    )
  }, [trackWidth])

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || !follow || trackWidth === undefined) return
    scroll.scrollLeft = Math.max(0, scroll.scrollWidth - scroll.clientWidth)
    scroll.scrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight)
    updateViewport()
  }, [follow, lanes.length, trackWidth, updateViewport])

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    updateViewport()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateViewport)
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [updateViewport])

  return (
    <section style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {layout ? (
        <TimelineOverview
          lanes={lanes}
          layout={layout}
          nowPoint={nowPoint}
          viewport={viewport}
          onNavigate={ratio => {
            const scroll = scrollRef.current
            if (!scroll) return
            const visibleTrackWidth = Math.max(1, scroll.clientWidth - LABEL_WIDTH)
            scroll.scrollLeft = Math.max(
              0,
              Math.min(
                layout.trackWidth - visibleTrackWidth,
                ratio * layout.trackWidth - visibleTrackWidth / 2,
              ),
            )
            onFollowChange(false)
            updateViewport()
          }}
        />
      ) : null}
      <div
        ref={scrollRef}
        style={{ ...styles.scroll, height: 'auto', flex: 1, minHeight: 0 }}
        onScroll={event => {
          updateViewport()
          if (!follow) return
          const scroll = event.currentTarget
          const horizontalDistance = scroll.scrollWidth - scroll.clientWidth - scroll.scrollLeft
          const verticalDistance = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop
          if (horizontalDistance > FOLLOW_THRESHOLD || verticalDistance > FOLLOW_THRESHOLD) {
            onFollowChange(false)
          }
        }}
      >
        {layout ? (
          <div
            style={{
              ...styles.timeline,
              width: LABEL_WIDTH + layout.trackWidth,
              minWidth: LABEL_WIDTH + layout.trackWidth,
            }}
          >
            <TimelineAxis layout={layout} wallClockOffset={wallClockOffset} />
            {lanes.map(lane => (
              <TimelineLane
                key={lane.id}
                label={lane.label}
                {...(lane.kind === 'query' ? { context: lane.context } : {})}
                detail={lane.detail}
                layout={layout}
                bars={lane.kind === 'query' ? lane.bars : []}
                ticks={lane.kind === 'realtime' ? lane.ticks : []}
                nowPoint={nowPoint}
                wallClockOffset={wallClockOffset}
              />
            ))}
          </div>
        ) : (
          <div style={{ padding: 16, color: colors.muted }}>
            No timeline activity yet. Recording continues until you press Clear.
          </div>
        )}
      </div>
    </section>
  )
}

function useTimelineNow(running: boolean): number {
  const [value, setValue] = useState(now)
  useEffect(() => {
    setValue(now())
    if (!running) return
    const interval = setInterval(() => setValue(now()), 1_000)
    return () => clearInterval(interval)
  }, [running])
  return value
}

function TimelineAxis({
  layout,
  wallClockOffset,
}: {
  layout: TimelineLayout
  wallClockOffset: number
}) {
  const { colors } = useDevtoolsTheme()
  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 3,
        display: 'grid',
        gridTemplateColumns: `${LABEL_WIDTH}px ${layout.trackWidth}px`,
        minHeight: 38,
        background: colors.bg,
      }}
    >
      <div
        title={`Recording started ${formatTimelineClock(layout.start, wallClockOffset, true)}`}
        style={{
          position: 'sticky',
          left: 0,
          zIndex: 2,
          color: colors.muted,
          padding: '7px 12px 0 0',
          borderBottom: `1px solid ${colors.border}`,
          background: colors.bg,
        }}
      >
        <TimelineLegend />
      </div>
      <div
        style={{
          position: 'relative',
          width: layout.trackWidth,
          borderBottom: `1px solid ${colors.border}`,
        }}
      >
        {layout.ticks.map(tick => (
          <span
            key={tick}
            style={{
              position: 'absolute',
              left: timeToPixels(tick, layout.start),
              top: 0,
              bottom: 0,
              borderLeft: `1px solid ${colors.rowBorder}`,
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: 9,
                left: 6,
                color: colors.muted,
                whiteSpace: 'nowrap',
              }}
              title={formatTimelineClock(tick, wallClockOffset, true)}
            >
              {formatTimelineOffset(tick - layout.start)}
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}

function timelineLayout(
  lanes: RawTimelineLane[],
  startedAt: number,
  nowPoint: number,
): TimelineLayout | null {
  const points: number[] = []
  for (const lane of lanes) {
    if (lane.kind === 'query') {
      for (const span of lane.query.spans) {
        points.push(span.startAt, span.endAt ?? nowPoint)
      }
    } else {
      points.push(...lane.ticks)
    }
  }
  if (points.length === 0) return null
  const earliest = Math.min(...points)
  const start = startedAt > 0 ? Math.min(startedAt, earliest) : earliest
  const latest = Math.max(...points)
  const minimumDuration = (MIN_TRACK_WIDTH / PIXELS_PER_SECOND) * 1_000
  const duration = Math.max(minimumDuration, latest - start + END_GUTTER_MS)
  const end = start + duration
  const trackWidth = Math.ceil((duration / 1_000) * PIXELS_PER_SECOND)
  return { start, end, trackWidth, ticks: timelineAxisTicks(start, end) }
}

function timelineQueryDetail(
  query: QueryRecord,
  scopes: readonly EventQueryScope[] | undefined,
): string {
  const scope = scopes?.map(item => item.label).join(', ')
  const queryDetail =
    query.method === 'get'
      ? query.resourceId === undefined
        ? ''
        : `#${query.resourceId}`
      : query.query === undefined || Object.keys(query.query).length === 0
        ? ''
        : compactJson(query.query)
  return [scope, queryDetail, `query id: ${query.queryId}`].filter(Boolean).join(' · ')
}

function timelineScopeLabel(scopes: readonly EventQueryScope[] | undefined): string {
  if (!scopes || scopes.length === 0) return 'retained'
  if (scopes.length === 1) return scopes[0]!.label
  return `${scopes.length} scopes`
}

function timelineAxisTicks(start: number, end: number): number[] {
  const count = Math.floor((end - start) / GRID_TICK_MS)
  return Array.from({ length: count + 1 }, (_, index) => start + GRID_TICK_MS * index)
}

function formatTimelineOffset(value: number): string {
  const seconds = Math.round(value / 1_000)
  if (seconds < 60) return seconds === 0 ? '0s' : `+${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder === 0 ? `+${minutes}m` : `+${minutes}m ${remainder}s`
}

function TimelineLegend() {
  const { colors } = useDevtoolsTheme()
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9, color: colors.muted }}>
      <TimelineLegendItem color={colors.green} shape='bar' label='fetch' />
      <TimelineLegendItem color={colors.blue} shape='dot' label='realtime' />
      <TimelineLegendItem color={colors.red} shape='bar' label='failed' />
    </span>
  )
}

function TimelineLegendItem({
  color,
  shape,
  label,
}: {
  color: string
  shape: 'bar' | 'dot'
  label: string
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
      <span
        aria-hidden='true'
        style={{
          width: shape === 'dot' ? 6 : 20,
          height: shape === 'dot' ? 6 : 7,
          borderRadius: 999,
          background: color,
          display: 'inline-block',
        }}
      />
      {label}
    </span>
  )
}

function TimelineLane({
  label,
  context,
  detail,
  layout,
  bars,
  ticks,
  nowPoint,
  wallClockOffset,
}: {
  label: string
  context?: string
  detail: string
  layout: TimelineLayout
  bars: Array<{ startAt: number; endAt?: number; ok?: boolean }>
  ticks: number[]
  nowPoint: number
  wallClockOffset: number
}) {
  const { colors, styles } = useDevtoolsTheme()
  return (
    <div
      data-timeline-lane={label}
      style={{
        ...styles.lane,
        gridTemplateColumns: `${LABEL_WIDTH}px ${layout.trackWidth}px`,
        width: LABEL_WIDTH + layout.trackWidth,
      }}
    >
      <div
        style={{
          ...styles.laneLabel,
          position: 'sticky',
          left: 0,
          zIndex: 1,
          background: colors.bg,
        }}
        title={detail ? `${label} ${detail}` : label}
      >
        <span style={{ color: colors.text, fontWeight: 600 }}>{label}</span>
        {context ? (
          <span style={{ color: colors.faint, marginLeft: 6, whiteSpace: 'nowrap' }}>
            {context}
          </span>
        ) : null}
      </div>
      <div style={{ ...styles.laneTrack, width: layout.trackWidth }}>
        {layout.ticks.map(tick => (
          <span
            key={tick}
            aria-hidden='true'
            style={{
              position: 'absolute',
              insetBlock: 0,
              left: timeToPixels(tick, layout.start),
              borderLeft: `1px solid ${colors.rowBorder}`,
            }}
          />
        ))}
        {bars.map((bar, index) => {
          const barEnd = bar.endAt ?? nowPoint
          const left = timeToPixels(bar.startAt, layout.start)
          const width = Math.max(9, timeToPixels(barEnd, bar.startAt))
          const color = bar.ok === false ? colors.red : colors.green
          return (
            <span
              key={`${bar.startAt}:${index}`}
              data-timeline-fetch={bar.ok === false ? 'failed' : 'success'}
              title={[
                `${bar.ok === false ? 'Failed fetch' : 'Fetch'} · ${formatMs(barEnd - bar.startAt)}`,
                formatTimelineClock(bar.startAt, wallClockOffset, true),
              ].join('\n')}
              style={{
                position: 'absolute',
                top: 13,
                left,
                width,
                height: 8,
                overflow: 'hidden',
                borderRadius: 999,
                background: `linear-gradient(180deg, color-mix(in srgb, ${color} 76%, white), ${color})`,
                boxShadow: `0 0 0 1px color-mix(in srgb, ${color} 62%, ${colors.bg})`,
              }}
            >
              <span
                aria-hidden='true'
                style={{
                  position: 'absolute',
                  insetBlock: 1,
                  left: 2,
                  width: 2,
                  borderRadius: 999,
                  background: bar.ok === false ? colors.amber : colors.blue,
                  opacity: 0.9,
                }}
              />
            </span>
          )
        })}
        {ticks.map((tick, index) => (
          <span
            key={`${tick}:${index}`}
            title={`Realtime event\n${formatTimelineClock(tick, wallClockOffset, true)}`}
            style={{
              position: 'absolute',
              top: 9,
              left: timeToPixels(tick, layout.start),
              width: 7,
              height: 7,
              marginLeft: -4,
              borderRadius: 2,
              background: colors.blue,
              boxShadow: `0 0 0 1px ${colors.bg}`,
              transform: 'rotate(45deg)',
            }}
          />
        ))}
      </div>
    </div>
  )
}

function timeToPixels(value: number, start: number): number {
  return Math.max(0, ((value - start) / 1_000) * PIXELS_PER_SECOND)
}

function formatTimelineClock(
  value: number,
  wallClockOffset: number,
  milliseconds: boolean,
): string {
  return formatClock(wallClockOffset + value, { milliseconds })
}
