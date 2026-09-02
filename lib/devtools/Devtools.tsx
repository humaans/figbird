import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { CacheTab, type DevtoolsCacheEditor } from './CacheTab.js'
import { EventsTab } from './EventsTab.js'
import { QueriesTab, operationIsInactive, operationIsRetained } from './QueriesTab.js'
import { TimelineFollowControl, TimelineTab } from './TimelineTab.js'
import type { TimelineVisibility } from './TimelineActivityTable.js'
import type { Collector, QuerySpan } from './collector.js'
import { buildDevtoolsModel } from './model.js'
import {
  ThemeContext,
  TooltipLayer,
  buttonStyle,
  darkColors,
  lightColors,
  makeStyles,
  useDevtoolsTheme,
  usePreferredColorScheme,
  type DevtoolsThemeMode,
} from './ui.js'

const TABS = ['queries', 'timeline', 'events', 'cache'] as const
const DEVTOOLS_TAB_STORAGE_KEY = 'figbird.devtools.tab'

type Tab = (typeof TABS)[number]
export type QueryVisibility = 'active' | 'inactive' | 'retained' | 'all' | 'skipped'
export type EventVisibility = 'groups' | 'raw'

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
  const [tab, setTab] = useState<Tab>(readStoredTab)
  const [queryFilter, setQueryFilter] = useState('')
  const [queryVisibility, setQueryVisibility] = useState<QueryVisibility>('active')
  const [eventFilter, setEventFilter] = useState('')
  const [eventVisibility, setEventVisibility] = useState<EventVisibility>('groups')
  const [timelineFilter, setTimelineFilter] = useState('')
  const [timelineVisibility, setTimelineVisibility] = useState<TimelineVisibility>('all')
  const [cacheFilter, setCacheFilter] = useState('')
  const [selectedQueryId, setSelectedQueryId] = useState<string | null>(null)
  const [selectedTraceId, setSelectedTraceId] = useState<number | null>(null)
  const [requestedTimelineActivityId, setRequestedTimelineActivityId] = useState<string | null>(
    null,
  )
  const [requestedCacheEntity, setRequestedCacheEntity] = useState<{
    serviceName: string
    itemId: string | number
  } | null>(null)
  const [timelineFollow, setTimelineFollow] = useState(true)
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => storeTab(tab), [tab])

  const inspectFetch = useCallback((span: QuerySpan) => {
    if (span.fetchId !== undefined) {
      setTimelineFilter('')
      setTimelineVisibility('all')
      setTimelineFollow(false)
      setRequestedTimelineActivityId(`fetch:${span.fetchId}`)
      setTab('timeline')
      return
    }

    const traceId = span.traceIds?.[0]
    if (traceId !== undefined) {
      setSelectedTraceId(traceId)
      setTab('events')
    }
  }, [])

  const openQuery = useCallback(
    (queryId: string) => {
      inspection?.stop()
      setQueryFilter('')
      setQueryVisibility('all')
      setSelectedQueryId(queryId)
      setTab('queries')
    },
    [inspection],
  )

  const openCacheEntity = useCallback((serviceName: string, itemId: string | number) => {
    setCacheFilter('')
    setRequestedCacheEntity({ serviceName, itemId })
    setTab('cache')
  }, [])

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
  const retainedQueryCount = model.operations.filter(operationIsRetained).length
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
      ? {
          label: 'Clear events',
          disabled: snapshot.events.length === 0,
          run: () => collector.clearEvents(),
        }
      : tab === 'timeline'
        ? { label: 'Clear recording', disabled: timelineEmpty, run: clearTimeline }
        : null
  const inspected = inspectionSnapshot.kind === 'selected' ? inspectionSnapshot : null

  return (
    <ThemeContext.Provider value={themeValue}>
      <section
        ref={panelRef}
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
        <TooltipLayer rootRef={panelRef} />
        <header style={styles.header}>
          <span style={styles.brand}>figbird</span>
          {TABS.map(item => (
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
                value={queryVisibility}
                onChange={event => setQueryVisibility(event.currentTarget.value as QueryVisibility)}
                style={styles.select}
              >
                <option value='active'>Live queries</option>
                <option value='inactive'>
                  Inactive cached{inactiveQueryCount > 0 ? ` (${inactiveQueryCount})` : ''}
                </option>
                <option value='retained'>
                  Retained history{retainedQueryCount > 0 ? ` (${retainedQueryCount})` : ''}
                </option>
                <option value='skipped'>
                  Skipped queries{skippedQueryCount > 0 ? ` (${skippedQueryCount})` : ''}
                </option>
                <option value='all'>All queries</option>
              </select>
              {inspection ? (
                <button
                  type='button'
                  style={buttonStyle(colors, inspectionSnapshot.kind === 'picking')}
                  onClick={
                    inspectionSnapshot.kind === 'picking' ? inspection.stop : inspection.start
                  }
                  data-tooltip='Pick an area of the inspected page and show its mounted queries'
                >
                  {inspectionSnapshot.kind === 'picking' ? 'Cancel' : 'Inspect'}
                </button>
              ) : null}
              {inspected ? (
                <button
                  type='button'
                  onClick={inspection!.stop}
                  data-tooltip={inspectionTitle(inspected)}
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
                placeholder={
                  eventVisibility === 'groups' ? 'Filter causal groups' : 'Filter raw events'
                }
              />
              <select
                aria-label='Event visibility'
                data-tooltip='Causal groups connect related work; Raw events shows the instrumentation stream'
                value={eventVisibility}
                onChange={event => setEventVisibility(event.currentTarget.value as EventVisibility)}
                style={styles.select}
              >
                <option value='groups'>Causal groups</option>
                <option value='raw'>Raw events</option>
              </select>
            </>
          ) : null}
          {tab === 'cache' ? (
            <input
              style={styles.input}
              value={cacheFilter}
              onChange={event => setCacheFilter(event.currentTarget.value)}
              placeholder='Filter service, entity ID, or value'
            />
          ) : null}
          {tab === 'events' ? (
            <span
              data-tooltip='The oldest event is discarded when the bounded buffer is full'
              style={{ color: colors.muted, whiteSpace: 'nowrap' }}
            >
              {snapshot.events.length} / {collector.eventLimit} retained
            </span>
          ) : null}
          {tab === 'timeline' ? (
            <TimelineFollowControl value={timelineFollow} onChange={setTimelineFollow} />
          ) : null}
          {clearAction ? (
            <ClearButton
              label={clearAction.label}
              disabled={clearAction.disabled}
              onClick={clearAction.run}
            />
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
              onFetchSelect={inspectFetch}
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
              requestedActivityId={requestedTimelineActivityId}
              onRequestedActivityHandled={() => setRequestedTimelineActivityId(null)}
              onQuerySelect={openQuery}
              onCacheEntitySelect={openCacheEntity}
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
              onViewQuery={openQuery}
            />
          ) : null}
          {tab === 'cache' ? (
            <CacheTab
              services={snapshot.cache ?? []}
              model={model}
              filter={cacheFilter}
              requestedEntity={requestedCacheEntity}
              onRequestedEntityHandled={() => setRequestedCacheEntity(null)}
              {...(cacheEditor ? { editor: cacheEditor } : {})}
              onViewTrace={traceId => {
                setSelectedTraceId(traceId)
                setTab('events')
              }}
              onViewQuery={openQuery}
            />
          ) : null}
        </main>
      </section>
    </ThemeContext.Provider>
  )
}

function readStoredTab(): Tab {
  if (typeof window === 'undefined') return 'timeline'

  try {
    const storedTab = window.localStorage.getItem(DEVTOOLS_TAB_STORAGE_KEY)
    return TABS.find(tab => tab === storedTab) ?? 'timeline'
  } catch {
    return 'timeline'
  }
}

function storeTab(tab: Tab): void {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(DEVTOOLS_TAB_STORAGE_KEY, tab)
  } catch {
    // Devtools still work when storage is unavailable.
  }
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

function ClearButton({
  label,
  disabled,
  onClick,
}: {
  label: string
  disabled: boolean
  onClick: () => void
}) {
  const { colors } = useDevtoolsTheme()
  return (
    <button
      type='button'
      style={{ ...buttonStyle(colors, false), opacity: disabled ? 0.55 : 1 }}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
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
        fontWeight: 500,
        cursor: 'pointer',
      }}
      onClick={onClick}
    >
      {label}
    </button>
  )
}
