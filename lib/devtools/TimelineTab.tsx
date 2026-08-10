import { useEffect, useMemo, useState } from 'react'
import type { DevtoolsSnapshot, QueryRecord, QuerySpan } from './collector.js'
import { compactJson, formatClock, formatMs, now } from './format.js'
import type { DevtoolsModel, EventQueryScope } from './model.js'
import { useDevtoolsTheme } from './ui.js'

export type TimelineRange = 30_000 | 120_000 | 'all'

type RawTimelineLane =
  | {
      kind: 'query'
      id: string
      label: string
      context: string
      detail: string
      query: QueryRecord
    }
  | {
      kind: 'realtime'
      id: string
      label: string
      detail: string
      ticks: number[]
    }

type VisibleTimelineLane =
  | {
      kind: 'query'
      id: string
      label: string
      context: string
      detail: string
      serviceName: string
      bars: QuerySpan[]
    }
  | {
      kind: 'realtime'
      id: string
      label: string
      detail: string
      ticks: number[]
    }

export function TimelineRangeControl({
  value,
  onChange,
}: {
  value: TimelineRange
  onChange: (value: TimelineRange) => void
}) {
  const { colors } = useDevtoolsTheme()
  const options: Array<{ label: string; value: TimelineRange }> = [
    { label: '30s', value: 30_000 },
    { label: '2m', value: 120_000 },
    { label: 'All', value: 'all' },
  ]
  return (
    <span
      aria-label='Timeline range'
      style={{
        display: 'inline-flex',
        border: `1px solid ${colors.border}`,
        borderRadius: 4,
        overflow: 'hidden',
      }}
    >
      {options.map(option => {
        const active = option.value === value
        return (
          <button
            key={option.label}
            type='button'
            onClick={() => onChange(option.value)}
            style={{
              border: 0,
              borderLeft: option === options[0] ? 0 : `1px solid ${colors.border}`,
              background: active ? colors.activeButtonBg : colors.panel,
              color: active ? colors.blue : colors.muted,
              padding: '4px 7px',
              font: 'inherit',
              fontWeight: active ? 700 : 500,
              cursor: 'pointer',
            }}
          >
            {option.label}
          </button>
        )
      })}
    </span>
  )
}

export function TimelineTab({
  snapshot,
  model,
  range,
}: {
  snapshot: DevtoolsSnapshot
  model: DevtoolsModel
  range: TimelineRange
}) {
  const { colors, styles } = useDevtoolsTheme()
  const nowPoint = useTimelineNow(range !== 'all')
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
          query,
        }
      })
    const realtimeLanes: RawTimelineLane[] = [...realtimeByService].map(([serviceName, ticks]) => ({
      kind: 'realtime',
      id: `realtime:${serviceName}`,
      label: `${serviceName} realtime`,
      detail: `All retained realtime events emitted by ${serviceName}`,
      ticks,
    }))
    return [...queryLanes, ...realtimeLanes]
  }, [model.scopesByQueryId, snapshot.queries, snapshot.timeline.realtime])
  const bounds = timelineBounds(rawLanes, range, nowPoint)
  const lanes: VisibleTimelineLane[] = bounds
    ? rawLanes
        .map(lane => ({
          ...(lane.kind === 'query'
            ? {
                kind: lane.kind,
                id: lane.id,
                label: lane.label,
                context: lane.context,
                detail: lane.detail,
                serviceName: lane.query.serviceName,
                bars: lane.query.spans.filter(
                  span => (span.endAt ?? nowPoint) >= bounds.start && span.startAt <= bounds.end,
                ),
              }
            : {
                kind: lane.kind,
                id: lane.id,
                label: lane.label,
                detail: lane.detail,
                ticks: lane.ticks.filter(tick => tick >= bounds.start && tick <= bounds.end),
              }),
        }))
        .filter(lane => (lane.kind === 'query' ? lane.bars.length > 0 : lane.ticks.length > 0))
    : []
  lanes.sort((a, b) => {
    const latest = timelineLaneLatest(b) - timelineLaneLatest(a)
    if (latest !== 0) return latest
    return a.id.localeCompare(b.id)
  })
  const axisTicks = bounds ? timelineAxisTicks(bounds.start, bounds.end) : []
  return (
    <section style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={styles.scroll}>
        {bounds ? (
          <div style={styles.timeline}>
            <TimelineAxis
              start={bounds.start}
              end={bounds.end}
              ticks={axisTicks}
              nowPoint={nowPoint}
              range={range}
            />
            {lanes.map(lane =>
              lane.kind === 'query' ? (
                <TimelineLane
                  key={lane.id}
                  label={lane.label}
                  context={lane.context}
                  detail={lane.detail}
                  start={bounds.start}
                  end={bounds.end}
                  bars={lane.bars}
                  gridTicks={axisTicks}
                  nowPoint={nowPoint}
                />
              ) : (
                <TimelineLane
                  key={lane.id}
                  label={lane.label}
                  detail={lane.detail}
                  start={bounds.start}
                  end={bounds.end}
                  bars={[]}
                  ticks={lane.ticks}
                  gridTicks={axisTicks}
                  nowPoint={nowPoint}
                />
              ),
            )}
            {lanes.length === 0 ? (
              <div style={{ padding: '18px 0 18px 220px', color: colors.muted }}>
                No activity in this time range. Choose All to inspect retained history.
              </div>
            ) : null}
          </div>
        ) : (
          <div style={{ padding: 16, color: colors.muted }}>No query timeline yet.</div>
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
  start,
  end,
  ticks,
  nowPoint,
  range,
}: {
  start: number
  end: number
  ticks: number[]
  nowPoint: number
  range: TimelineRange
}) {
  const { colors } = useDevtoolsTheme()
  const duration = Math.max(1, end - start)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', minHeight: 38 }}>
      <div
        style={{
          color: colors.muted,
          padding: '7px 12px 0 0',
          borderBottom: `1px solid ${colors.border}`,
        }}
      >
        <TimelineLegend />
      </div>
      <div style={{ position: 'relative', borderBottom: `1px solid ${colors.border}` }}>
        {ticks.map((tick, index) => {
          const isLast = index === ticks.length - 1
          return (
            <span
              key={tick}
              style={{
                position: 'absolute',
                left: `${((tick - start) / duration) * 100}%`,
                top: 0,
                bottom: 0,
                borderLeft: `1px solid ${colors.rowBorder}`,
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  top: 9,
                  left: isLast ? undefined : 6,
                  right: isLast ? 0 : undefined,
                  color: colors.muted,
                  whiteSpace: 'nowrap',
                }}
                title={formatTimelineClock(tick, nowPoint, true)}
              >
                {isLast && range !== 'all' ? 'now' : formatTimelineClock(tick, nowPoint, false)}
              </span>
            </span>
          )
        })}
      </div>
    </div>
  )
}

function timelineBounds(
  lanes: RawTimelineLane[],
  range: TimelineRange,
  nowPoint: number,
): { start: number; end: number } | null {
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
  if (range !== 'all') {
    return { start: Math.max(0, nowPoint - range), end: nowPoint }
  }
  const min = Math.min(...points)
  const max = Math.max(...points)
  const pad = Math.max(100, (max - min) * 0.025)
  return { start: Math.max(0, min - pad), end: max + pad }
}

function timelineLaneLatest(lane: VisibleTimelineLane): number {
  return lane.kind === 'query'
    ? Math.max(...lane.bars.map(span => span.endAt ?? span.startAt))
    : Math.max(...lane.ticks)
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
  const ticks = 5
  const duration = Math.max(1, end - start)
  return Array.from({ length: ticks }, (_, index) => start + (duration * index) / (ticks - 1))
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
          height: shape === 'dot' ? 6 : 9,
          borderRadius: shape === 'dot' ? 999 : 2,
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
  start,
  end,
  bars,
  ticks = [],
  gridTicks,
  nowPoint,
}: {
  label: string
  context?: string
  detail: string
  start: number
  end: number
  bars: Array<{ startAt: number; endAt?: number; ok?: boolean }>
  ticks?: number[]
  gridTicks: number[]
  nowPoint: number
}) {
  const { colors, styles } = useDevtoolsTheme()
  const duration = Math.max(1, end - start)
  return (
    <div style={styles.lane}>
      <div style={styles.laneLabel} title={detail ? `${label} ${detail}` : label}>
        <span style={{ color: colors.text, fontWeight: 600 }}>{label}</span>
        {context ? (
          <span style={{ color: colors.faint, marginLeft: 6, whiteSpace: 'nowrap' }}>
            {context}
          </span>
        ) : null}
      </div>
      <div style={styles.laneTrack}>
        {gridTicks.map(tick => (
          <span
            key={tick}
            aria-hidden='true'
            style={{
              position: 'absolute',
              insetBlock: 0,
              left: `${((tick - start) / duration) * 100}%`,
              borderLeft: `1px solid ${colors.rowBorder}`,
            }}
          />
        ))}
        {bars.map((bar, index) => {
          const barEnd = bar.endAt ?? end
          const left = `${Math.max(0, ((bar.startAt - start) / duration) * 100)}%`
          const width = `${Math.max(0.35, ((barEnd - bar.startAt) / duration) * 100)}%`
          return (
            <span
              key={`${bar.startAt}:${index}`}
              title={[
                `${bar.ok === false ? 'Failed fetch' : 'Fetch'} · ${formatMs(barEnd - bar.startAt)}`,
                formatTimelineClock(bar.startAt, nowPoint, true),
              ].join('\n')}
              style={{
                position: 'absolute',
                top: 16,
                left,
                width,
                minWidth: 18,
                height: 10,
                borderRadius: 1,
                background: bar.ok === false ? colors.red : colors.green,
                transition: 'left 1100ms linear, width 1100ms linear',
              }}
            />
          )
        })}
        {ticks.map((tick, index) => (
          <span
            key={`${tick}:${index}`}
            title={`Realtime event\n${formatTimelineClock(tick, nowPoint, true)}`}
            style={{
              position: 'absolute',
              top: 7,
              left: `${Math.max(0, Math.min(100, ((tick - start) / duration) * 100))}%`,
              width: 7,
              height: 7,
              marginLeft: -3,
              borderRadius: 999,
              background: colors.blue,
              boxShadow: `0 0 0 2px ${colors.bg}`,
              transition: 'left 1100ms linear',
            }}
          />
        ))}
      </div>
    </div>
  )
}

function formatTimelineClock(value: number, nowPoint: number, milliseconds: boolean): string {
  // Timeline positions use the monotonic clock; convert to wall time for display.
  const wallAt = Date.now() - Math.max(0, nowPoint - value)
  return formatClock(wallAt, { milliseconds })
}
