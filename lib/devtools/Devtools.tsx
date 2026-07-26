import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { createCollector, type Collector, type FigbirdLikeForDevtools } from './collector.js'
import { describeElement, inspectQueryArea, type InspectedQueryArea } from './inspector.js'
import { QueriesTab } from './QueriesTab.js'
import { TimelineRangeControl, TimelineTab, type TimelineRange } from './TimelineTab.js'
import { EventsTab } from './EventsTab.js'
import { WritesTab } from './WritesTab.js'
import { buildDevtoolsModel } from './model.js'
import {
  ThemeContext,
  buttonStyle,
  darkColors,
  iconButtonStyle,
  lightColors,
  makeStyles,
  useDevtoolsTheme,
  usePreferredColorScheme,
} from './ui.js'

export interface FigbirdDevtoolsProps {
  figbird: FigbirdLikeForDevtools
  /** An externally owned, already-started collector. Primarily useful for custom hosts and tests. */
  collector?: Collector
  defaultOpen?: boolean
  /** Used only when enable() or disable() has not stored an explicit preference. */
  enabledByDefault?: boolean
  theme?: 'system' | 'light' | 'dark'
}

type Tab = 'queries' | 'timeline' | 'events' | 'writes'

const STORAGE_KEY = 'figbird:devtools'
const MIN_HEIGHT = 220
const DEFAULT_HEIGHT = 360

export function FigbirdDevtools(props: FigbirdDevtoolsProps) {
  const { figbird, enabledByDefault = false } = props
  const subscribe = useCallback(
    (listener: () => void) => figbird.devtools?.subscribe(listener) ?? (() => {}),
    [figbird.devtools],
  )
  const getSnapshot = useCallback(() => figbird.devtools?.getSnapshot(), [figbird.devtools])
  const preference = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  if (!(preference ?? enabledByDefault)) return null
  return <DevtoolsSession {...props} />
}

function DevtoolsSession({
  figbird,
  collector,
  defaultOpen = false,
  theme = 'system',
}: FigbirdDevtoolsProps) {
  const activeCollector = useMemo(() => collector ?? createCollector(figbird), [collector, figbird])
  const colorScheme = usePreferredColorScheme(theme)
  const colors = colorScheme === 'dark' ? darkColors : lightColors
  const styles = useMemo(() => makeStyles(colors), [colors])
  const themeValue = useMemo(() => ({ colors, styles }), [colors, styles])
  const [open, setOpen] = useState(defaultOpen)
  const [tab, setTab] = useState<Tab>('queries')
  const [height, setHeight] = useState(readStoredHeight)
  const [queryFilter, setQueryFilter] = useState('')
  const [queryActiveOnly, setQueryActiveOnly] = useState(true)
  const [eventFilter, setEventFilter] = useState('')
  const [timelineRange, setTimelineRange] = useState<TimelineRange>(30_000)
  const [popoutWindow, setPopoutWindow] = useState<Window | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [inspectedArea, setInspectedArea] = useState<InspectedQueryArea | null>(null)

  const startInspecting = useCallback(() => {
    setTab('queries')
    setInspecting(true)
    if (popoutWindow) window.focus()
  }, [popoutWindow])

  useEffect(() => {
    if (!inspecting) return
    const appDocument = window.document
    const overlay = appDocument.createElement('div')
    const label = appDocument.createElement('div')
    let hovered: Element | null = null
    const previousCursor = appDocument.documentElement.style.cursor

    Object.assign(overlay.style, {
      position: 'fixed',
      zIndex: '2147483647',
      pointerEvents: 'none',
      border: `2px solid ${colors.blue}`,
      background: 'rgba(29, 101, 216, .10)',
      boxSizing: 'border-box',
      display: 'none',
    })
    Object.assign(label.style, {
      position: 'absolute',
      left: '-2px',
      bottom: '100%',
      maxWidth: '320px',
      padding: '3px 6px',
      background: colors.blue,
      color: '#fff',
      font: '11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    })
    overlay.append(label)
    appDocument.body.append(overlay)
    appDocument.documentElement.style.cursor = 'crosshair'

    const updateOverlay = () => {
      if (!hovered || !hovered.isConnected) {
        overlay.style.display = 'none'
        return
      }
      const rect = hovered.getBoundingClientRect()
      Object.assign(overlay.style, {
        display: 'block',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      })
    }
    const selectableTarget = (event: Event): Element | null => {
      const target = event.target
      if (!(target instanceof window.Element) || target.closest('[data-figbird-devtools]'))
        return null
      return target
    }
    const onPointerMove = (event: PointerEvent) => {
      hovered = selectableTarget(event)
      if (hovered) label.textContent = describeElement(hovered)
      updateOverlay()
    }
    const onClick = (event: MouseEvent) => {
      const target = selectableTarget(event)
      if (!target) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      setInspectedArea(inspectQueryArea(target))
      setInspecting(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setInspecting(false)
    }

    appDocument.addEventListener('pointermove', onPointerMove, true)
    appDocument.addEventListener('click', onClick, true)
    appDocument.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('scroll', updateOverlay, true)
    window.addEventListener('resize', updateOverlay)
    return () => {
      appDocument.removeEventListener('pointermove', onPointerMove, true)
      appDocument.removeEventListener('click', onClick, true)
      appDocument.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('scroll', updateOverlay, true)
      window.removeEventListener('resize', updateOverlay)
      appDocument.documentElement.style.cursor = previousCursor
      overlay.remove()
    }
  }, [colors.blue, inspecting])

  const closeDevtools = useCallback(() => {
    if (popoutWindow && !popoutWindow.closed) popoutWindow.close()
    setPopoutWindow(null)
    setOpen(false)
  }, [popoutWindow])

  const toggleDevtools = useCallback(() => {
    if (open) {
      closeDevtools()
    } else {
      setOpen(true)
    }
  }, [closeDevtools, open])

  const dockDevtools = useCallback(() => {
    if (popoutWindow && !popoutWindow.closed) popoutWindow.close()
    setPopoutWindow(null)
  }, [popoutWindow])

  const popOutDevtools = useCallback(() => {
    if (popoutWindow && !popoutWindow.closed) {
      popoutWindow.focus()
      return
    }
    const width = Math.min(1400, window.screen.availWidth || 1400)
    const height = Math.min(900, window.screen.availHeight || 900)
    const popup = window.open(
      '',
      'figbird-devtools',
      `popup=yes,width=${width},height=${height},resizable=yes,scrollbars=yes`,
    )
    if (!popup) return
    popup.document.title = 'Figbird devtools'
    popup.focus()
    setPopoutWindow(popup)
  }, [popoutWindow])

  useEffect(() => {
    if (collector) return
    activeCollector.start()
    return () => activeCollector.stop()
  }, [activeCollector, collector])

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (!isDevtoolsShortcut(event)) return
      event.preventDefault()
      event.stopPropagation()
      toggleDevtools()
    }
    window.addEventListener('keydown', onShortcut)
    if (popoutWindow) popoutWindow.addEventListener('keydown', onShortcut)
    return () => {
      window.removeEventListener('keydown', onShortcut)
      if (popoutWindow) popoutWindow.removeEventListener('keydown', onShortcut)
    }
  }, [popoutWindow, toggleDevtools])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDevtools()
    }
    const targetWindow = popoutWindow ?? window
    targetWindow.addEventListener('keydown', onKey)
    return () => targetWindow.removeEventListener('keydown', onKey)
  }, [closeDevtools, open, popoutWindow])

  useEffect(() => {
    if (!popoutWindow) return
    const handleClosed = () => {
      setPopoutWindow(current => (current === popoutWindow ? null : current))
    }
    popoutWindow.addEventListener('beforeunload', handleClosed)
    return () => {
      popoutWindow.removeEventListener('beforeunload', handleClosed)
      if (!popoutWindow.closed) popoutWindow.close()
    }
  }, [popoutWindow])

  useEffect(() => {
    if (!popoutWindow) return
    const { document } = popoutWindow
    document.title = 'Figbird devtools'
    let viewport = document.querySelector('meta[name="viewport"]')
    if (!viewport) {
      viewport = document.createElement('meta')
      viewport.setAttribute('name', 'viewport')
      document.head.append(viewport)
    }
    viewport.setAttribute('content', 'width=device-width, initial-scale=1')
    document.documentElement.style.background = colors.bg
    document.documentElement.style.colorScheme = colorScheme
    document.documentElement.style.fontSize = '11px'
    document.documentElement.style.setProperty('text-size-adjust', 'none')
    document.documentElement.style.setProperty('-webkit-text-size-adjust', 'none')
    document.body.style.margin = '0'
    document.body.style.overflow = 'hidden'
    document.body.style.background = colors.bg
    document.body.style.color = colors.text
    document.body.style.fontSize = '11px'
  }, [colorScheme, colors.bg, colors.text, popoutWindow])

  useEffect(() => {
    writeStoredHeight(height)
  }, [height])

  const subscribe = useCallback(
    (fn: () => void) => activeCollector.subscribe(fn),
    [activeCollector],
  )
  const getSnapshot = useCallback(() => activeCollector.getSnapshot(), [activeCollector])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  useEffect(() => {
    setInspectedArea(current => {
      if (!current) return current
      if (!current.element.isConnected) return null
      const next = inspectQueryArea(current.element)
      return sameQueryCounts(current, next) ? current : next
    })
  }, [snapshot])

  const onResizeStart = (event: ReactMouseEvent) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = height
    const onMove = (move: MouseEvent) => {
      const next = Math.max(
        MIN_HEIGHT,
        Math.min(window.innerHeight - 48, startHeight + startY - move.clientY),
      )
      setHeight(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const model = useMemo(() => buildDevtoolsModel(snapshot), [snapshot])

  const drawer = (
    <section
      data-figbird-devtools='drawer'
      style={{
        ...styles.drawer,
        height: popoutWindow ? '100vh' : height,
        ...(popoutWindow ? { top: 0, borderTop: 'none', boxShadow: 'none', fontSize: 11 } : {}),
      }}
      aria-label='Figbird devtools'
    >
      {!popoutWindow ? <div style={styles.resize} onMouseDown={onResizeStart} /> : null}
      <header style={styles.header}>
        <span style={styles.brand}>figbird</span>
        {(['queries', 'timeline', 'events', 'writes'] as const).map(item => (
          <TabButton
            key={item}
            active={tab === item}
            onClick={() => setTab(item)}
            label={
              item === 'writes' && snapshot.inFlightWrites > 0
                ? `writes (${snapshot.inFlightWrites})`
                : item
            }
          />
        ))}
        {tab === 'queries' ? (
          <>
            <input
              style={styles.input}
              value={queryFilter}
              onChange={event => setQueryFilter(event.currentTarget.value)}
              placeholder='Filter service or query'
            />
            <label
              style={{
                color: colors.muted,
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                whiteSpace: 'nowrap',
              }}
            >
              <input
                type='checkbox'
                checked={queryActiveOnly}
                onChange={event => setQueryActiveOnly(event.currentTarget.checked)}
              />
              active only
            </label>
            <button
              type='button'
              style={buttonStyle(colors, inspecting)}
              onClick={inspecting ? () => setInspecting(false) : startInspecting}
              title='Pick an area of the app and show only its mounted queries'
            >
              {inspecting ? 'Cancel' : 'Inspect'}
            </button>
            {inspectedArea ? (
              <button
                type='button'
                onClick={() => setInspectedArea(null)}
                title={
                  inspectedArea.supported
                    ? `Clear area filter: ${inspectedArea.queryCounts.size} query roots mounted in ${inspectedArea.label}`
                    : 'React component ownership is unavailable for this element'
                }
                style={{
                  ...buttonStyle(colors, true),
                  color: inspectedArea.supported ? colors.blue : colors.red,
                  maxWidth: 145,
                  display: 'flex',
                  minWidth: 0,
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {inspectedArea.label}
                </span>
                <span style={{ flexShrink: 0 }}>
                  · {inspectedArea.supported ? inspectedArea.queryCounts.size : 'unavailable'}
                </span>
              </button>
            ) : null}
          </>
        ) : null}
        {tab === 'events' ? (
          <>
            <input
              style={styles.input}
              value={eventFilter}
              onChange={event => setEventFilter(event.currentTarget.value)}
              placeholder='Filter events'
            />
            <button
              type='button'
              style={{
                ...buttonStyle(colors, false),
                opacity: snapshot.events.length === 0 ? 0.55 : 1,
              }}
              disabled={snapshot.events.length === 0}
              onClick={() => activeCollector.clearEvents()}
            >
              Clear
            </button>
          </>
        ) : null}
        {tab === 'timeline' ? (
          <>
            <TimelineRangeControl value={timelineRange} onChange={setTimelineRange} />
            <button
              type='button'
              style={buttonStyle(colors, false)}
              onClick={() => activeCollector.clearTimeline()}
            >
              Clear
            </button>
          </>
        ) : null}
        {tab === 'writes' ? (
          <button
            type='button'
            style={{
              ...buttonStyle(colors, false),
              opacity: snapshot.writes.length === 0 ? 0.55 : 1,
            }}
            disabled={snapshot.writes.length === 0}
            onClick={() => activeCollector.clearWrites()}
          >
            Clear
          </button>
        ) : null}
        <span style={styles.spacer} />
        <button
          type='button'
          style={buttonStyle(colors, false)}
          onClick={popoutWindow ? dockDevtools : popOutDevtools}
          title={popoutWindow ? 'Move devtools back into the app' : 'Open devtools in a new window'}
        >
          {popoutWindow ? 'Dock' : 'Pop out'}
        </button>
        <button
          type='button'
          aria-label='Close'
          title='Close devtools'
          style={iconButtonStyle(colors)}
          onClick={closeDevtools}
        >
          ×
        </button>
      </header>
      <main style={styles.body}>
        {tab === 'queries' ? (
          <QueriesTab
            model={model}
            filter={queryFilter}
            activeOnly={queryActiveOnly}
            inspectedQueryCounts={inspectedArea?.queryCounts ?? null}
          />
        ) : null}
        {tab === 'timeline' ? (
          <TimelineTab snapshot={snapshot} model={model} range={timelineRange} />
        ) : null}
        {tab === 'events' ? (
          <EventsTab events={snapshot.events} filter={eventFilter} scopes={model.scopesByQueryId} />
        ) : null}
        {tab === 'writes' ? (
          <WritesTab writes={snapshot.writes} inFlight={snapshot.inFlightWrites} />
        ) : null}
      </main>
    </section>
  )

  return (
    <ThemeContext.Provider value={themeValue}>
      {open ? (popoutWindow ? createPortal(drawer, popoutWindow.document.body) : drawer) : null}
    </ThemeContext.Provider>
  )
}

function isDevtoolsShortcut(event: KeyboardEvent): boolean {
  return (
    event.code === 'Period' &&
    event.shiftKey &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.repeat
  )
}

function sameQueryCounts(a: InspectedQueryArea, b: InspectedQueryArea): boolean {
  if (
    a.label !== b.label ||
    a.supported !== b.supported ||
    a.queryCounts.size !== b.queryCounts.size
  ) {
    return false
  }
  for (const [key, count] of a.queryCounts) {
    if (b.queryCounts.get(key) !== count) return false
  }
  return true
}

function readStoredHeight(): number {
  if (typeof localStorage === 'undefined') return DEFAULT_HEIGHT
  const raw = localStorage.getItem(STORAGE_KEY)
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) ? Math.max(MIN_HEIGHT, parsed) : DEFAULT_HEIGHT
}

function writeStoredHeight(height: number): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(STORAGE_KEY, String(Math.round(height)))
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
