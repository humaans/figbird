import { useEffect, useMemo, useState } from 'react'
import type { DevtoolsSnapshot, QueryRecord } from './collector.js'
import { compactJson, now } from './format.js'
import type { DevtoolsModel, EventQueryScope } from './model.js'
import {
  TimelineCanvas,
  TIMELINE_PIXELS_PER_SECOND as PIXELS_PER_SECOND,
  type TimelineLane,
  type TimelineLayout,
} from './TimelineCanvas.js'
import { buttonStyle, useDevtoolsTheme } from './ui.js'

const MIN_TRACK_WIDTH = 680
const END_GUTTER_MS = 1_000
const GRID_TICK_MS = 5_000

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
          ? 'Following new timeline activity. Scroll away or click to pause.'
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
  const lanes: TimelineLane[] = rawLanes.map(lane =>
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
  return (
    <section style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <TimelineCanvas
        lanes={lanes}
        layout={layout}
        nowPoint={nowPoint}
        wallClockOffset={wallClockOffset}
        follow={follow}
        onFollowChange={onFollowChange}
      />
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
