import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import type { QuerySpan } from './collector.js'
import { formatClock, formatMs } from './format.js'
import { TimelineOverview, type TimelineViewport } from './TimelineOverview.js'
import { toneColor, useDevtoolsTheme, type DevtoolsColors } from './ui.js'

const FOLLOW_THRESHOLD = 24
const GRID_TICK_MS = 5_000
const DEFAULT_LABEL_WIDTH = 340
const MIN_LABEL_WIDTH = 240
const MAX_LABEL_WIDTH = 640
const TIMELINE_LANE_HEIGHT = 46
export const TIMELINE_PIXELS_PER_SECOND = 64

export interface TimelineMarker {
  at: number
  label: string
  tone: 'green' | 'amber' | 'red' | 'blue' | 'neutral'
  traceId?: number
}

export interface TimelineTick {
  at: number
  traceId?: number
}

export type TimelineLane =
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
      context: string
      firstAt: number
      ticks: TimelineTick[]
    }
  | {
      kind: 'connection'
      id: string
      label: string
      detail: string
      context: string
      firstAt: number
      bars: QuerySpan[]
      markers: TimelineMarker[]
    }

export interface TimelineLayout {
  start: number
  trackWidth: number
}

interface RenderedTimelineLayout extends TimelineLayout {
  end: number
}

export function TimelineCanvas({
  lanes,
  layout,
  nowPoint,
  wallClockOffset,
  follow,
  onFollowChange,
  onTraceSelect,
}: {
  lanes: TimelineLane[]
  layout: TimelineLayout | null
  nowPoint: number
  wallClockOffset: number
  follow: boolean
  onFollowChange: (value: boolean) => void
  onTraceSelect?: (traceId: number) => void
}) {
  const { colors, styles } = useDevtoolsTheme()
  const verticalScrollRef = useRef<HTMLDivElement>(null)
  const trackScrollRef = useRef<HTMLDivElement>(null)
  const axisScrollRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<TimelineViewport>({ left: 0, width: 0 })
  const [availableTrackWidth, setAvailableTrackWidth] = useState(0)
  const [labelWidth, setLabelWidth] = useState(DEFAULT_LABEL_WIDTH)
  const hasLayout = layout !== null
  const trackWidth = layout ? Math.max(layout.trackWidth, availableTrackWidth) : undefined
  const renderedLayout: RenderedTimelineLayout | null =
    layout && trackWidth !== undefined
      ? {
          ...layout,
          end: layout.start + (trackWidth / TIMELINE_PIXELS_PER_SECOND) * 1_000,
          trackWidth,
        }
      : null
  const updateViewport = useCallback(() => {
    const scroll = trackScrollRef.current
    if (!scroll || trackWidth === undefined) return
    const visibleTrackWidth = Math.max(1, scroll.clientWidth)
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
  const onLabelResizeStart = (event: ReactMouseEvent<HTMLSpanElement>) => {
    event.preventDefault()
    const ownerWindow = event.currentTarget.ownerDocument.defaultView ?? window
    const startX = event.clientX
    const startWidth = labelWidth
    const onMove = (move: MouseEvent) => {
      setLabelWidth(
        Math.max(MIN_LABEL_WIDTH, Math.min(MAX_LABEL_WIDTH, startWidth + move.clientX - startX)),
      )
    }
    const onUp = () => {
      ownerWindow.removeEventListener('mousemove', onMove)
      ownerWindow.removeEventListener('mouseup', onUp)
    }
    ownerWindow.addEventListener('mousemove', onMove)
    ownerWindow.addEventListener('mouseup', onUp)
  }

  useLayoutEffect(() => {
    const horizontalScroll = trackScrollRef.current
    const verticalScroll = verticalScrollRef.current
    if (!horizontalScroll || !verticalScroll || !follow || trackWidth === undefined) return
    horizontalScroll.scrollLeft = Math.max(
      0,
      horizontalScroll.scrollWidth - horizontalScroll.clientWidth,
    )
    verticalScroll.scrollTop = Math.max(
      0,
      verticalScroll.scrollHeight - verticalScroll.clientHeight,
    )
    if (axisScrollRef.current) axisScrollRef.current.scrollLeft = horizontalScroll.scrollLeft
    updateViewport()
  }, [follow, lanes.length, trackWidth, updateViewport])

  useLayoutEffect(() => {
    if (!hasLayout) return
    const scroll = trackScrollRef.current
    if (!scroll) return
    const measure = () => {
      const width = scroll.clientWidth
      setAvailableTrackWidth(current => (current === width ? current : width))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [hasLayout])

  useLayoutEffect(updateViewport, [updateViewport])

  if (!layout || !renderedLayout) {
    return (
      <div style={{ ...styles.scroll, height: 'auto', flex: 1, minHeight: 0 }}>
        <div style={{ padding: 16, color: colors.muted }}>
          No timeline activity yet. Recording continues until you press Clear.
        </div>
      </div>
    )
  }

  return (
    <>
      <TimelineOverview
        lanes={lanes}
        layout={renderedLayout}
        nowPoint={nowPoint}
        viewport={viewport}
        labelWidth={labelWidth}
        onNavigate={ratio => {
          const scroll = trackScrollRef.current
          if (!scroll) return
          const visibleTrackWidth = Math.max(1, scroll.clientWidth)
          scroll.scrollLeft = Math.max(
            0,
            Math.min(
              renderedLayout.trackWidth - visibleTrackWidth,
              ratio * renderedLayout.trackWidth - visibleTrackWidth / 2,
            ),
          )
          if (axisScrollRef.current) axisScrollRef.current.scrollLeft = scroll.scrollLeft
          onFollowChange(false)
          updateViewport()
        }}
      />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `${labelWidth}px minmax(0, 1fr)`,
          minHeight: 38,
          flexShrink: 0,
          background: colors.bg,
        }}
      >
        <div
          title={`Recording started ${formatTimelineClock(renderedLayout.start, wallClockOffset, true)}`}
          style={{
            position: 'relative',
            color: colors.muted,
            padding: '7px 10px 0',
            borderBottom: `1px solid ${colors.border}`,
            background: colors.bg,
          }}
        >
          <TimelineLegend />
          <span
            role='separator'
            aria-label='Resize timeline labels'
            aria-orientation='vertical'
            title='Resize timeline labels'
            onMouseDown={onLabelResizeStart}
            style={{
              position: 'absolute',
              top: 0,
              right: -4,
              bottom: 0,
              width: 8,
              zIndex: 3,
              cursor: 'col-resize',
              borderRight: `1px solid ${colors.border}`,
            }}
          />
        </div>
        <div
          ref={axisScrollRef}
          aria-hidden='true'
          style={{ overflow: 'hidden', borderBottom: `1px solid ${colors.border}` }}
        >
          <TimelineAxis
            layout={renderedLayout}
            viewport={viewport}
            wallClockOffset={wallClockOffset}
          />
        </div>
      </div>
      <div
        ref={verticalScrollRef}
        aria-label='Timeline lanes'
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}
        onScroll={event => {
          if (!follow) return
          const scroll = event.currentTarget
          const distance = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop
          if (distance > FOLLOW_THRESHOLD) onFollowChange(false)
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `${labelWidth}px minmax(0, 1fr)`,
            alignItems: 'start',
          }}
        >
          <div style={{ minWidth: 0, paddingBottom: 10 }}>
            {lanes.map(lane => (
              <TimelineLaneLabel
                key={lane.id}
                label={lane.label}
                context={lane.context}
                detail={lane.detail}
              />
            ))}
          </div>
          <div
            ref={trackScrollRef}
            aria-label='Timeline time range'
            style={{ minWidth: 0, overflowX: 'auto', overflowY: 'hidden' }}
            onScroll={event => {
              const scroll = event.currentTarget
              if (axisScrollRef.current) axisScrollRef.current.scrollLeft = scroll.scrollLeft
              updateViewport()
              if (!follow) return
              const distance = scroll.scrollWidth - scroll.clientWidth - scroll.scrollLeft
              if (distance > FOLLOW_THRESHOLD) onFollowChange(false)
            }}
          >
            <div style={{ width: renderedLayout.trackWidth, paddingBottom: 10 }}>
              {lanes.map(lane => (
                <TimelineLaneTrack
                  key={lane.id}
                  layout={renderedLayout}
                  bars={lane.kind === 'query' || lane.kind === 'connection' ? lane.bars : []}
                  ticks={lane.kind === 'realtime' ? lane.ticks : []}
                  markers={lane.kind === 'connection' ? lane.markers : []}
                  barLabel={lane.kind === 'connection' ? 'Offline' : 'Fetch'}
                  nowPoint={nowPoint}
                  wallClockOffset={wallClockOffset}
                  {...(onTraceSelect ? { onTraceSelect } : {})}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function TimelineAxis({
  layout,
  viewport,
  wallClockOffset,
}: {
  layout: RenderedTimelineLayout
  viewport: TimelineViewport
  wallClockOffset: number
}) {
  const { colors } = useDevtoolsTheme()
  return (
    <div
      style={{
        position: 'relative',
        width: layout.trackWidth,
        minHeight: 38,
        ...timelineGridStyle(colors),
      }}
    >
      {timelineAxisTicks(layout.start, layout.trackWidth, viewport).map(tick => (
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
  )
}

function TimelineLegend() {
  const { colors } = useDevtoolsTheme()
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9, color: colors.muted }}>
      <TimelineLegendItem color={colors.green} shape='bar' label='fetch' />
      <TimelineLegendItem color={colors.blue} shape='dot' label='realtime' />
      <TimelineLegendItem color={colors.red} shape='bar' label='failed / offline' />
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

function TimelineLaneLabel({
  label,
  context,
  detail,
}: {
  label: string
  context?: string
  detail: string
}) {
  const { colors, styles } = useDevtoolsTheme()
  return (
    <div
      data-timeline-lane={label}
      style={{
        ...styles.laneLabel,
        height: TIMELINE_LANE_HEIGHT,
        boxSizing: 'border-box',
        padding: '6px 10px 4px',
        borderBottom: `1px solid ${colors.rowBorder}`,
      }}
      title={detail ? `${label} ${detail}` : label}
    >
      <span
        style={{
          display: 'block',
          color: colors.text,
          fontWeight: 650,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {label}
      </span>
      {context ? (
        <span
          style={{
            display: 'block',
            color: colors.faint,
            marginTop: 3,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {context}
        </span>
      ) : null}
    </div>
  )
}

function TimelineLaneTrack({
  layout,
  bars,
  ticks,
  markers,
  barLabel,
  nowPoint,
  wallClockOffset,
  onTraceSelect,
}: {
  layout: TimelineLayout
  bars: QuerySpan[]
  ticks: TimelineTick[]
  markers: TimelineMarker[]
  barLabel: 'Fetch' | 'Offline'
  nowPoint: number
  wallClockOffset: number
  onTraceSelect?: (traceId: number) => void
}) {
  const { colors, styles } = useDevtoolsTheme()
  return (
    <div
      style={{
        ...styles.laneTrack,
        width: layout.trackWidth,
        height: TIMELINE_LANE_HEIGHT,
        boxSizing: 'border-box',
        borderBottom: `1px solid ${colors.rowBorder}`,
        ...timelineGridStyle(colors),
      }}
    >
      {bars.map((bar, index) => {
        const barEnd = bar.endAt ?? nowPoint
        const left = timeToPixels(bar.startAt, layout.start)
        const width = Math.max(9, timeToPixels(barEnd, bar.startAt))
        const color = bar.ok === false ? colors.red : colors.green
        return (
          <button
            type='button'
            key={`${bar.startAt}:${index}`}
            {...(barLabel === 'Fetch'
              ? { 'data-timeline-fetch': bar.ok === false ? 'failed' : 'success' }
              : { 'data-timeline-outage': 'offline' })}
            title={[
              `${barLabel === 'Offline' ? 'Offline' : bar.ok === false ? 'Failed fetch' : 'Fetch'} · ${formatMs(barEnd - bar.startAt)}`,
              formatTimelineClock(bar.startAt, wallClockOffset, true),
            ].join('\n')}
            style={{
              border: 0,
              padding: 0,
              cursor: bar.traceIds?.[0] === undefined ? 'default' : 'pointer',
              position: 'absolute',
              top: 19,
              left,
              width,
              height: 8,
              overflow: 'hidden',
              borderRadius: 999,
              background: `linear-gradient(180deg, color-mix(in srgb, ${color} 76%, white), ${color})`,
              boxShadow: `0 0 0 1px color-mix(in srgb, ${color} 62%, ${colors.bg})`,
            }}
            onClick={() => {
              const traceId = bar.traceIds?.[0]
              if (traceId !== undefined) onTraceSelect?.(traceId)
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
          </button>
        )
      })}
      {ticks.map((tick, index) => (
        <button
          type='button'
          key={`${tick.at}:${index}`}
          title={`Realtime event\n${formatTimelineClock(tick.at, wallClockOffset, true)}`}
          onClick={() => {
            if (tick.traceId !== undefined) onTraceSelect?.(tick.traceId)
          }}
          style={{
            position: 'absolute',
            top: 15,
            left: timeToPixels(tick.at, layout.start),
            width: 7,
            height: 7,
            border: 0,
            padding: 0,
            cursor: tick.traceId === undefined ? 'default' : 'pointer',
            marginLeft: -4,
            borderRadius: 2,
            background: colors.blue,
            boxShadow: `0 0 0 1px ${colors.bg}`,
            transform: 'rotate(45deg)',
          }}
        />
      ))}
      {markers.map((marker, index) => (
        <button
          type='button'
          key={`${marker.at}:${marker.label}:${index}`}
          title={`${marker.label}\n${formatTimelineClock(marker.at, wallClockOffset, true)}`}
          onClick={() => {
            if (marker.traceId !== undefined) onTraceSelect?.(marker.traceId)
          }}
          style={{
            position: 'absolute',
            top: 14,
            left: timeToPixels(marker.at, layout.start),
            width: 9,
            height: 9,
            marginLeft: -5,
            borderRadius: 999,
            background: toneColor(colors, marker.tone),
            border: `2px solid ${colors.bg}`,
            boxSizing: 'border-box',
            padding: 0,
            cursor: marker.traceId === undefined ? 'default' : 'pointer',
          }}
        />
      ))}
    </div>
  )
}

function timeToPixels(value: number, start: number): number {
  return Math.max(0, ((value - start) / 1_000) * TIMELINE_PIXELS_PER_SECOND)
}

function formatTimelineOffset(value: number): string {
  const seconds = Math.round(value / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`
}

function timelineAxisTicks(
  start: number,
  trackWidth: number,
  viewport: TimelineViewport,
): number[] {
  const tickWidth = TIMELINE_PIXELS_PER_SECOND * (GRID_TICK_MS / 1_000)
  const first = Math.max(0, Math.floor((viewport.left * trackWidth) / tickWidth) - 1)
  const last = Math.min(
    Math.floor(trackWidth / tickWidth),
    Math.ceil(((viewport.left + viewport.width) * trackWidth) / tickWidth) + 1,
  )
  return Array.from(
    { length: Math.max(0, last - first + 1) },
    (_, index) => start + (first + index) * GRID_TICK_MS,
  )
}

function timelineGridStyle(colors: DevtoolsColors) {
  const second = TIMELINE_PIXELS_PER_SECOND
  const major = second * (GRID_TICK_MS / 1_000)
  return {
    backgroundColor: colors.panel2,
    backgroundImage: [
      `repeating-linear-gradient(to right, ${colors.border} 0, ${colors.border} 1px, transparent 1px, transparent ${major}px)`,
      `repeating-linear-gradient(to right, ${colors.rowBorder} 0, ${colors.rowBorder} 1px, transparent 1px, transparent ${second}px)`,
    ].join(', '),
  }
}

function formatTimelineClock(
  value: number,
  wallClockOffset: number,
  milliseconds: boolean,
): string {
  return formatClock(wallClockOffset + value, { milliseconds })
}
