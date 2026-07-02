import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, Router, Routes, useNavigate, useRoute } from 'react-space-router'
import { useDelayedFlag, type FigbirdEvent } from 'figbird'
import { demoControl, figbird, useMutation, useQuery } from './figbird'
import { prepareIssueDetail } from './pages/IssueDetail/prepare'
import { PaginatePanel } from './pages/Paginate'
import { RelationalFiltersPanel } from './pages/RelationalFilters'
import { WindowedRelationsPanel } from './pages/WindowedRelations'

function useSelectedIssueId(): number | null {
  const route = useRoute()
  const idStr = route?.params?.id
  if (idStr == null) return null
  const n = Number(idStr)
  return Number.isFinite(n) ? n : null
}

function DelayedFallback({ delay = 250, children }: { delay?: number; children: ReactNode }) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), delay)
    return () => clearTimeout(t)
  }, [delay])
  return visible ? <>{children}</> : null
}

function StatusDot({ active }: { active: boolean }) {
  const show = useDelayedFlag(active, 300)
  return show ? <span className='dot' title='fetching' /> : null
}

function Sep() {
  return (
    <span aria-hidden className='sep'>
      ·
    </span>
  )
}

function NavTab({ href, label }: { href: string; label: string }) {
  const route = useRoute()
  const path = route?.pathname ?? '/'
  const isActive =
    href === '/' ? path === '/' || path.startsWith('/issues/') : path.startsWith(href)
  return (
    <Link href={href} className={`nav-link${isActive ? ' active' : ''}`}>
      {label}
    </Link>
  )
}

// ----- Issues tab (default workspace) -----

function IssueList() {
  const selectedId = useSelectedIssueId()
  const { data: issues, isFetching } = useQuery(
    figbird.q.issues
      .related('creator')
      .related('assignee')
      .related('team')
      .related('comments')
      .related('issueLabels', link => link.related('label')),
  )

  return (
    <aside className='list'>
      <header className='section-head'>
        <span className='eyebrow'>Issues</span>
        <span className='count'>{issues.length}</span>
        <StatusDot active={isFetching} />
      </header>
      <ul className='issue-rows'>
        {issues.map(issue => {
          const selected = issue.id === selectedId
          return (
            <li key={issue.id}>
              <Link
                href={`/issues/${issue.id}`}
                className={`issue-row ${selected ? 'selected' : ''}`}
              >
                <span className={`status-dot ${issue.status}`} />
                <span className='issue-row-main'>
                  <span className='issue-row-title'>{issue.title}</span>
                  <span className='issue-row-meta'>
                    {issue.assignee?.name ?? 'unassigned'}
                    {' · '}
                    {issue.team?.name ?? '—'}
                    {' · '}
                    {issue.comments.length} {issue.comments.length === 1 ? 'comment' : 'comments'}
                  </span>
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}

function HotQueue() {
  const {
    data: issues,
    isFetching,
    refetch,
  } = useQuery(
    figbird.q.issues
      .where({ status: 'open' })
      .orderBy('priorityScore', 'desc')
      .limit(3)
      .related('assignee')
      .related('team'),
  )
  const issueMutation = useMutation('issues')

  const promoteHiddenIssue = () => {
    issueMutation.patch(6, { priorityScore: 99, status: 'open' })
  }

  return (
    <section className='aside-section'>
      <header className='section-head'>
        <span className='eyebrow'>Top open</span>
        <StatusDot active={isFetching || issueMutation.status === 'loading'} />
      </header>
      <ul className='hot-rows'>
        {issues.map((issue, index) => (
          <li key={issue.id}>
            <Link href={`/issues/${issue.id}`} className='hot-row'>
              <span className='hot-rank'>{index + 1}</span>
              <span className='hot-main'>
                <span className='hot-title'>{issue.title}</span>
                <span className='hot-sub'>
                  {issue.assignee?.name ?? 'unassigned'} · {issue.team?.name ?? '—'}
                </span>
              </span>
              <span className='hot-score'>{issue.priorityScore}</span>
            </Link>
          </li>
        ))}
      </ul>
      <div className='aside-actions'>
        <button className='link' onClick={refetch}>
          Refetch
        </button>
        <button className='link' onClick={promoteHiddenIssue}>
          Promote hidden
        </button>
      </div>
    </section>
  )
}

function EmptyDetail() {
  return (
    <main className='detail'>
      <p className='empty-line'>Pick an issue from the list.</p>
    </main>
  )
}

function DemoConsole() {
  const selectedId = useSelectedIssueId()
  const navigate = useNavigate()
  const issueMutation = useMutation('issues')

  const createIssue = async () => {
    const id = Date.now()
    await issueMutation.create({
      id,
      title: `Realtime-created issue ${String(id).slice(-4)}`,
      status: 'open',
      creatorId: 1,
      assigneeId: 4,
      teamId: 2,
      priorityScore: 57,
      updatedAt: new Date().toISOString(),
    })
    navigate(`/issues/${id}`)
  }

  const removeSelected = async () => {
    if (selectedId == null) return
    await issueMutation.remove(selectedId, { optimistic: true })
    navigate('/')
  }

  return (
    <section className='aside-section'>
      <header className='section-head'>
        <span className='eyebrow'>Console</span>
        <StatusDot active={issueMutation.status === 'loading'} />
      </header>
      <div className='aside-actions stacked'>
        <button className='link' onClick={createIssue}>
          + New issue
        </button>
        <button className='link danger' onClick={removeSelected} disabled={selectedId == null}>
          Remove selected
        </button>
      </div>
      <p className='note'>
        Background traffic is off by default. Open dev tools and flip "Background" on to watch
        active queries reconcile in place. Use "Reset server" to restore initial seed data.
      </p>
    </section>
  )
}

// ----- Search tab -----

function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

function SearchPanel() {
  const [q, setQ] = useState('')
  const debouncedQ = useDebounced(q, 250)

  return (
    <main className='detail'>
      <header className='detail-head'>
        <h1 className='detail-title'>Server-authoritative search</h1>
        <div className='detail-meta'>
          The query carries `$regex` to the server. figbird flips the result into server-maintained
          mode, so realtime events arrive but don't auto-merge unless they match the live filter.
        </div>
      </header>

      <div className='search-bar'>
        <input
          autoFocus
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder='search issue titles…'
          className='search-input'
        />
        {q !== debouncedQ ? <span className='dim'>typing…</span> : null}
      </div>

      {debouncedQ.trim() === '' ? (
        <p className='empty-line'>Type to search.</p>
      ) : (
        <Suspense fallback={<p className='empty-line'>Searching…</p>}>
          <SearchResults q={debouncedQ.trim()} />
        </Suspense>
      )}
    </main>
  )
}

function SearchResults({ q }: { q: string }) {
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const {
    data: issues,
    isFetching,
    refetch,
  } = useQuery(
    figbird.q.issues
      .where({ title: { $regex: escaped, $options: 'i' } } as never)
      .orderBy('priorityScore', 'desc')
      .limit(20)
      .server()
      .related('assignee')
      .related('team'),
  )

  return (
    <>
      <div className='detail-meta-line'>
        <span className='dim'>
          {issues.length} match{issues.length === 1 ? '' : 'es'}
        </span>
        <StatusDot active={isFetching} />
        <span className='spacer' />
        <button className='link' onClick={refetch} disabled={isFetching}>
          Refetch
        </button>
      </div>
      {issues.length === 0 ? (
        <p className='empty-line'>No matches.</p>
      ) : (
        <ul className='issue-rows search-rows'>
          {issues.map(issue => (
            <li key={issue.id}>
              <Link href={`/issues/${issue.id}`} className='issue-row'>
                <span className={`status-dot ${issue.status}`} />
                <span className='issue-row-main'>
                  <span
                    className='issue-row-title'
                    dangerouslySetInnerHTML={{ __html: highlight(issue.title, q) }}
                  />
                  <span className='issue-row-meta'>
                    {issue.assignee?.name ?? 'unassigned'} · {issue.team?.name ?? '—'} · priority{' '}
                    {issue.priorityScore}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function highlight(text: string, q: string): string {
  const safeText = text.replace(/[&<>"']/g, ch =>
    ch === '&'
      ? '&amp;'
      : ch === '<'
        ? '&lt;'
        : ch === '>'
          ? '&gt;'
          : ch === '"'
            ? '&quot;'
            : '&#39;',
  )
  if (!q) return safeText
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return safeText.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>')
}

// ----- Activity tab -----

interface ActivityEntry {
  kind: 'comment' | 'reaction' | 'issue-patch'
  key: string
  ts: number
  title: ReactNode
  body?: ReactNode
}

function ActivityFeed() {
  // Three independent queries on three services. The activity feed merges them
  // by timestamp client-side so realtime events on any service flow in live.
  const { data: comments } = useQuery(
    figbird.q.comments.orderBy('id', 'desc').limit(20).related('author'),
  )
  const { data: reactions } = useQuery(
    figbird.q.reactions.orderBy('id', 'desc').limit(20).related('user'),
  )
  const { data: issues, isFetching } = useQuery(
    figbird.q.issues.orderBy('updatedAt', 'desc').limit(15),
  )

  const entries = useMemo<ActivityEntry[]>(() => {
    const out: ActivityEntry[] = []
    for (const c of comments) {
      out.push({
        kind: 'comment',
        key: `c-${c.id}`,
        ts: c.id,
        title: (
          <>
            <span className='comment-avatar small'>{c.author?.avatar ?? '○'}</span>
            <strong>{c.author?.name ?? 'unknown'}</strong> commented on{' '}
            <Link href={`/issues/${c.issueId}`} className='inline-link'>
              #{c.issueId}
            </Link>
          </>
        ),
        body: <span className='dim'>{c.body}</span>,
      })
    }
    for (const r of reactions) {
      out.push({
        kind: 'reaction',
        key: `r-${r.id}`,
        ts: r.id,
        title: (
          <>
            <span className='comment-avatar small'>{r.user?.avatar ?? '○'}</span>
            <strong>{r.user?.name ?? 'someone'}</strong> reacted {r.emoji} on comment #{r.commentId}
          </>
        ),
      })
    }
    for (const i of issues) {
      out.push({
        kind: 'issue-patch',
        key: `i-${i.id}-${i.updatedAt}`,
        ts: Date.parse(i.updatedAt) || 0,
        title: (
          <>
            <span className={`status-dot ${i.status}`} />{' '}
            <Link href={`/issues/${i.id}`} className='inline-link'>
              #{i.id}
            </Link>{' '}
            <span className='dim'>updated · priority {i.priorityScore}</span>
          </>
        ),
        body: <span>{i.title}</span>,
      })
    }
    out.sort((a, b) => b.ts - a.ts)
    return out.slice(0, 40)
  }, [comments, reactions, issues])

  return (
    <main className='detail'>
      <header className='detail-head'>
        <h1 className='detail-title'>Cross-service activity</h1>
        <div className='detail-meta'>
          Three independent queries (comments, reactions, issues) merged by timestamp. The
          background ticker drives live entries.
        </div>
        <div className='detail-meta-line'>
          <StatusDot active={isFetching} />
        </div>
      </header>
      {entries.length === 0 ? (
        <p className='empty-line'>No activity yet.</p>
      ) : (
        <ul className='activity-list'>
          {entries.map(e => (
            <li key={e.key} className={`activity-item ${e.kind}`}>
              <div className='activity-title'>{e.title}</div>
              {e.body ? <div className='activity-body'>{e.body}</div> : null}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

// ----- Floating dev-tools panel -----

interface LogEntry {
  id: number
  ts: number
  text: string
  kind: 'fetch' | 'realtime' | 'mutate'
  status: 'start' | 'end' | 'error' | 'rollback' | 'event'
  durationMs?: number
}

function DevToolsPanel() {
  const [open, setOpen] = useState(false)
  const [paused, setPaused] = useState(false)
  const [filter, setFilter] = useState<'all' | 'fetch' | 'realtime' | 'mutate'>('all')
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [backgroundEnabled, setBackgroundEnabled] = useState<boolean | null>(null)
  const [resetting, setResetting] = useState(false)
  const counterRef = useRef(0)
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    return figbird.events.subscribe(event => {
      if (pausedRef.current) return
      const entry = describeEvent(event, ++counterRef.current)
      if (!entry) return
      // Defer to microtask so figbird's synchronous emits during another component's
      // render don't trigger React's "setState during render" warning.
      queueMicrotask(() => {
        setEntries(prev => {
          const next = [...prev, entry]
          return next.length > 200 ? next.slice(next.length - 200) : next
        })
      })
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    demoControl
      .getState()
      .then(s => {
        if (!cancelled) setBackgroundEnabled(s.backgroundEnabled)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const toggleBackground = async () => {
    const next = !(backgroundEnabled ?? false)
    setBackgroundEnabled(next) // optimistic
    try {
      const res = await demoControl.setBackgroundEnabled(next)
      setBackgroundEnabled(res.backgroundEnabled)
    } catch {
      setBackgroundEnabled(!next) // rollback
    }
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
            <span className='eyebrow'>Server</span>
            <button
              className={`link ${backgroundEnabled ? 'selected' : ''}`}
              onClick={toggleBackground}
              disabled={backgroundEnabled === null}
              title='When on, the server emits a background comment / 6s, reaction / 9s, and priority patch / 12s.'
            >
              Background: {backgroundEnabled === null ? '…' : backgroundEnabled ? 'on' : 'off'}
            </button>
            <button className='link' onClick={resetServer} disabled={resetting}>
              {resetting ? 'Resetting…' : 'Reset server'}
            </button>
            <span className='spacer' />
            <span className='eyebrow'>Events</span>
            {(['all', 'fetch', 'realtime', 'mutate'] as const).map(f => (
              <button
                key={f}
                className={`link ${filter === f ? 'selected' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f}
              </button>
            ))}
            <Sep />
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
        </div>
      ) : null}
    </div>
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
  }
  return null
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

// ----- Layout & routing -----

function WorkspaceSkeleton() {
  return (
    <div className='grid'>
      <aside className='list'>
        <header className='section-head'>
          <span className='eyebrow'>Issues</span>
        </header>
        <div className='skeleton-list'>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className='skeleton-row' />
          ))}
        </div>
      </aside>
      <main className='detail'>
        <div className='skeleton-detail'>
          <div className='skeleton-bar w-30' />
          <div className='skeleton-bar w-80 lg' />
          <div className='skeleton-bar w-50' />
        </div>
      </main>
      <aside className='aside'>
        <header className='section-head'>
          <span className='eyebrow'>Top open</span>
        </header>
        <div className='skeleton-list compact'>
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className='skeleton-row' />
          ))}
        </div>
      </aside>
    </div>
  )
}

function Workspace({ children }: { children?: ReactNode }) {
  const route = useRoute()
  const path = route?.pathname ?? '/'
  const isFull =
    path.startsWith('/search') ||
    path.startsWith('/activity') ||
    path.startsWith('/paginate') ||
    path.startsWith('/filters') ||
    path.startsWith('/windows')
  // Keyed Suspense boundary for issue detail: each id starts cold so the destination
  // shows its own skeleton instead of leaking the previous issue's data while the
  // new one loads.
  const issueId = path.startsWith('/issues/') ? (route?.params?.id ?? null) : null

  return (
    <>
      <nav className='nav'>
        <span className='brand'>figbird</span>
        <span className='tagline'>relational query lab</span>
        <span className='spacer' />
        <NavTab href='/' label='Issues' />
        <NavTab href='/search' label='Search' />
        <NavTab href='/activity' label='Activity' />
        <NavTab href='/paginate' label='Paginate' />
        <NavTab href='/windows' label='Windows' />
        <NavTab href='/filters' label='Filters' />
      </nav>
      {isFull ? (
        <div className='full grid-fade'>{children}</div>
      ) : (
        <div className='grid grid-fade'>
          <IssueList />
          <Suspense
            key={issueId ?? 'empty'}
            fallback={
              <main className='detail'>
                <div className='skeleton-detail'>
                  <div className='skeleton-bar w-30' />
                  <div className='skeleton-bar w-80 lg' />
                  <div className='skeleton-bar w-50' />
                </div>
              </main>
            }
          >
            {children}
          </Suspense>
          <aside className='aside'>
            <HotQueue />
            <DemoConsole />
          </aside>
        </div>
      )}
    </>
  )
}

const routes = [
  {
    component: Workspace,
    routes: [
      { path: '/', component: EmptyDetail },
      {
        path: '/issues/:id',
        resolver: () => import('./pages/IssueDetail/screen'),
        prepare: prepareIssueDetail,
        navigation: { commit: 'immediate' },
      },
      { path: '/search', component: SearchPanel },
      { path: '/activity', component: ActivityFeed },
      { path: '/paginate', component: PaginatePanel },
      { path: '/windows', component: WindowedRelationsPanel },
      { path: '/filters', component: RelationalFiltersPanel },
    ],
  },
]

export function App() {
  return (
    <div className='app'>
      <Router>
        <Suspense
          fallback={
            <DelayedFallback delay={250}>
              <WorkspaceSkeleton />
            </DelayedFallback>
          }
        >
          <Routes routes={routes} />
        </Suspense>
      </Router>
      <DevToolsPanel />
    </div>
  )
}
