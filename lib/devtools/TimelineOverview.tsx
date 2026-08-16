import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { TimelineActivity, TimelineExtent } from './timelineModel.js'
import { useDevtoolsTheme } from './ui.js'

const OVERVIEW_HEIGHT = 54
const DRAG_THRESHOLD = 3
const OVERVIEW_PADDING = 4
const MARK_HEIGHT = 3
const LANE_GAP = 1
const MIN_MARK_WIDTH = 2

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
    <button
      type='button'
      aria-label='Timeline overview'
      data-tooltip='Drag to filter the activity table by time. Click to clear the range.'
      onMouseDown={onMouseDown}
      onKeyDown={event => {
        if (event.key === 'Escape') onRangeChange(null)
      }}
      style={{
        position: 'relative',
        display: 'block',
        width: '100%',
        height: OVERVIEW_HEIGHT,
        flexShrink: 0,
        overflow: 'hidden',
        border: 0,
        borderBottom: `1px solid ${colors.border}`,
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

  const laneCount = Math.max(
    1,
    Math.floor((height - OVERVIEW_PADDING * 2 + LANE_GAP) / (MARK_HEIGHT + LANE_GAP)),
  )
  const marks = packOverviewMarks(activities, extent, nowPoint, width, laneCount)
  for (const { activity, lane } of marks) {
    const top = OVERVIEW_PADDING + lane * (MARK_HEIGHT + LANE_GAP)
    const left = timelineRatio(activity.startAt, extent) * width
    const right = timelineRatio(activity.endAt ?? nowPoint, extent) * width
    context.fillStyle = toneColor(activity.tone, colors)
    if (
      activity.startAt === activity.endAt ||
      activity.kind === 'realtime' ||
      activity.kind === 'connection'
    ) {
      context.fillRect(left - MIN_MARK_WIDTH / 2, top, MIN_MARK_WIDTH, MARK_HEIGHT)
    } else {
      context.fillRect(left, top, Math.max(MIN_MARK_WIDTH, right - left), MARK_HEIGHT)
    }
  }

  if (range) {
    const left = timelineRatio(range.start, extent) * width
    const right = timelineRatio(range.end, extent) * width
    context.fillStyle = 'rgba(0,0,0,.2)'
    context.fillRect(0, 0, left, height)
    context.fillRect(right, 0, width - right, height)
    context.strokeStyle = colors.blue
    context.lineWidth = 1
    context.strokeRect(left + 0.5, 0.5, Math.max(1, right - left - 1), height - 1)
    context.fillStyle = colors.blue
    context.fillRect(left, 0, 2, height)
    context.fillRect(right - 2, 0, 2, height)
  }
}

function packOverviewMarks(
  activities: readonly TimelineActivity[],
  extent: TimelineExtent,
  nowPoint: number,
  width: number,
  laneCount: number,
): Array<{ activity: TimelineActivity; lane: number }> {
  const minimumDuration = ((extent.end - extent.start) * MIN_MARK_WIDTH) / Math.max(1, width)
  const laneEnds = Array.from({ length: laneCount }, () => Number.NEGATIVE_INFINITY)
  const sorted = [...activities].sort(
    (first, second) =>
      first.startAt - second.startAt ||
      activityEnd(first, nowPoint) - activityEnd(second, nowPoint),
  )

  return sorted.map(activity => {
    const start = activity.startAt
    const end = Math.max(activityEnd(activity, nowPoint), start + minimumDuration)
    let lane = laneEnds.findIndex(laneEnd => laneEnd <= start)

    if (lane === -1) {
      lane = 0
      for (let index = 1; index < laneEnds.length; index++) {
        if (laneEnds[index]! < laneEnds[lane]!) lane = index
      }
    }

    laneEnds[lane] = end
    return { activity, lane }
  })
}

function activityEnd(activity: TimelineActivity, nowPoint: number): number {
  return activity.endAt ?? nowPoint
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
