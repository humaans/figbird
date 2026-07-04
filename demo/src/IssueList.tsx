/**
 * Left pane of the issues workspace: search, filter chips, and the infinite
 * paginated issue list, including the hover-prefetch machinery for issue rows.
 */

import { Suspense, startTransition, useEffect, useRef, useState, useTransition } from 'react'
import { Link, useRoute } from 'react-space-router'
import { figbird, useQuery, type Issue, type Label, type Team, type User } from './figbird'
import { Explain } from './Explain'
import { issueCommentsQuery, issueDetailQuery } from './pages/IssueDetail/queries'
import { StatusDot, SkeletonRows, escapeRegExp } from './ui'

function useSelectedIssueId(): number | null {
  const route = useRoute()
  const idStr = route?.params?.id
  if (idStr == null) return null
  const n = Number(idStr)
  return Number.isFinite(n) ? n : null
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

export function IssueListPane() {
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
  const escaped = escapeRegExp(q)
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
  const parts = text.split(new RegExp(`(${escapeRegExp(q)})`, 'gi'))
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
      <SkeletonRows count={8} />
    </>
  )
}
