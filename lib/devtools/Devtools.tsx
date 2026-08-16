import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { CacheTab, type DevtoolsCacheEditor } from './CacheTab.js'
import { EventsTab } from './EventsTab.js'
import { QueriesTab, operationIsInactive } from './QueriesTab.js'
import { TimelineFollowControl, TimelineTab } from './TimelineTab.js'
import type { TimelineVisibility } from './TimelineActivityTable.js'
import type { Collector } from './collector.js'
import { buildDevtoolsModel } from './model.js'
import {
  ThemeContext,
  buttonStyle,
  darkColors,
  lightColors,
  makeStyles,
  useDevtoolsTheme,
  usePreferredColorScheme,
  type DevtoolsThemeMode,
} from './ui.js'

type Tab = 'queries' | 'timeline' | 'events' | 'cache'
export type QueryVisibility = 'active' | 'inactive' | 'all' | 'skipped'
export type EventVisibility = 'activity' | 'all'

export type DevtoolsInspectionSnapshot =
  | { kind: 'idle'; version: number }
  | { kind: 'picking'; version: number }
  | {
      kind: 'selected'
      label: string
      queryCounts: ReadonlyMap<string, number>
      supported: boolean
      truncated: boolean
      version: number
    }

export interface DevtoolsInspectionController {
  getSnapshot(): DevtoolsInspectionSnapshot
  start(): void
  stop(): void
  subscribe(listener: () => void): () => void
}

export interface FigbirdDevtoolsPanelProps {
  collector: Collector
  inspection?: DevtoolsInspectionController
  cacheEditor?: DevtoolsCacheEditor
  status?: string
  theme?: DevtoolsThemeMode
}

const EMPTY_INSPECTION: DevtoolsInspectionSnapshot = { kind: 'idle', version: 0 }
const subscribeToNothing = () => () => {}
const getEmptyInspection = () => EMPTY_INSPECTION

/** The browser-extension panel. Apps do not render this component. */
export function FigbirdDevtoolsPanel({
  collector,
  inspection,
  cacheEditor,
  status,
  theme = 'system',
}: FigbirdDevtoolsPanelProps) {
  const colorScheme = usePreferredColorScheme(theme)
  const colors = colorScheme === 'dark' ? darkColors : lightColors
  const styles = useMemo(() => makeStyles(colors), [colors])
  const themeValue = useMemo(() => ({ colors, styles }), [colors, styles])
  const [tab, setTab] = useState<Tab>('queries')
  const [queryFilter, setQueryFilter] = useState('')
  const [queryVisibility, setQueryVisibility] = useState<QueryVisibility>('active')
  const [eventFilter, setEventFilter] = useState('')
  const [eventVisibility, setEventVisibility] = useState<EventVisibility>('activity')
  const [timelineFilter, setTimelineFilter] = useState('')
  const [timelineVisibility, setTimelineVisibility] = useState<TimelineVisibility>('all')
  const [cacheFilter, setCacheFilter] = useState('')
  const [selectedQueryId, setSelectedQueryId] = useState<string | null>(null)
  const [selectedTraceId, setSelectedTraceId] = useState<number | null>(null)
  const [timelineFollow, setTimelineFollow] = useState(true)

  useEffect(() => {
    collector.start()
    return () => collector.stop()
  }, [collector])

  const subscribe = useCallback((fn: () => void) => collector.subscribe(fn), [collector])
  const getSnapshot = useCallback(() => collector.getSnapshot(), [collector])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const inspectionSnapshot = useSyncExternalStore(
    inspection ? listener => inspection.subscribe(listener) : subscribeToNothing,
    inspection ? () => inspection.getSnapshot() : getEmptyInspection,
    getEmptyInspection,
  )

  const model = useMemo(() => buildDevtoolsModel(snapshot), [snapshot])
  const skippedQueryCount = model.operations.filter(operation => operation.summary.skipped).length
  const inactiveQueryCount = model.operations.filter(operationIsInactive).length
  const timelineEmpty =
    snapshot.timeline.realtime.length === 0 &&
    snapshot.timeline.connection.length === 0 &&
    snapshot.queries.every(query => query.spans.length === 0) &&
    snapshot.writes.every(write => write.startedAt < snapshot.timeline.startedAt)
  const clearTimeline = useCallback(() => {
    collector.clearTimeline()
    setTimelineFollow(true)
  }, [collector])
  const clearAction =
    tab === 'events'
      ? { disabled: snapshot.events.length === 0, run: () => collector.clearEvents() }
      : tab === 'timeline'
        ? { disabled: timelineEmpty, run: clearTimeline }
        : null
  const inspected = inspectionSnapshot.kind === 'selected' ? inspectionSnapshot : null

  return (
    <ThemeContext.Provider value={themeValue}>
      <section
        data-figbird-devtools='panel'
        aria-label='Figbird devtools'
        style={{
          ...styles.drawer,
          position: 'relative',
          width: '100%',
          height: '100vh',
          borderTop: 0,
          boxShadow: 'none',
        }}
      >
        <header style={styles.header}>
          <span style={styles.brand}>figbird</span>
          {(['queries', 'timeline', 'events', 'cache'] as const).map(item => (
            <TabButton key={item} active={tab === item} onClick={() => setTab(item)} label={item} />
          ))}
          {tab === 'queries' ? (
            <>
              <input
                style={styles.input}
                value={queryFilter}
                onChange={event => setQueryFilter(event.currentTarget.value)}
                placeholder='Filter service or query'
              />
              <select
                aria-label='Query visibility'
                title='Choose live, inactive cached, skipped, or historical queries'
                value={queryVisibility}
                onChange={event => setQueryVisibility(event.currentTarget.value as QueryVisibility)}
                style={styles.select}
              >
                <option value='active'>Live queries</option>
                <option value='inactive'>
                  Inactive queries{inactiveQueryCount > 0 ? ` (${inactiveQueryCount})` : ''}
                </option>
                <option value='all'>All queries</option>
                <option value='skipped'>
                  Skipped queries{skippedQueryCount > 0 ? ` (${skippedQueryCount})` : ''}
                </option>
              </select>
              {inspection ? (
                <button
                  type='button'
                  style={buttonStyle(colors, inspectionSnapshot.kind === 'picking')}
                  onClick={
                    inspectionSnapshot.kind === 'picking' ? inspection.stop : inspection.start
                  }
                  title='Pick an area of the inspected page and show its mounted queries'
                >
                  {inspectionSnapshot.kind === 'picking' ? 'Cancel' : 'Inspect'}
                </button>
              ) : null}
              {inspected ? (
                <button
                  type='button'
                  onClick={inspection!.stop}
                  title={inspectionTitle(inspected)}
                  style={{
                    ...buttonStyle(colors, true),
                    color: !inspected.supported
                      ? colors.red
                      : inspected.truncated
                        ? colors.amber
                        : colors.blue,
                    maxWidth: 145,
                    display: 'flex',
                    minWidth: 0,
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {inspected.label}
                  </span>
                  <span style={{ flexShrink: 0 }}>
                    ·{' '}
                    {inspected.supported
                      ? `${inspected.queryCounts.size}${inspected.truncated ? '+' : ''}`
                      : 'unavailable'}
                  </span>
                </button>
              ) : null}
            </>
          ) : null}
          {tab === 'timeline' ? (
            <>
              <input
                aria-label='Filter timeline activity'
                style={styles.input}
                value={timelineFilter}
                onChange={event => setTimelineFilter(event.currentTarget.value)}
                placeholder='Filter activity'
              />
              <select
                aria-label='Timeline visibility'
                title='Choose which activity types appear in the timeline and overview'
                value={timelineVisibility}
                onChange={event =>
                  setTimelineVisibility(event.currentTarget.value as TimelineVisibility)
                }
                style={styles.select}
              >
                <option value='all'>All activity</option>
                <option value='fetch'>Fetches</option>
                <option value='realtime'>Realtime</option>
                <option value='write'>Writes</option>
                <option value='connection'>Connection</option>
                <option value='errors'>Errors</option>
              </select>
            </>
          ) : null}
          {tab === 'events' ? (
            <>
              <input
                style={styles.input}
                value={eventFilter}
                onChange={event => setEventFilter(event.currentTarget.value)}
                placeholder={eventVisibility === 'activity' ? 'Filter activity' : 'Filter events'}
              />
              <select
                aria-label='Event visibility'
                title='Activity groups causal work; All events shows the raw instrumentation stream'
                value={eventVisibility}
                onChange={event => setEventVisibility(event.currentTarget.value as EventVisibility)}
                style={styles.select}
              >
                <option value='activity'>Activity</option>
                <option value='all'>All events</option>
              </select>
            </>
          ) : null}
          {tab === 'cache' ? (
            <input
              style={styles.input}
              value={cacheFilter}
              onChange={event => setCacheFilter(event.currentTarget.value)}
              placeholder='Filter entity ID or value'
            />
          ) : null}
          {tab === 'events' ? (
            <span
              title='The oldest event is discarded when the bounded buffer is full'
              style={{ color: colors.muted, whiteSpace: 'nowrap' }}
            >
              {snapshot.events.length} / {collector.eventLimit} retained
            </span>
          ) : null}
          {tab === 'timeline' ? (
            <TimelineFollowControl value={timelineFollow} onChange={setTimelineFollow} />
          ) : null}
          {clearAction ? (
            <ClearButton disabled={clearAction.disabled} onClick={clearAction.run} />
          ) : null}
          <span style={styles.spacer} />
          {status ? (
            <span style={{ color: colors.muted, whiteSpace: 'nowrap' }}>{status}</span>
          ) : null}
        </header>
        <main style={styles.body}>
          {tab === 'queries' ? (
            <QueriesTab
              model={model}
              filter={queryFilter}
              visibility={queryVisibility}
              inspectedQueryCounts={inspected?.queryCounts ?? null}
              selectedQueryId={selectedQueryId}
              onSelectedQueryIdChange={setSelectedQueryId}
            />
          ) : null}
          {tab === 'timeline' ? (
            <TimelineTab
              snapshot={snapshot}
              model={model}
              filter={timelineFilter}
              visibility={timelineVisibility}
              follow={timelineFollow}
              onFollowChange={setTimelineFollow}
              onTraceSelect={traceId => {
                setSelectedTraceId(traceId)
                setTab('events')
              }}
            />
          ) : null}
          {tab === 'events' ? (
            <EventsTab
              events={snapshot.events}
              filter={eventFilter}
              visibility={eventVisibility}
              scopes={model.scopesByQueryId}
              selectedTraceId={selectedTraceId}
              onSelectedTraceIdChange={setSelectedTraceId}
            />
          ) : null}
          {tab === 'cache' ? (
            <CacheTab
              services={snapshot.cache ?? []}
              model={model}
              filter={cacheFilter}
              {...(cacheEditor ? { editor: cacheEditor } : {})}
              onViewTrace={traceId => {
                setSelectedTraceId(traceId)
                setTab('events')
              }}
              onViewQuery={queryId => {
                inspection?.stop()
                setQueryFilter('')
                setQueryVisibility('all')
                setSelectedQueryId(queryId)
                setTab('queries')
              }}
            />
          ) : null}
        </main>
      </section>
    </ThemeContext.Provider>
  )
}

function inspectionTitle({
  label,
  queryCounts,
  supported,
  truncated,
}: {
  label: string
  queryCounts: ReadonlyMap<string, number>
  supported: boolean
  truncated: boolean
}): string {
  if (!supported) return 'React component ownership is unavailable for this element'
  if (truncated) {
    return `Clear partial area filter: inspection reached its safety limit after finding ${queryCounts.size} query roots in ${label}`
  }
  return `Clear area filter: ${queryCounts.size} query roots mounted in ${label}`
}

function ClearButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  const { colors } = useDevtoolsTheme()
  return (
    <button
      type='button'
      style={{ ...buttonStyle(colors, false), opacity: disabled ? 0.55 : 1 }}
      disabled={disabled}
      onClick={onClick}
    >
      Clear
    </button>
  )
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean
  onClick: () => void
  label: string
}) {
  const { colors } = useDevtoolsTheme()
  return (
    <button
      type='button'
      style={{
        height: 40,
        alignSelf: 'stretch',
        padding: '0 6px',
        border: 0,
        borderBottom: `2px solid ${active ? colors.blue : 'transparent'}`,
        background: 'transparent',
        color: active ? colors.text : colors.muted,
        font: 'inherit',
        fontWeight: active ? 650 : 500,
        cursor: 'pointer',
      }}
      onClick={onClick}
    >
      {label}
    </button>
  )
}
