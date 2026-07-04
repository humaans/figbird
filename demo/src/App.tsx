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
import { createPortal } from 'react-dom'
import { Link, Router, Routes, useNavigate, useRoute } from 'react-space-router'
import { classifyQueryNode, useDelayedFlag, type FigbirdEvent } from 'figbird'
import {
  demoControl,
  figbird,
  socket,
  useMutation,
  useQuery,
  type DemoState,
  type Issue,
  type Label,
  type LatencyProfile,
  type Team,
  type User,
} from './figbird'
import { Explain } from './Explain'
import { prepareIssueDetail } from './pages/IssueDetail/prepare'
import { issueCommentsQuery, issueDetailQuery } from './pages/IssueDetail/queries'

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

// ----- Hover prefetch -----

// Prefetch an issue's detail + comments on hover intent — figbird.prepare() is an
// earlier read of the exact queries the detail screen will ask for, so by click
// time the navigation is usually a warm, synchronous read.
//
// Each issue is prepared AT MOST ONCE per session: after the first prefetch the
// data lives in the QueryStore, where realtime events keep merge-class queries
// fresh even with no subscribers, and an actual navigation performs one SWR
// revalidation. Re-preparing on every hover would resubscribe and re-trigger SWR
// — hammering the server with redundant revalidations as the mouse sweeps the
// list. A small LRU of release() handles bounds how many hover pins stay live;
// released entries keep their warm data in the QueryStore either way.
const HOVER_PIN_LIMIT = 12
const preparedIssues = new Set<number>()
const hoverPins = new Map<number, Array<{ release: () => void }>>()

function prefetchIssue(id: number): void {
  if (preparedIssues.has(id)) return
  preparedIssues.add(id)
  hoverPins.set(id, [
    figbird.prepare(issueDetailQuery, { id }),
    figbird.prepare(issueCommentsQuery, { id }, { priority: 'defer' }),
  ])
  if (hoverPins.size > HOVER_PIN_LIMIT) {
    const [oldest] = hoverPins.keys()
    for (const handle of hoverPins.get(oldest!) ?? []) handle.release()
    hoverPins.delete(oldest!)
  }
}

// Only prefetch after the pointer has rested on a row briefly — sweeping the
// mouse across the list shouldn't fire drive-by prepares for every row passed.
const HOVER_INTENT_MS = 100

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

  // The Explain snippet mirrors the chips you actually have active.
  const whereLines = [
    ...(status !== 'all' ? [`  status: '${status}',`] : []),
    ...(teamId != null
      ? [`  'assignee.teamId': ${teamId}, // ${teams.find(t => t.id === teamId)?.name}`]
      : []),
  ]
  const filterSnippet =
    whereLines.length > 0
      ? `q.issues.where({\n${whereLines.join('\n')}\n})`
      : `// no filters active — toggle some chips and\n// reopen this popover; it reflects live state\nq.issues.where({})`

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
          <Explain
            label='Server-authoritative search'
            query={`q.issues
  .where({ title: { $regex: term, $options: 'i' } })
  .orderBy('updatedAt', 'desc')
  .limit(30)
  .server()
  .related('assignee')
  .related('team')`}
          >
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
          <Explain label='Relational filter' query={filterSnippet}>
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
      .related('labels'),
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
        <Explain
          label='Paginated live list'
          query={`q.issues
  .where(filters)
  .orderBy('updatedAt', 'desc')
  .paginate({ pageSize: 25, returnTotal: true })
  .related('assignee')
  .related('team')
  .related('labels') // two-hop via issueLabels`}
        >
          The list is one <code>.paginate({'{ pageSize: 25 }'})</code> query — each page is its own
          window on the server. Windowed queries are <em>server-window</em> class: realtime events
          can change membership invisibly (a row you can't see may now belong), so figbird refetches
          the affected pages instead of guessing. Comment counts come from{' '}
          <code>issue.commentIds</code>, a server-maintained id list — no comments are fetched here
          at all. Hovering a row prefetches its detail via <code>figbird.prepare()</code>, so
          clicking is usually a warm read.
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
  labels?: Label[]
}

function IssueRow({ issue, highlight }: { issue: IssueRowData; highlight?: string }) {
  const selectedId = useSelectedIssueId()
  const commentCount = issue.commentIds?.length ?? 0
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const startPrefetch = () => {
    if (hoverTimer.current !== null) return
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null
      prefetchIssue(issue.id)
    }, HOVER_INTENT_MS)
  }
  const cancelPrefetch = () => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }

  return (
    <li>
      <Link
        href={`/issues/${issue.id}`}
        className={`issue-row ${issue.id === selectedId ? 'selected' : ''}`}
        onMouseEnter={startPrefetch}
        onMouseLeave={cancelPrefetch}
        // Keyboard focus is deliberate — prefetch immediately.
        onFocus={() => prefetchIssue(issue.id)}
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
            {issue.labels?.length ? (
              <>
                {' '}
                {issue.labels.map(label => (
                  <span key={label.id} className={`label mini ${label.tone}`}>
                    {label.name}
                  </span>
                ))}
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

// ----- Teams page -----

function TeamsPage() {
  const { data: teams, isFetching } = useQuery(
    figbird.q.teams
      .related('members')
      .related('spotlight')
      .related('recentIssues', issue => issue.orderBy('updatedAt', 'desc').limit(5)),
  )

  return (
    <main className='detail teams-page'>
      <header className='detail-head'>
        <div className='detail-meta-line'>
          <span className='eyebrow'>Teams</span>
          <StatusDot active={isFetching} />
          <Explain
            label='Two ways to "top N per team"'
            query={`q.teams
  .related('members')      // fan-in IN(...)
  .related('spotlight')    // embed: server-maintained
                           // spotlightIssueIds, ONE batched
                           // fetch for all teams
  .related('recentIssues', i =>          // window:
    i.orderBy('updatedAt', 'desc').limit(5))
                           // one query per team`}
          >
            The same card demos both strategies. <strong>Recent</strong> is a windowed relation —
            the client asks for each team's window, one query per team (fine at 4; past ~10 figbird
            warns). <strong>Spotlight</strong> is the <code>embed()</code> pattern: the server
            maintains <code>team.spotlightIssueIds</code> (top open issues by priority), re-emits
            the team whenever the list changes, and figbird resolves every team's spotlight in a
            single IN(...) fetch, preserving the server's order. Watch the teammate's priority
            nudges reshuffle spotlights live.
          </Explain>
        </div>
        <h1 className='detail-title'>Teams</h1>
        <div className='detail-meta'>
          Live rosters, server-curated spotlights, and each team's latest activity — the teammate
          simulator keeps these moving.
        </div>
      </header>
      <div className='team-grid'>
        {teams.map(team => (
          <section key={team.id} className='team-card'>
            <header className='team-name'>
              <span className='team-accent' style={{ background: team.accent }} />
              {team.name}
              <span className='count'>{team.members.length} members</span>
            </header>
            <div className='team-members'>
              {team.members.map(member => (
                <span key={member.id} className='member'>
                  <span className='member-avatar'>{member.avatar}</span>
                  {member.name}
                </span>
              ))}
            </div>
            <div className='team-sub'>
              Spotlight <span className='team-sub-hint'>server-curated · by priority</span>
            </div>
            <ul className='team-issues'>
              {team.spotlight.map(issue => (
                <li key={issue.id}>
                  <Link href={`/issues/${issue.id}`} className='team-issue'>
                    <span className={`status-dot ${issue.status}`} />
                    <span className='team-issue-title'>{issue.title}</span>
                    <span className='dim team-issue-id'>{issue.priorityScore}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <div className='team-sub'>Recent</div>
            <ul className='team-issues'>
              {team.recentIssues.map(issue => (
                <li key={issue.id}>
                  <Link href={`/issues/${issue.id}`} className='team-issue'>
                    <span className={`status-dot ${issue.status}`} />
                    <span className='team-issue-title'>{issue.title}</span>
                    <span className='dim team-issue-id'>#{issue.id}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  )
}

// ----- Right sidebar -----

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
        <Explain
          label='Cross-service feed'
          query={`q.comments.orderBy('id', 'desc').limit(10)
  .related('author')
q.reactions.orderBy('id', 'desc').limit(6)
  .related('user')
q.issues.orderBy('updatedAt', 'desc').limit(6)`}
        >
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

// ----- New issue modal (Linear-style compact) -----

function NewIssueModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className='modal-backdrop' onClick={onClose}>
      <div className='modal' onClick={e => e.stopPropagation()}>
        <Suspense fallback={<div className='modal-loading'>Loading…</div>}>
          <NewIssueForm onClose={onClose} />
        </Suspense>
      </div>
    </div>,
    document.body,
  )
}

function NewIssueForm({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const { data: teams } = useQuery(figbird.q.teams)
  const { data: users } = useQuery(figbird.q.users)
  const issueMutation = useMutation('issues')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [teamId, setTeamId] = useState(teams[0]?.id ?? 1)
  const [assigneeId, setAssigneeId] = useState(users[0]?.id ?? 1)

  const submit = async () => {
    const trimmed = title.trim()
    if (trimmed.length === 0) return
    const id = Date.now()
    const create = issueMutation.create(
      {
        id,
        title: trimmed,
        description: description.trim(),
        status: 'open',
        creatorId: 1,
        assigneeId,
        teamId,
        priorityScore: 50,
        updatedAt: new Date().toISOString(),
        commentIds: [],
      },
      { optimistic: true },
    )
    // The optimistic item is already in the cache — close and navigate immediately.
    onClose()
    navigate(`/issues/${id}`)
    await create
  }

  return (
    <form
      className='modal-form'
      onSubmit={e => {
        e.preventDefault()
        void submit()
      }}
    >
      <header className='modal-head'>
        <span className='eyebrow'>New issue</span>
        <Explain
          label='Optimistic create'
          query={`useMutation('issues').create(
  { id: Date.now(), title, description, … },
  { optimistic: true },
)`}
        >
          Create passes <code>{'{ optimistic: true }'}</code> with a client-generated id: the issue
          is in the cache — list, activity, detail — before the server responds, and a failure rolls
          it back everywhere at once. Try "Fail next mutation" in dev tools to watch the rollback.
        </Explain>
        <span className='spacer' />
        <button type='button' className='link' onClick={onClose}>
          Close
        </button>
      </header>
      <input
        autoFocus
        className='modal-title-input'
        placeholder='Issue title'
        value={title}
        onChange={e => setTitle(e.target.value)}
      />
      <textarea
        className='modal-desc-input'
        rows={4}
        placeholder='Add a description…'
        value={description}
        onChange={e => setDescription(e.target.value)}
      />
      <div className='modal-row'>
        <select
          className='modal-select'
          value={teamId}
          onChange={e => setTeamId(Number(e.target.value))}
        >
          {teams.map(team => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
        <select
          className='modal-select'
          value={assigneeId}
          onChange={e => setAssigneeId(Number(e.target.value))}
        >
          {users.map(user => (
            <option key={user.id} value={user.id}>
              {user.avatar} {user.name}
            </option>
          ))}
        </select>
        <span className='spacer' />
        <button type='submit' className='btn-primary' disabled={title.trim().length === 0}>
          Create issue
        </button>
      </div>
    </form>
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

  const armChaos = async () => {
    if (!demoState) return
    const next = !demoState.chaosArmed
    setDemoState({ ...demoState, chaosArmed: next }) // optimistic
    try {
      setDemoState(await demoControl.set({ chaosArmed: next }))
    } catch {
      setDemoState(demoState)
    }
  }

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

function Workspace({ children }: { children?: ReactNode }) {
  const route = useRoute()
  const path = route?.pathname ?? '/'
  const isFull = path.startsWith('/teams')
  // Keyed Suspense boundary for issue detail: each id starts cold so the destination
  // shows its own skeleton instead of leaking the previous issue's data while the
  // new one loads.
  const issueId = path.startsWith('/issues/') ? (route?.params?.id ?? null) : null
  const [showNewIssue, setShowNewIssue] = useState(false)

  return (
    <>
      <nav className='nav'>
        <span className='brand'>figbird</span>
        <NavTab href='/' label='Issues' />
        <NavTab href='/teams' label='Teams' />
        <button className='link new-issue-btn' onClick={() => setShowNewIssue(true)}>
          + New issue
        </button>
        <span className='spacer' />
        <span className='nav-hint'>tip: open two windows side by side</span>
      </nav>
      {isFull ? (
        <div className='full grid-fade'>{children}</div>
      ) : (
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
            <ActivityPanel />
          </aside>
        </div>
      )}
      {showNewIssue ? <NewIssueModal onClose={() => setShowNewIssue(false)} /> : null}
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
      { path: '/teams', component: TeamsPage },
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
