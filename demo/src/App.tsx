import {
  Suspense,
  startTransition,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from 'react'
import { Link, Router, Routes, useNavigate, useRoute } from 'react-space-router'
import { classifyQueryNode, useDelayedFlag, type FigbirdEvent } from 'figbird'
import {
  demoControl,
  figbird,
  useMutation,
  useQuery,
  type DemoState,
  type Issue,
  type LatencyProfile,
  type Team,
  type User,
} from './figbird'
import { prepareIssueDetail } from './pages/IssueDetail/prepare'

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

/**
 * Debounced value that commits inside a transition — when the downstream query
 * suspends (new search term = cold cache entry), React keeps the previous
 * committed UI on screen instead of flashing a fallback.
 */
function useDebouncedTransition<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => startTransition(() => setDebounced(value)), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

/**
 * Little ⓘ popover explaining what figbird is doing behind a piece of UI.
 * The didactic layer of the demo, without the tabs-full-of-prose.
 */
function Explain({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <span className='explain'>
      <button
        type='button'
        className={`explain-btn${open ? ' open' : ''}`}
        onClick={() => setOpen(o => !o)}
        aria-label={`How this works: ${label}`}
      >
        i
      </button>
      {open ? (
        <span className='explain-pop'>
          <span className='explain-title'>{label}</span>
          {children}
        </span>
      ) : null}
    </span>
  )
}

// ----- Issue list pane (search + filters + infinite pagination) -----

type StatusFilter = 'all' | 'open' | 'closed'

function IssueListPane() {
  const [searchInput, setSearchInput] = useState('')
  const search = useDebouncedTransition(searchInput.trim(), 250)
  const [status, setStatus] = useState<StatusFilter>('all')
  const [teamId, setTeamId] = useState<number | null>(null)
  const [isPending, filterTransition] = useTransition()

  const { data: teams } = useQuery(figbird.q.teams)

  const setStatusFilter = (next: StatusFilter) => filterTransition(() => setStatus(next))
  const setTeamFilter = (next: number | null) => filterTransition(() => setTeamId(next))

  return (
    <aside className='list'>
      <div className='list-controls'>
        <div className='search-line'>
          <input
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder='Search issues…'
            className='search-input'
          />
          <Explain label='Server-authoritative search'>
            The search query carries <code>$regex</code>, an operator figbird's local matcher can't
            evaluate — so it classifies the query <em>server-authoritative</em>: realtime events
            trigger a refetch instead of a local merge. Typing commits through{' '}
            <code>startTransition</code>, so the previous results stay visible while the next term
            loads.
          </Explain>
        </div>
        <div className='filter-row'>
          {(['all', 'open', 'closed'] as const).map(s => (
            <button
              key={s}
              className={`chip${status === s ? ' active' : ''}`}
              onClick={() => setStatusFilter(s)}
            >
              {s}
            </button>
          ))}
          <span className='sep' aria-hidden>
            ·
          </span>
          <button
            className={`chip${teamId === null ? ' active' : ''}`}
            onClick={() => setTeamFilter(null)}
          >
            any team
          </button>
          {teams.map(team => (
            <button
              key={team.id}
              className={`chip${teamId === team.id ? ' active' : ''}`}
              onClick={() => setTeamFilter(team.id)}
              title={`Issues whose assignee is on ${team.name}`}
            >
              {team.name}
            </button>
          ))}
          <Explain label='Relational filter'>
            The team chips filter by <code>'assignee.teamId'</code> — a field on the{' '}
            <em>related</em> user, not on the issue. The dotted path resolves to a join on the
            server; on the client, figbird's matcher evaluates it against the entity cache to keep
            the result fresh from realtime events.
          </Explain>
        </div>
      </div>
      <div className={`list-body${isPending ? ' pending' : ''}`}>
        <Suspense fallback={<ListSkeleton />}>
          {search !== '' ? (
            <SearchResults q={search} typing={search !== searchInput.trim()} />
          ) : (
            <PaginatedIssueRows status={status} teamId={teamId} />
          )}
        </Suspense>
      </div>
    </aside>
  )
}

function PaginatedIssueRows({ status, teamId }: { status: StatusFilter; teamId: number | null }) {
  const where: Record<string, unknown> = {}
  if (status !== 'all') where.status = status
  if (teamId != null) where['assignee.teamId'] = teamId

  const {
    data: issues,
    isFetching,
    loadMore,
    hasMore,
    isLoadingMore,
    totalCount,
  } = useQuery(
    figbird.q.issues
      .where(where)
      .orderBy('updatedAt', 'desc')
      .paginate({ pageSize: 25, returnTotal: true })
      .related('assignee')
      .related('team')
      .related('issueLabels', link => link.related('label')),
  )

  return (
    <>
      <header className='section-head'>
        <span className='eyebrow'>Issues</span>
        <span className='count'>
          {issues.length}
          {totalCount != null ? ` of ${totalCount}` : ''}
        </span>
        <StatusDot active={isFetching} />
        <Explain label='Paginated live list'>
          The list is one <code>.paginate({'{ pageSize: 25 }'})</code> query — each page is its own
          window on the server. Windowed queries are <em>server-window</em> class: realtime events
          can change membership invisibly (a row you can't see may now belong), so figbird refetches
          the affected pages instead of guessing. Comment counts come from{' '}
          <code>issue.commentIds</code>, a server-maintained id list — no comments are fetched here
          at all.
        </Explain>
      </header>
      <ul className='issue-rows'>
        {issues.map(issue => (
          <IssueRow key={issue.id} issue={issue} />
        ))}
      </ul>
      {hasMore ? (
        <div className='list-foot'>
          <button className='link' onClick={loadMore} disabled={isLoadingMore}>
            {isLoadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : null}
    </>
  )
}

function SearchResults({ q, typing }: { q: string; typing: boolean }) {
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const { data: issues, isFetching } = useQuery(
    figbird.q.issues
      .where({ title: { $regex: escaped, $options: 'i' } } as never)
      .orderBy('updatedAt', 'desc')
      .limit(30)
      .server()
      .related('assignee')
      .related('team'),
  )

  return (
    <>
      <header className='section-head'>
        <span className='eyebrow'>Search</span>
        <span className='count'>
          {issues.length} match{issues.length === 1 ? '' : 'es'}
        </span>
        <StatusDot active={isFetching || typing} />
      </header>
      {issues.length === 0 ? (
        <p className='empty-line'>No matches.</p>
      ) : (
        <ul className='issue-rows'>
          {issues.map(issue => (
            <IssueRow key={issue.id} issue={issue} highlight={q} />
          ))}
        </ul>
      )}
    </>
  )
}

type IssueRowData = Issue & {
  assignee: User | null
  team: Team | null
  issueLabels?: Array<{ id: number; label: { id: number; name: string; tone: string } | null }>
}

function IssueRow({ issue, highlight }: { issue: IssueRowData; highlight?: string }) {
  const selectedId = useSelectedIssueId()
  const commentCount = issue.commentIds?.length ?? 0
  return (
    <li>
      <Link
        href={`/issues/${issue.id}`}
        className={`issue-row ${issue.id === selectedId ? 'selected' : ''}`}
      >
        <span className={`status-dot ${issue.status}`} />
        <span className='issue-row-main'>
          <span className='issue-row-title'>
            {highlight ? <HighlightedText text={issue.title} q={highlight} /> : issue.title}
          </span>
          <span className='issue-row-meta'>
            {issue.assignee?.name ?? 'unassigned'}
            {' · '}
            {issue.team?.name ?? '—'}
            {' · '}
            {commentCount} {commentCount === 1 ? 'comment' : 'comments'}
            {issue.issueLabels?.length ? (
              <>
                {' '}
                {issue.issueLabels.map(link =>
                  link.label ? (
                    <span key={link.id} className={`label mini ${link.label.tone}`}>
                      {link.label.name}
                    </span>
                  ) : null,
                )}
              </>
            ) : null}
          </span>
        </span>
      </Link>
    </li>
  )
}

function HighlightedText({ text, q }: { text: string; q: string }) {
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === q.toLowerCase() ? <mark key={i}>{part}</mark> : part,
      )}
    </>
  )
}

function ListSkeleton() {
  return (
    <>
      <header className='section-head'>
        <span className='eyebrow'>Issues</span>
      </header>
      <div className='skeleton-list'>
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className='skeleton-row' />
        ))}
      </div>
    </>
  )
}

// ----- Right sidebar -----

function TeamsPanel() {
  const { data: teams, isFetching } = useQuery(
    figbird.q.teams.related('recentIssues', issue => issue.orderBy('updatedAt', 'desc').limit(3)),
  )

  return (
    <section className='aside-section'>
      <header className='section-head'>
        <span className='eyebrow'>Teams</span>
        <StatusDot active={isFetching} />
        <Explain label='Windowed relations'>
          "3 most recent issues per team" is{' '}
          <code>.related('recentIssues', i =&gt; i.orderBy(…).limit(3))</code>. A per-parent window
          can't be one flat query, so figbird runs one small query per team — fine at 4 teams; past
          ~10 it warns and points at the server-maintained-id-list (embed) pattern instead.
        </Explain>
      </header>
      <ul className='team-list'>
        {teams.map(team => (
          <li key={team.id} className='team-block'>
            <div className='team-name'>
              <span className='team-accent' style={{ background: team.accent }} />
              {team.name}
            </div>
            <ul className='team-issues'>
              {team.recentIssues.map(issue => (
                <li key={issue.id}>
                  <Link href={`/issues/${issue.id}`} className='team-issue'>
                    <span className={`status-dot ${issue.status}`} />
                    <span className='team-issue-title'>{issue.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  )
}

interface ActivityEntry {
  key: string
  ts: number
  node: ReactNode
}

function ActivityPanel() {
  const { data: comments } = useQuery(
    figbird.q.comments.orderBy('id', 'desc').limit(10).related('author'),
  )
  const { data: reactions } = useQuery(
    figbird.q.reactions.orderBy('id', 'desc').limit(6).related('user'),
  )
  const { data: issues, isFetching } = useQuery(
    figbird.q.issues.orderBy('updatedAt', 'desc').limit(6),
  )

  const entries = useMemo<ActivityEntry[]>(() => {
    const out: ActivityEntry[] = []
    for (const c of comments) {
      out.push({
        key: `c-${c.id}`,
        ts: c.id,
        node: (
          <>
            <div className='activity-line'>
              <strong>{c.author?.name ?? 'someone'}</strong> commented on{' '}
              <Link href={`/issues/${c.issueId}`} className='inline-link'>
                #{c.issueId}
              </Link>
            </div>
            <div className='activity-body'>{c.body}</div>
          </>
        ),
      })
    }
    for (const r of reactions) {
      out.push({
        key: `r-${r.id}`,
        ts: r.id,
        node: (
          <div className='activity-line'>
            <strong>{r.user?.name ?? 'someone'}</strong> reacted {r.emoji} on comment #{r.commentId}
          </div>
        ),
      })
    }
    for (const i of issues) {
      out.push({
        key: `i-${i.id}-${i.updatedAt}`,
        ts: Date.parse(i.updatedAt) || 0,
        node: (
          <>
            <div className='activity-line'>
              <Link href={`/issues/${i.id}`} className='inline-link'>
                #{i.id}
              </Link>{' '}
              <span className='dim'>updated</span>
            </div>
            <div className='activity-body'>{i.title}</div>
          </>
        ),
      })
    }
    out.sort((a, b) => b.ts - a.ts)
    return out.slice(0, 12)
  }, [comments, reactions, issues])

  return (
    <section className='aside-section'>
      <header className='section-head'>
        <span className='eyebrow'>Activity</span>
        <StatusDot active={isFetching} />
        <Explain label='Cross-service feed'>
          Three independent queries — comments, reactions, issues — merged by timestamp in the
          component. Each stays realtime on its own service; a teammate's comment lands here, in the
          list's comment count, and in the open issue simultaneously, from one socket event.
        </Explain>
      </header>
      <ul className='activity-list'>
        {entries.map(e => (
          <li key={e.key} className='activity-item'>
            {e.node}
          </li>
        ))}
      </ul>
    </section>
  )
}

function ConsolePanel() {
  const selectedId = useSelectedIssueId()
  const navigate = useNavigate()
  const issueMutation = useMutation('issues')

  const createIssue = async () => {
    const id = Date.now()
    const create = issueMutation.create(
      {
        id,
        title: `Drafted from the console (${String(id).slice(-4)})`,
        status: 'open',
        creatorId: 1,
        assigneeId: 1 + (id % 8),
        teamId: 1 + (id % 4),
        priorityScore: 50,
        updatedAt: new Date().toISOString(),
        commentIds: [],
      },
      { optimistic: true },
    )
    // The optimistic item is already in the cache — navigate immediately.
    navigate(`/issues/${id}`)
    await create
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
        <Explain label='Optimistic mutations'>
          Create and remove pass <code>{'{ optimistic: true }'}</code>: the cache updates before the
          server responds, every query showing the item updates in the same frame, and a failure
          rolls the whole thing back. Watch the mutate → realtime sequence in dev tools.
        </Explain>
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
        Tip: open this page in two windows side by side — every change here appears there, live.
      </p>
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
  const [view, setView] = useState<'log' | 'queries'>('log')
  const [paused, setPaused] = useState(false)
  const [filter, setFilter] = useState<'all' | 'fetch' | 'realtime' | 'mutate'>('all')
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [demoState, setDemoState] = useState<DemoState | null>(null)
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
        if (!cancelled) setDemoState(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const setLatency = async (latency: LatencyProfile) => {
    if (!demoState) return
    setDemoState({ ...demoState, latency }) // optimistic
    try {
      setDemoState(await demoControl.set({ latency }))
    } catch {
      setDemoState(demoState)
    }
  }

  const toggleTeammate = async () => {
    if (!demoState) return
    const next = { ...demoState, backgroundEnabled: !demoState.backgroundEnabled }
    setDemoState(next) // optimistic
    try {
      setDemoState(await demoControl.set({ backgroundEnabled: next.backgroundEnabled }))
    } catch {
      setDemoState(demoState)
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
                {(['all', 'fetch', 'realtime', 'mutate'] as const).map(f => (
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

  const rows: Array<{
    id: string
    service: string
    method: string
    cls: string
    status: string
    isFetching: boolean
    count: number
    query: string
  }> = []
  for (const [serviceName, serviceState] of figbird.getState()) {
    for (const q of serviceState.queries.values()) {
      const config = q.config as { server?: boolean; allPages?: boolean }
      const query = (q.desc.params as { query?: Record<string, unknown> } | undefined)?.query
      rows.push({
        id: q.queryId,
        service: serviceName,
        method: q.desc.method,
        cls: q.desc.method === 'get' ? 'get' : classifyQueryNode(query, config),
        status: q.state.status,
        isFetching: q.state.isFetching,
        count: Array.isArray(q.state.data) ? q.state.data.length : q.state.data ? 1 : 0,
        query: query && Object.keys(query).length > 0 ? JSON.stringify(query) : '',
      })
    }
  }

  return (
    <ol className='devtools-log queries'>
      {rows.map(row => (
        <li key={row.id} className='devtools-row'>
          <span className={`q-badge ${row.cls}`}>{row.cls}</span>
          <span className='devtools-text'>
            <strong>{row.service}</strong>
            {row.query ? <span className='q-query'> {row.query}</span> : null}
          </span>
          <span className='q-meta'>
            {row.count} item{row.count === 1 ? '' : 's'} · {row.status}
            {row.isFetching ? ' · fetching' : ''}
          </span>
        </li>
      ))}
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
          {Array.from({ length: 8 }, (_, i) => (
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
          <span className='eyebrow'>Teams</span>
        </header>
        <div className='skeleton-list compact'>
          {Array.from({ length: 4 }, (_, i) => (
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
  // Keyed Suspense boundary for issue detail: each id starts cold so the destination
  // shows its own skeleton instead of leaking the previous issue's data while the
  // new one loads.
  const issueId = path.startsWith('/issues/') ? (route?.params?.id ?? null) : null

  return (
    <>
      <nav className='nav'>
        <span className='brand'>figbird</span>
        <span className='tagline'>a realtime issue tracker — every panel is a live query</span>
        <span className='spacer' />
        <span className='nav-hint'>tip: open two windows side by side</span>
      </nav>
      <div className='grid grid-fade'>
        <IssueListPane />
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
          <TeamsPanel />
          <ConsolePanel />
          <ActivityPanel />
        </aside>
      </div>
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
        navigation: { commit: 'immediate' as const },
      },
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
