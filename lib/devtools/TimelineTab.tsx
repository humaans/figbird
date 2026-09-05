import { useMemo, useState } from 'react'
import type { DevtoolsSnapshot } from './collector.js'
import { now } from './format.js'
import { useClock } from './useClock.js'
import type { DevtoolsModel } from './model.js'
import { TimelineActivityTable, type TimelineVisibility } from './TimelineActivityTable.js'
import { buildTimelineActivities, timelineExtent } from './timelineModel.js'
import { buttonStyle, useDevtoolsTheme } from './ui.js'

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
      data-tooltip={
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
  filter,
  visibility,
  follow,
  onFollowChange,
  requestedActivityId,
  onRequestedActivityHandled,
  onQuerySelect,
  onCacheEntitySelect,
  onTraceSelect,
}: {
  snapshot: DevtoolsSnapshot
  model: DevtoolsModel
  filter: string
  visibility: TimelineVisibility
  follow: boolean
  onFollowChange: (value: boolean) => void
  requestedActivityId?: string | null
  onRequestedActivityHandled?: () => void
  onQuerySelect?: (queryId: string) => void
  onCacheEntitySelect?: (serviceName: string, itemId: string | number) => void
  onTraceSelect?: (traceId: number) => void
}) {
  const hasInFlight =
    snapshot.queries.some(query => query.spans.some(span => span.endAt === undefined)) ||
    snapshot.writes.some(write => write.status === 'in-flight')
  const { now: nowPoint } = useClock(hasInFlight)
  const [wallClockOffset] = useState(() => Date.now() - now())
  const activities = useMemo(
    () => buildTimelineActivities(snapshot, model, nowPoint),
    [model, nowPoint, snapshot],
  )
  const extent = timelineExtent(activities, snapshot.timeline.startedAt, nowPoint)

  return (
    <section style={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <TimelineActivityTable
        activities={activities}
        extent={extent}
        nowPoint={nowPoint}
        wallClockOffset={wallClockOffset}
        filter={filter}
        visibility={visibility}
        follow={follow}
        onFollowChange={onFollowChange}
        evictedCount={snapshot.timeline.evictedCount ?? 0}
        payloadsEvicted={snapshot.timeline.payloadsEvicted ?? 0}
        {...(requestedActivityId ? { requestedActivityId } : {})}
        {...(onRequestedActivityHandled ? { onRequestedActivityHandled } : {})}
        {...(onQuerySelect ? { onQuerySelect } : {})}
        {...(onCacheEntitySelect ? { onCacheEntitySelect } : {})}
        {...(onTraceSelect ? { onTraceSelect } : {})}
      />
    </section>
  )
}
