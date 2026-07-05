/**
 * Floating dev-tools panel: figbird's observability event log, a live query
 * inspector, and the demo server's control switches (latency, teammate
 * simulator, chaos, socket drop, reset).
 */

import { useEffect, useReducer, useRef, useState } from 'react'
import type { FigbirdEvent } from 'figbird'
import { figbird, socket } from '../figbird'
import { demoControl, type DemoState, type LatencyProfile } from '../demoControl'

interface LogEntry {
  id: number
  ts: number
  text: string
  kind: 'fetch' | 'realtime' | 'mutate' | 'action'
  status: 'start' | 'end' | 'error' | 'rollback' | 'event'
  durationMs?: number
}

export function DevToolsPanel() {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'log' | 'queries'>('log')
  const [paused, setPaused] = useState(false)
  const [filter, setFilter] = useState<'all' | 'fetch' | 'realtime' | 'mutate' | 'action'>('all')
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [demoState, setDemoState] = useState<DemoState | null>(null)
  const [resetting, setResetting] = useState(false)
  const counterRef = useRef(0)
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    return figbird.events.subscribe(event => {
      // A failed mutation disarms the one-shot chaos switch server-side — resync.
      if (event.kind === 'mutate:error') {
        demoControl
          .getState()
          .then(s => setDemoState(s))
          .catch(() => {})
      }
      if (pausedRef.current) return
      const entry = describeEvent(event, ++counterRef.current)
      if (!entry) return
      // figbird delivers events on a microtask, never mid-render — safe to set state.
      setEntries(prev => {
        const next = [...prev, entry]
        return next.length > 200 ? next.slice(next.length - 200) : next
      })
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    demoControl
      .getState()
      .then(s => {
        if (!cancelled) setDemoState(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Optimistically apply a demo-control patch, syncing back to the server's
  // response and rolling back if the request fails.
  const applyDemoPatch = async (patch: Partial<DemoState>) => {
    if (!demoState) return
    setDemoState({ ...demoState, ...patch })
    try {
      setDemoState(await demoControl.set(patch))
    } catch {
      setDemoState(demoState)
    }
  }

  const setLatency = (latency: LatencyProfile) => applyDemoPatch({ latency })
  const toggleTeammate = () => applyDemoPatch({ backgroundEnabled: !demoState?.backgroundEnabled })
  const armChaos = () => applyDemoPatch({ chaosArmed: !demoState?.chaosArmed })

  const dropConnection = () => {
    // Kill the transport; socket.io auto-reconnects and figbird's adapter refetches
    // every active query on the Manager's 'reconnect' event.
    const engine = (socket.io as unknown as { engine?: { close: () => void } }).engine
    engine?.close()
  }

  const resetServer = async () => {
    if (resetting) return
    if (!window.confirm('Reset server state and reload the page?')) return
    setResetting(true)
    try {
      await demoControl.reset()
      window.location.reload()
    } catch {
      setResetting(false)
    }
  }

  const filtered = filter === 'all' ? entries : entries.filter(e => e.kind === filter)

  return (
    <div className={`devtools ${open ? 'open' : ''}`}>
      <button className='devtools-toggle' onClick={() => setOpen(o => !o)}>
        {open ? 'Close' : 'Dev tools'} · {entries.length}
      </button>
      {open ? (
        <div className='devtools-panel'>
          <header className='devtools-head'>
            <span className='eyebrow'>Latency</span>
            {(['fast', 'realistic', 'slow'] as const).map(profile => (
              <button
                key={profile}
                className={`link ${demoState?.latency === profile ? 'selected' : ''}`}
                onClick={() => setLatency(profile)}
                disabled={demoState === null}
                title='Server-side simulated latency. Drag to slow and watch keep-previous-data + delayed spinners take over.'
              >
                {profile}
              </button>
            ))}
            <span className='sep'>·</span>
            <button
              className={`link ${demoState?.backgroundEnabled ? 'selected' : ''}`}
              onClick={toggleTeammate}
              disabled={demoState === null}
              title='A simulated teammate comments, reacts and closes issues every few seconds.'
            >
              Teammate: {demoState === null ? '…' : demoState.backgroundEnabled ? 'on' : 'off'}
            </button>
            <button
              className={`link ${demoState?.chaosArmed ? 'armed' : ''}`}
              onClick={armChaos}
              disabled={demoState === null}
              title='Arms a one-shot server failure: your next action fails and figbird rolls the optimistic change back.'
            >
              {demoState?.chaosArmed ? 'Chaos: armed' : 'Fail next mutation'}
            </button>
            <button
              className='link'
              onClick={dropConnection}
              title='Drops the socket; on reconnect figbird refetches every active query to reconcile anything missed.'
            >
              Drop socket
            </button>
            <button className='link' onClick={resetServer} disabled={resetting}>
              {resetting ? 'Resetting…' : 'Reset'}
            </button>
            <span className='spacer' />
            {(['log', 'queries'] as const).map(v => (
              <button
                key={v}
                className={`link ${view === v ? 'selected' : ''}`}
                onClick={() => setView(v)}
              >
                {v}
              </button>
            ))}
          </header>
          {view === 'queries' ? (
            <QueriesView />
          ) : (
            <>
              <header className='devtools-head sub'>
                {(['all', 'fetch', 'realtime', 'mutate', 'action'] as const).map(f => (
                  <button
                    key={f}
                    className={`link ${filter === f ? 'selected' : ''}`}
                    onClick={() => setFilter(f)}
                  >
                    {f}
                  </button>
                ))}
                <span className='spacer' />
                <button className='link' onClick={() => setPaused(p => !p)}>
                  {paused ? 'Resume' : 'Pause'}
                </button>
                <button className='link' onClick={() => setEntries([])}>
                  Clear
                </button>
              </header>
              <ol className='devtools-log'>
                {filtered
                  .slice()
                  .reverse()
                  .map(entry => (
                    <li key={entry.id} className={`devtools-row ${entry.kind} ${entry.status}`}>
                      <span className='devtools-ts'>{formatTime(entry.ts)}</span>
                      <span className={`devtools-tag tag-${entry.kind}`}>{entry.kind}</span>
                      <span className='devtools-text'>{entry.text}</span>
                      {entry.durationMs != null ? (
                        <span className='devtools-duration'>{entry.durationMs}ms</span>
                      ) : null}
                    </li>
                  ))}
              </ol>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Live table of every query in the store, with figbird's own classification of how
 * each one is maintained: local-exact (events merge locally), server-window
 * (windowed — events refetch the window), server-authoritative (server-only
 * semantics — events refetch).
 */
function QueriesView() {
  const [, force] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    let scheduled = false
    return figbird.subscribeToStateChanges(() => {
      if (scheduled) return
      scheduled = true
      setTimeout(() => {
        scheduled = false
        force()
      }, 250)
    })
  }, [])

  // figbird.inspect() is the public, stable projection of the live query store —
  // no reaching into internals.
  const rows = figbird.inspect()

  return (
    <ol className='devtools-log queries'>
      {rows.map(row => {
        const query =
          row.query && Object.keys(row.query).length > 0 ? JSON.stringify(row.query) : ''
        return (
          <li key={row.queryId} className='devtools-row'>
            <span className={`q-badge ${row.classification}`}>{row.classification}</span>
            <span className='devtools-text'>
              <strong>{row.serviceName}</strong>
              {query ? <span className='q-query'> {query}</span> : null}
            </span>
            <span className='q-meta'>
              {row.itemCount} item{row.itemCount === 1 ? '' : 's'} · {row.status}
              {row.isFetching ? ' · fetching' : ''}
              {row.subscriberCount > 0 ? ` · ${row.subscriberCount} sub` : ''}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function describeEvent(event: FigbirdEvent, id: number): LogEntry | null {
  const ts = Date.now()
  switch (event.kind) {
    case 'fetch:start':
      return {
        id,
        ts,
        kind: 'fetch',
        status: 'start',
        text: `${event.method.toUpperCase()} ${event.serviceName}${
          'resourceId' in event && event.resourceId != null ? ` #${event.resourceId}` : ''
        }`,
      }
    case 'fetch:end':
      return {
        id,
        ts,
        kind: 'fetch',
        status: 'end',
        durationMs: event.durationMs,
        text: `${event.method.toUpperCase()} ${event.serviceName} → ${event.itemCount} item${event.itemCount === 1 ? '' : 's'}`,
      }
    case 'fetch:error':
      return {
        id,
        ts,
        kind: 'fetch',
        status: 'error',
        durationMs: event.durationMs,
        text: `${event.method.toUpperCase()} ${event.serviceName} failed: ${event.error.message}`,
      }
    case 'realtime':
      return {
        id,
        ts,
        kind: 'realtime',
        status: 'event',
        text: `${event.serviceName} ${event.type}${event.itemId != null ? ` #${event.itemId}` : ''}`,
      }
    case 'mutate:start':
      return {
        id,
        ts,
        kind: 'mutate',
        status: 'start',
        text: `${event.method} ${event.serviceName}${event.id != null ? ` #${event.id}` : ''}${
          event.optimistic ? ' (optimistic)' : ''
        }`,
      }
    case 'mutate:end':
      return {
        id,
        ts,
        kind: 'mutate',
        status: 'end',
        durationMs: event.durationMs,
        text: `${event.method} ${event.serviceName}${event.id != null ? ` #${event.id}` : ''} ok`,
      }
    case 'mutate:error':
      return {
        id,
        ts,
        kind: 'mutate',
        status: 'error',
        durationMs: event.durationMs,
        text: `${event.method} ${event.serviceName}${event.id != null ? ` #${event.id}` : ''} failed: ${event.error.message}`,
      }
    case 'mutate:rollback':
      return {
        id,
        ts,
        kind: 'mutate',
        status: 'rollback',
        text: `${event.method} ${event.serviceName}${event.id != null ? ` #${event.id}` : ''} rolled back`,
      }
    // App-vocabulary events from named useAction hooks — the mutate rows they
    // wrap appear alongside, correlated by time.
    case 'action:start':
      return {
        id,
        ts,
        kind: 'action',
        status: 'start',
        text: event.name ?? '(anonymous action)',
      }
    case 'action:end':
      return {
        id,
        ts,
        kind: 'action',
        status: 'end',
        durationMs: event.durationMs,
        text: `${event.name ?? '(anonymous action)'} ok`,
      }
    case 'action:error':
      return {
        id,
        ts,
        kind: 'action',
        status: 'error',
        durationMs: event.durationMs,
        text: `${event.name ?? '(anonymous action)'} failed: ${event.error.message}`,
      }
  }
  return null
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`
}
