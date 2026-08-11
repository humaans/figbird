import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { QuerySpan } from './collector.js'
import { formatClock, formatMs } from './format.js'
import {
  TimelineOverview,
  TIMELINE_LABEL_WIDTH as LABEL_WIDTH,
  type TimelineViewport,
} from './TimelineOverview.js'
import { useDevtoolsTheme, type DevtoolsColors } from './ui.js'

const FOLLOW_THRESHOLD = 24
const GRID_TICK_MS = 5_000
export const TIMELINE_PIXELS_PER_SECOND = 64

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
      firstAt: number
      ticks: number[]
    }

export interface TimelineLayout {
  start: number
  trackWidth: number
}

interface RenderedTimelineLayout extends TimelineLayout {
  end: number
  ticks: number[]
}

export function TimelineCanvas({
  lanes,
  layout,
  nowPoint,
  wallClockOffset,
  follow,
  onFollowChange,
}: {
  lanes: TimelineLane[]
  layout: TimelineLayout | null
  nowPoint: number
  wallClockOffset: number
  follow: boolean
  onFollowChange: (value: boolean) => void
}) {
  const { colors, styles } = useDevtoolsTheme()
  const verticalScrollRef = useRef<HTMLDivElement>(null)
  const trackScrollRef = useRef<HTMLDivElement>(null)
  const axisScrollRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<TimelineViewport>({ left: 0, width: 1 })
  const [availableTrackWidth, setAvailableTrackWidth] = useState(0)
  const hasLayout = layout !== null
  const trackWidth = layout ? Math.max(layout.trackWidth, availableTrackWidth) : undefined
  const renderedLayout: RenderedTimelineLayout | null =
    layout && trackWidth !== undefined
      ? {
          ...layout,
          end: layout.start + (trackWidth / TIMELINE_PIXELS_PER_SECOND) * 1_000,
          trackWidth,
          ticks: timelineAxisTicks(layout.start, trackWidth),
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
          gridTemplateColumns: `${LABEL_WIDTH}px minmax(0, 1fr)`,
          minHeight: 38,
          flexShrink: 0,
          background: colors.bg,
        }}
      >
        <div
          title={`Recording started ${formatTimelineClock(renderedLayout.start, wallClockOffset, true)}`}
          style={{
            color: colors.muted,
            padding: '7px 10px 0',
            borderBottom: `1px solid ${colors.border}`,
            background: colors.bg,
          }}
        >
          <TimelineLegend />
        </div>
        <div
          ref={axisScrollRef}
          aria-hidden='true'
          style={{ overflow: 'hidden', borderBottom: `1px solid ${colors.border}` }}
        >
          <TimelineAxis layout={renderedLayout} wallClockOffset={wallClockOffset} />
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
            gridTemplateColumns: `${LABEL_WIDTH}px minmax(0, 1fr)`,
            alignItems: 'start',
          }}
        >
          <div style={{ minWidth: 0, paddingBottom: 10 }}>
            {lanes.map(lane => (
              <TimelineLaneLabel
                key={lane.id}
                label={lane.label}
                {...(lane.kind === 'query' ? { context: lane.context } : {})}
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
                  bars={lane.kind === 'query' ? lane.bars : []}
                  ticks={lane.kind === 'realtime' ? lane.ticks : []}
                  nowPoint={nowPoint}
                  wallClockOffset={wallClockOffset}
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
  wallClockOffset,
}: {
  layout: RenderedTimelineLayout
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
  )
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
        height: 32,
        boxSizing: 'border-box',
        paddingLeft: 10,
        borderBottom: `1px solid ${colors.rowBorder}`,
      }}
      title={detail ? `${label} ${detail}` : label}
    >
      <span style={{ color: colors.text, fontWeight: 600 }}>{label}</span>
      {context ? (
        <span style={{ color: colors.faint, marginLeft: 6, whiteSpace: 'nowrap' }}>{context}</span>
      ) : null}
    </div>
  )
}

function TimelineLaneTrack({
  layout,
  bars,
  ticks,
  nowPoint,
  wallClockOffset,
}: {
  layout: TimelineLayout
  bars: Array<{ startAt: number; endAt?: number; ok?: boolean }>
  ticks: number[]
  nowPoint: number
  wallClockOffset: number
}) {
  const { colors, styles } = useDevtoolsTheme()
  return (
    <div
      style={{
        ...styles.laneTrack,
        width: layout.trackWidth,
        height: 32,
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

function timelineAxisTicks(start: number, trackWidth: number): number[] {
  const duration = (trackWidth / TIMELINE_PIXELS_PER_SECOND) * 1_000
  const count = Math.floor(duration / GRID_TICK_MS)
  return Array.from({ length: count + 1 }, (_, index) => start + GRID_TICK_MS * index)
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
