import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { TimelineActivity, TimelineActivityKind, TimelineExtent } from './timelineModel.js'
import { useDevtoolsTheme } from './ui.js'

const OVERVIEW_HEIGHT = 54
const LABEL_WIDTH = 180
const DRAG_THRESHOLD = 3

export interface TimelineRange {
  start: number
  end: number
}

export function TimelineOverview({
  activities,
  extent,
  range,
  nowPoint,
  onRangeChange,
}: {
  activities: readonly TimelineActivity[]
  extent: TimelineExtent
  range: TimelineRange | null
  nowPoint: number
  onRangeChange: (range: TimelineRange | null) => void
}) {
  const { colors } = useDevtoolsTheme()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [draft, setDraft] = useState<TimelineRange | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof CanvasRenderingContext2D === 'undefined') return
    const draw = () => drawOverview(canvas, activities, extent, draft ?? range, nowPoint, colors)
    draw()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [activities, colors, draft, extent, nowPoint, range])

  const onMouseDown = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    const button = event.currentTarget
    const ownerWindow = button.ownerDocument.defaultView ?? window
    const bounds = button.getBoundingClientRect()
    if (bounds.width <= 0) return
    const startX = event.clientX
    const anchor = timeAt(event.clientX, bounds, extent)
    const onMove = (move: MouseEvent) => {
      const point = timeAt(move.clientX, bounds, extent)
      setDraft(normalizeRange(anchor, point))
    }
    const onUp = (up: MouseEvent) => {
      ownerWindow.removeEventListener('mousemove', onMove)
      ownerWindow.removeEventListener('mouseup', onUp)
      const point = timeAt(up.clientX, bounds, extent)
      const next =
        Math.abs(up.clientX - startX) < DRAG_THRESHOLD ? null : normalizeRange(anchor, point)
      setDraft(null)
      onRangeChange(next)
    }
    ownerWindow.addEventListener('mousemove', onMove)
    ownerWindow.addEventListener('mouseup', onUp)
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `${LABEL_WIDTH}px minmax(0, 1fr)`,
        minHeight: OVERVIEW_HEIGHT,
        flexShrink: 0,
        borderBottom: `1px solid ${colors.border}`,
        background: colors.panel2,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '0 10px',
          minWidth: 0,
        }}
      >
        <strong style={{ color: colors.text, fontWeight: 650 }}>Recording overview</strong>
        <span style={{ color: colors.faint, marginTop: 2 }}>
          {activities.length} {activities.length === 1 ? 'activity' : 'activities'}
        </span>
      </div>
      <button
        type='button'
        aria-label='Timeline overview'
        title='Drag to filter the activity table by time. Click to clear the range.'
        onMouseDown={onMouseDown}
        onKeyDown={event => {
          if (event.key === 'Escape') onRangeChange(null)
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
  activities: readonly TimelineActivity[],
  extent: TimelineExtent,
  range: TimelineRange | null,
  nowPoint: number,
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

  context.strokeStyle = colors.rowBorder
  context.lineWidth = 1
  for (let index = 1; index < 8; index++) {
    const x = Math.round((index / 8) * width) + 0.5
    context.beginPath()
    context.moveTo(x, 0)
    context.lineTo(x, height)
    context.stroke()
  }

  const bands: TimelineActivityKind[] = ['fetch', 'realtime', 'write', 'connection']
  const bandHeight = height / bands.length
  for (const activity of activities) {
    const band = bands.indexOf(activity.kind)
    const top = band * bandHeight + 4
    const markHeight = Math.max(2, bandHeight - 7)
    const left = timelineRatio(activity.startAt, extent) * width
    const right = timelineRatio(activity.endAt ?? nowPoint, extent) * width
    context.fillStyle = toneColor(activity.tone, colors)
    if (
      activity.startAt === activity.endAt ||
      activity.kind === 'realtime' ||
      activity.kind === 'connection'
    ) {
      context.fillRect(left - 1, top, 2, markHeight)
    } else {
      context.fillRect(left, top, Math.max(2, right - left), markHeight)
    }
  }

  if (range) {
    const left = timelineRatio(range.start, extent) * width
    const right = timelineRatio(range.end, extent) * width
    context.fillStyle = 'rgba(0,0,0,.2)'
    context.fillRect(0, 0, left, height)
    context.fillRect(right, 0, width - right, height)
    context.fillStyle = colors.activeButtonBg
    context.fillRect(left, 0, Math.max(2, right - left), height)
    context.strokeStyle = colors.blue
    context.lineWidth = 1
    context.strokeRect(left + 0.5, 0.5, Math.max(1, right - left - 1), height - 1)
    context.fillStyle = colors.blue
    context.fillRect(left, 0, 2, height)
    context.fillRect(right - 2, 0, 2, height)
  }
}

function toneColor(
  tone: TimelineActivity['tone'],
  colors: ReturnType<typeof useDevtoolsTheme>['colors'],
): string {
  switch (tone) {
    case 'green':
      return colors.green
    case 'amber':
      return colors.amber
    case 'red':
      return colors.red
    case 'blue':
      return colors.blue
    case 'neutral':
      return colors.faint
  }
}

function normalizeRange(first: number, second: number): TimelineRange {
  return first <= second ? { start: first, end: second } : { start: second, end: first }
}

function timeAt(clientX: number, bounds: DOMRect, extent: TimelineExtent): number {
  const ratio = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width))
  return extent.start + ratio * (extent.end - extent.start)
}

function timelineRatio(value: number, extent: TimelineExtent): number {
  return Math.max(0, Math.min(1, (value - extent.start) / (extent.end - extent.start)))
}
