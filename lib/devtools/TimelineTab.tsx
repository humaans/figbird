import { useEffect, useMemo, useState } from 'react'
import type { DevtoolsSnapshot, QueryRecord, TimelineConnectionEvent } from './collector.js'
import { compactJson, formatMs, now } from './format.js'
import type { DevtoolsModel, EventQueryScope } from './model.js'
import {
  TimelineCanvas,
  TIMELINE_PIXELS_PER_SECOND as PIXELS_PER_SECOND,
  type TimelineLane,
  type TimelineLayout,
  type TimelineMarker,
} from './TimelineCanvas.js'
import { buttonStyle, useDevtoolsTheme } from './ui.js'

const END_GUTTER_MS = 1_000

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
      context: string
      detail: string
      firstAt: number
      ticks: number[]
    }
  | {
      kind: 'connection'
      id: string
      label: string
      context: string
      detail: string
      firstAt: number
      bars: QueryRecord['spans']
      markers: TimelineMarker[]
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
          context: [
            timelineScopeLabel(scopes),
            `${query.itemCount} ${query.itemCount === 1 ? 'row' : 'rows'}`,
            `${query.fetchCount} ${query.fetchCount === 1 ? 'fetch' : 'fetches'}`,
            query.lastDurationMs === undefined ? '' : `${formatMs(query.lastDurationMs)} last`,
          ]
            .filter(Boolean)
            .join(' · '),
          detail: timelineQueryDetail(query, scopes),
          firstAt: Math.min(...query.spans.map(span => span.startAt)),
          query,
        }
      })
    const realtimeLanes: RawTimelineLane[] = [...realtimeByService].map(([serviceName, ticks]) => ({
      kind: 'realtime',
      id: `realtime:${serviceName}`,
      label: `${serviceName} realtime`,
      context: `${ticks.length} ${ticks.length === 1 ? 'event' : 'events'} retained`,
      detail: `All retained realtime events emitted by ${serviceName}`,
      firstAt: Math.min(...ticks),
      ticks,
    }))
    const connectionLane = buildConnectionLane(snapshot.timeline.connection)
    return [...queryLanes, ...realtimeLanes, ...(connectionLane ? [connectionLane] : [])]
  }, [
    model.scopesByQueryId,
    snapshot.queries,
    snapshot.timeline.connection,
    snapshot.timeline.realtime,
  ])
  const hasInFlight = rawLanes.some(
    lane =>
      (lane.kind === 'query' && lane.query.spans.some(span => span.endAt === undefined)) ||
      (lane.kind === 'connection' && lane.bars.some(span => span.endAt === undefined)),
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
    } else if (lane.kind === 'realtime') {
      points.push(...lane.ticks)
    } else {
      for (const span of lane.bars) points.push(span.startAt, span.endAt ?? nowPoint)
      points.push(...lane.markers.map(marker => marker.at))
    }
  }
  if (points.length === 0) return null
  const earliest = Math.min(...points)
  const start = startedAt > 0 ? Math.min(startedAt, earliest) : earliest
  const latest = Math.max(...points)
  const duration = Math.max(END_GUTTER_MS, latest - start + END_GUTTER_MS)
  const trackWidth = Math.ceil((duration / 1_000) * PIXELS_PER_SECOND)
  return { start, trackWidth }
}

function buildConnectionLane(events: TimelineConnectionEvent[]): RawTimelineLane | null {
  if (events.length === 0) return null
  const bars: QueryRecord['spans'] = []
  const markers: TimelineMarker[] = []
  let offlineStart: number | undefined
  let latestAttempt: number | undefined
  let lastOutageDuration: number | undefined

  for (const item of events) {
    const event = item.event
    switch (event.kind) {
      case 'connection:connected':
        markers.push({ at: item.at, label: connectionEventLabel(event), tone: 'green' })
        break
      case 'connection:disconnected':
        if (offlineStart === undefined) offlineStart = item.at
        latestAttempt = undefined
        markers.push({ at: item.at, label: connectionEventLabel(event), tone: 'red' })
        break
      case 'connection:reconnected':
        latestAttempt = event.attempt
        if (offlineStart !== undefined) {
          lastOutageDuration = item.at - offlineStart
          bars.push({ startAt: offlineStart, endAt: item.at, ok: false })
          offlineStart = undefined
        }
        markers.push({ at: item.at, label: connectionEventLabel(event), tone: 'green' })
        break
      case 'connection:error':
      case 'connection:reconnect-failed':
        markers.push({ at: item.at, label: connectionEventLabel(event), tone: 'red' })
        break
    }
  }
  if (offlineStart !== undefined) bars.push({ startAt: offlineStart, ok: false })

  const latest = events.at(-1)!.event
  const isOffline = offlineStart !== undefined
  const transport =
    latest.kind === 'connection:connected' || latest.kind === 'connection:reconnected'
      ? latest.transport
      : undefined
  const context = [
    isOffline ? 'offline' : 'connected',
    transport ?? '',
    latestAttempt === undefined ? '' : `attempt ${latestAttempt}`,
    !isOffline && lastOutageDuration !== undefined ? `${formatMs(lastOutageDuration)} outage` : '',
  ]
    .filter(Boolean)
    .join(' · ')

  return {
    kind: 'connection',
    id: 'connection',
    label: 'Connection',
    context,
    detail: `${events.length} retained connection ${events.length === 1 ? 'event' : 'events'}`,
    firstAt: events[0]!.at,
    bars,
    markers,
  }
}

function connectionEventLabel(event: TimelineConnectionEvent['event']): string {
  switch (event.kind) {
    case 'connection:connected':
      return ['Connected', event.transport].filter(Boolean).join(' · ')
    case 'connection:disconnected':
      return ['Disconnected', event.reason].filter(Boolean).join(' · ')
    case 'connection:reconnected':
      return [
        event.attempt === undefined ? 'Reconnected' : `Reconnected on attempt ${event.attempt}`,
        event.transport,
      ]
        .filter(Boolean)
        .join(' · ')
    case 'connection:error':
      return `${event.phase === 'connect' ? 'Connection' : 'Reconnect'} error · ${event.error.message}`
    case 'connection:reconnect-failed':
      return event.error ? `Reconnection failed · ${event.error.message}` : 'Reconnection failed'
  }
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
