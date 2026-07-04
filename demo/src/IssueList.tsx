/**
 * Left pane of the issues workspace: search, filter chips, and the infinite
 * paginated issue list, including the hover-prefetch machinery for issue rows.
 */

import { Suspense, useRef, useState, useTransition } from 'react'
import { Link, useRoute } from 'react-space-router'
import { useDebouncedTransition } from 'figbird'
import { figbird, q, useQuery, type Issue, type Label, type Team, type User } from './figbird'
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

// ----- Hover prefetch -----

// Warm an issue's detail + comments on hover intent — the exact queries the detail
// screen will read, so by click time the navigation is usually a warm, synchronous
// read. figbird.prefetch() is idempotent (fresh queries no-op) and manages its own
// pin lifetime, so calling it on every hover costs nothing.
function prefetchIssue(id: number): void {
  figbird.prefetch(issueDetailQuery, { id })
  figbird.prefetch(issueCommentsQuery, { id })
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

  const { data: teams } = useQuery(q.teams)

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
  .related('assignee')
  .related('team')`}
          >
            The search query carries <code>$regex</code>, an operator figbird's local matcher can't
            evaluate — figbird classifies the query <em>server-authoritative</em> automatically (no{' '}
            <code>.server()</code> needed): realtime events trigger a refetch instead of a local
            merge. Typing commits through <code>startTransition</code>, so the previous results stay
            visible while the next term loads.
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
            <SearchResults term={search} typing={search !== searchInput.trim()} />
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
    q.issues
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
          at all. Hovering a row warms its detail via <code>figbird.prefetch()</code> — idempotent
          and self-releasing, so hover-spam costs nothing — and clicking is usually a warm read.
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

function SearchResults({ term, typing }: { term: string; typing: boolean }) {
  const escaped = escapeRegExp(term)
  // No `.server()` needed: `$regex` is an operator figbird's local matcher can't
  // evaluate, so the query classifies server-authoritative automatically.
  const { data: issues, isFetching } = useQuery(
    q.issues
      .where({ title: { $regex: escaped, $options: 'i' } })
      .orderBy('updatedAt', 'desc')
      .limit(30)
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
            <IssueRow key={issue.id} issue={issue} highlight={term} />
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
