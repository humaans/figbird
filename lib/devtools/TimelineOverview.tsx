import type { QuerySpan } from './collector.js'
import { useDevtoolsTheme } from './ui.js'

export const TIMELINE_LABEL_WIDTH = 220

const OVERVIEW_HEIGHT = 42

export interface TimelineViewport {
  left: number
  width: number
}

type TimelineOverviewLane =
  | { kind: 'query'; id: string; bars: QuerySpan[] }
  | { kind: 'realtime'; id: string; ticks: number[] }

interface TimelineOverviewLayout {
  start: number
  end: number
}

export function TimelineOverview({
  lanes,
  layout,
  nowPoint,
  viewport,
  onNavigate,
}: {
  lanes: TimelineOverviewLane[]
  layout: TimelineOverviewLayout
  nowPoint: number
  viewport: TimelineViewport
  onNavigate: (ratio: number) => void
}) {
  const { colors } = useDevtoolsTheme()
  const laneHeight = (OVERVIEW_HEIGHT - 10) / Math.max(1, lanes.length)
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `${TIMELINE_LABEL_WIDTH}px minmax(0, 1fr)`,
        minHeight: OVERVIEW_HEIGHT,
        flexShrink: 0,
        borderBottom: `1px solid ${colors.border}`,
        background: colors.panel2,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: '0 10px',
          color: colors.muted,
          fontWeight: 600,
        }}
      >
        Activity
        <span style={{ color: colors.faint, fontWeight: 500 }}>{lanes.length} lanes</span>
      </div>
      <button
        type='button'
        aria-label='Timeline overview'
        title='Click to inspect another point in the recording'
        onClick={event => {
          const bounds = event.currentTarget.getBoundingClientRect()
          if (bounds.width <= 0) return
          onNavigate(Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)))
        }}
        style={{
          position: 'relative',
          overflow: 'hidden',
          border: 0,
          borderLeft: `1px solid ${colors.border}`,
          padding: 0,
          background: colors.panel,
          cursor: 'crosshair',
        }}
      >
        {lanes.flatMap((lane, laneIndex) => {
          const top = 5 + laneIndex * laneHeight + Math.max(0, (laneHeight - 3) / 2)
          return lane.kind === 'query'
            ? lane.bars.map((bar, index) => {
                const endAt = bar.endAt ?? nowPoint
                return (
                  <span
                    key={`${lane.id}:${bar.startAt}:${index}`}
                    aria-hidden='true'
                    style={{
                      position: 'absolute',
                      top,
                      left: `${timelinePercent(bar.startAt, layout)}%`,
                      width: `${Math.max(
                        0.45,
                        timelinePercent(endAt, layout) - timelinePercent(bar.startAt, layout),
                      )}%`,
                      height: Math.min(3, Math.max(1, laneHeight * 0.5)),
                      borderRadius: 999,
                      background: bar.ok === false ? colors.red : colors.green,
                    }}
                  />
                )
              })
            : lane.ticks.map((tick, index) => (
                <span
                  key={`${lane.id}:${tick}:${index}`}
                  aria-hidden='true'
                  style={{
                    position: 'absolute',
                    top,
                    left: `${timelinePercent(tick, layout)}%`,
                    width: 2,
                    height: Math.min(4, Math.max(2, laneHeight * 0.7)),
                    borderRadius: 999,
                    background: colors.blue,
                  }}
                />
              ))
        })}
        <span
          aria-hidden='true'
          style={{
            position: 'absolute',
            insetBlock: 0,
            left: `${viewport.left * 100}%`,
            width: `${viewport.width * 100}%`,
            minWidth: 4,
            borderInline: `1px solid ${colors.blue}`,
            background: colors.activeButtonBg,
            boxShadow: `inset 0 1px ${colors.blue}, inset 0 -1px ${colors.blue}`,
            pointerEvents: 'none',
          }}
        />
      </button>
    </div>
  )
}

function timelinePercent(value: number, layout: TimelineOverviewLayout): number {
  return Math.max(0, Math.min(100, ((value - layout.start) / (layout.end - layout.start)) * 100))
}
