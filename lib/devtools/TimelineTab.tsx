import { useEffect, useMemo, useState } from 'react'
import type { DevtoolsSnapshot, QueryRecord } from './collector.js'
import { compactJson, formatClock, formatMs, now } from './format.js'
import type { DevtoolsModel, QuerySummary } from './model.js'
import { useDevtoolsTheme } from './ui.js'

export type TimelineRange = 30_000 | 120_000 | 'all'

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
    return model.operations
      .map(operation => ({
        operation,
        query: operation.summary,
        ticks: realtimeByService.get(operation.summary.serviceName) ?? [],
      }))
      .filter(item => item.query.spans.length > 0 || item.ticks.length > 0)
  }, [model.operations, snapshot.timeline.realtime])
  const bounds = timelineBounds(rawLanes, range, nowPoint)
  const lanes = bounds
    ? rawLanes
        .map(lane => ({
          operation: lane.operation,
          query: lane.query,
          bars: lane.query.spans.filter(
            span => (span.endAt ?? nowPoint) >= bounds.start && span.startAt <= bounds.end,
          ),
          ticks: lane.ticks.filter(tick => tick >= bounds.start && tick <= bounds.end),
        }))
        .filter(lane => lane.bars.length > 0 || lane.ticks.length > 0)
    : []
  lanes.sort((a, b) => {
    const latest = timelineLaneLatest(b) - timelineLaneLatest(a)
    if (latest !== 0) return latest
    return `${a.query.serviceName}:${a.operation.key}`.localeCompare(
      `${b.query.serviceName}:${b.operation.key}`,
    )
  })
  const visibleQueries = lanes.map(item => item.query)
  const axisTicks = bounds ? timelineAxisTicks(bounds.start, bounds.end) : []
  const nPlusOne = detectNPlusOne(visibleQueries)

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
            {lanes.map(({ operation, query, bars, ticks }) => (
              <TimelineLane
                key={operation.key}
                label={`${query.serviceName}.${query.method}`}
                detail={timelineQueryDetail(query)}
                start={bounds.start}
                end={bounds.end}
                bars={bars}
                ticks={ticks}
                gridTicks={axisTicks}
                nowPoint={nowPoint}
              />
            ))}
            {lanes.length === 0 ? (
              <div style={{ padding: '18px 0 18px 220px', color: colors.muted }}>
                No activity in this time range. Choose All to inspect retained history.
              </div>
            ) : null}
            {nPlusOne.length > 0 ? (
              <div style={{ color: colors.amber, padding: '10px 0 0 220px' }}>
                {nPlusOne.map(item => (
                  <div key={item}>{item}</div>
                ))}
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
  lanes: Array<{ query: QuerySummary; ticks: number[] }>,
  range: TimelineRange,
  nowPoint: number,
): { start: number; end: number } | null {
  const points: number[] = []
  for (const lane of lanes) {
    for (const span of lane.query.spans) {
      points.push(span.startAt, span.endAt ?? now())
    }
    points.push(...lane.ticks)
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

function timelineLaneLatest({
  bars,
  ticks,
}: {
  bars: QueryRecord['spans']
  ticks: number[]
}): number {
  const points = bars.map(span => span.endAt ?? span.startAt)
  points.push(...ticks)
  return Math.max(...points)
}

function timelineQueryDetail(query: QuerySummary): string {
  if (query.method === 'get') {
    return query.resourceId === undefined ? '' : `#${query.resourceId}`
  }
  return query.query === undefined || Object.keys(query.query).length === 0
    ? ''
    : compactJson(query.query)
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
  detail,
  start,
  end,
  bars,
  ticks = [],
  gridTicks,
  nowPoint,
}: {
  label: string
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

function detectNPlusOne(queries: QuerySummary[]): string[] {
  const byService = new Map<string, number[]>()
  for (const query of queries) {
    const starts = byService.get(query.serviceName) ?? []
    for (const span of query.spans) starts.push(span.startAt)
    byService.set(query.serviceName, starts)
  }
  const warnings: string[] = []
  for (const [service, starts] of byService) {
    const sorted = starts.sort((a, b) => a - b)
    for (let index = 0; index < sorted.length; index++) {
      const cluster = sorted.filter(
        value => value >= sorted[index]! && value - sorted[index]! <= 100,
      )
      if (cluster.length >= 5) {
        warnings.push(`${service}: ${cluster.length} near-simultaneous fetches - consider embed`)
        break
      }
    }
  }
  return warnings
}
