import { useEffect, useRef } from 'react'
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
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof CanvasRenderingContext2D === 'undefined') return
    const draw = () => drawOverview(canvas, lanes, layout, nowPoint, viewport, colors)
    draw()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [colors, lanes, layout, nowPoint, viewport])

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
        <canvas
          ref={canvasRef}
          aria-hidden='true'
          style={{
            display: 'block',
            width: '100%',
            height: OVERVIEW_HEIGHT,
            pointerEvents: 'none',
          }}
        />
      </button>
    </div>
  )
}

function drawOverview(
  canvas: HTMLCanvasElement,
  lanes: TimelineOverviewLane[],
  layout: TimelineOverviewLayout,
  nowPoint: number,
  viewport: TimelineViewport,
  colors: ReturnType<typeof useDevtoolsTheme>['colors'],
): void {
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (width <= 0 || height <= 0) return
  const ratio = window.devicePixelRatio || 1
  const pixelWidth = Math.max(1, Math.round(width * ratio))
  const pixelHeight = Math.max(1, Math.round(height * ratio))
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight
  const context = canvas.getContext('2d')
  if (!context) return
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, width, height)

  const laneHeight = (height - 10) / Math.max(1, lanes.length)
  for (const [laneIndex, lane] of lanes.entries()) {
    const markHeight = Math.min(3, Math.max(1, laneHeight * 0.5))
    const top = 5 + laneIndex * laneHeight + Math.max(0, (laneHeight - markHeight) / 2)
    if (lane.kind === 'query') {
      for (const bar of lane.bars) {
        const left = timelineRatio(bar.startAt, layout) * width
        const right = timelineRatio(bar.endAt ?? nowPoint, layout) * width
        context.fillStyle = bar.ok === false ? colors.red : colors.green
        context.fillRect(left, top, Math.max(1, right - left), markHeight)
      }
    } else {
      context.fillStyle = colors.blue
      for (const tick of lane.ticks) {
        context.fillRect(timelineRatio(tick, layout) * width, top, 2, markHeight)
      }
    }
  }

  const viewportLeft = viewport.left * width
  const viewportWidth = Math.max(4, viewport.width * width)
  context.fillStyle = colors.activeButtonBg
  context.fillRect(viewportLeft, 0, viewportWidth, height)
  context.strokeStyle = colors.blue
  context.lineWidth = 1
  context.strokeRect(viewportLeft + 0.5, 0.5, Math.max(0, viewportWidth - 1), height - 1)
}

function timelineRatio(value: number, layout: TimelineOverviewLayout): number {
  return Math.max(0, Math.min(1, (value - layout.start) / (layout.end - layout.start)))
}
