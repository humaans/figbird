import { Explain } from '../../components/Explain'
import { StatusDot } from '../../components/ui'
import type { ArchivedIssue, Label, Team, User } from '../../figbird'

export type ArchiveSort = 'deleted-desc' | 'deleted-asc' | 'title-asc'

type ArchiveRow = ArchivedIssue & {
  assignee: User | null
  team: Team | null
  labels: Label[]
}

interface ArchiveToolbarProps {
  searchInput: string
  onSearchInputChange: (value: string) => void
  sort: ArchiveSort
  onSortChange: (value: ArchiveSort) => void
  cachedRows: number
  mountedRows: number
  visibleStart: number
  visibleEnd: number
  total: number | undefined
  isFetching: boolean
  onJumpToTop: () => void
}

export function ArchiveToolbar({
  searchInput,
  onSearchInputChange,
  sort,
  onSortChange,
  cachedRows,
  mountedRows,
  visibleStart,
  visibleEnd,
  total,
  isFetching,
  onJumpToTop,
}: ArchiveToolbarProps) {
  return (
    <div className='archive-toolbar'>
      <input
        value={searchInput}
        onChange={event => onSearchInputChange(event.target.value)}
        className='search-input compact archive-search'
        placeholder='Search archive…'
        aria-label='Search archived issues'
      />
      <select
        className='archive-sort'
        value={sort}
        onChange={event => onSortChange(event.target.value as ArchiveSort)}
        aria-label='Sort archived issues'
      >
        <option value='deleted-desc'>Recently deleted</option>
        <option value='deleted-asc'>Oldest deleted</option>
        <option value='title-asc'>Title A–Z</option>
      </select>
      <div className='archive-stat'>
        <span className='archive-stat-value'>{cachedRows.toLocaleString()}</span>
        <span>cached</span>
      </div>
      <div className='archive-stat'>
        <span className='archive-stat-value'>{mountedRows}</span>
        <span>mounted</span>
      </div>
      <div className='archive-stat archive-stat-wide'>
        <span className='archive-stat-value'>
          {visibleStart + 1}–{Math.min(visibleEnd + 1, total ?? Infinity)}
        </span>
        <span>of {total?.toLocaleString() ?? 'unknown'}</span>
      </div>
      <StatusDot active={isFetching} />
      <span className='archive-prefetch-state'>
        {isFetching ? 'fetching window…' : 'adjacent pages ready'}
      </span>
      <button className='link archive-top-button' onClick={onJumpToTop}>
        ↑ Top
      </button>
      <Explain
        label='Windowed relational query'
        query={`useWindowQuery(
  q.archivedIssues
    .where(search)
    .orderBy(sortField, direction)
    .related('assignee')
    .related('team')
    .related('labels'),
  {
    range: { start, end },
    pageSize: 40,
    preloadPages: 1,
    maxPages: 5,
  },
)`}
      >
        TanStack Virtual reports the visible indexes. Figbird fetches those server blocks plus one
        page on either side, assembles all three relations, and evicts distant blocks. Search and
        sorting create a new server-authoritative list identity; a deep reload starts at the saved
        window rather than rebuilding the prefix.
      </Explain>
    </div>
  )
}

export function ArchiveWindowPlaceholder() {
  return (
    <div className='archive-loader' aria-label='Loading row'>
      <span className='spinner archive-spinner' /> Fetching this window…
    </div>
  )
}

const DATE_FORMATTER = new Intl.DateTimeFormat('en', { dateStyle: 'medium' })

export function ArchiveLedgerRow({ row, index }: { row: ArchiveRow; index: number }) {
  return (
    <article className='archive-row' role='listitem'>
      <div className='archive-row-number'>{String(index + 1).padStart(4, '0')}</div>
      <div className='archive-row-main'>
        <div className='archive-row-title'>{row.title}</div>
        <div className='archive-row-reason'>
          {row.deletionReason} · {row.team?.name ?? 'No team'}
        </div>
      </div>
      <div className='archive-assignee'>
        <span className='archive-avatar'>{row.assignee?.avatar ?? '–'}</span>
        <span>{row.assignee?.name ?? 'Unassigned'}</span>
      </div>
      <div className='archive-labels'>
        {row.labels.map(label => (
          <span key={label.id} className={`label mini ${label.tone}`}>
            {label.name}
          </span>
        ))}
      </div>
      <time className='archive-date' dateTime={row.deletedAt}>
        {DATE_FORMATTER.format(new Date(row.deletedAt))}
      </time>
    </article>
  )
}

export function ArchiveSkeleton() {
  return (
    <section className='archive-ledger archive-skeleton' aria-label='Loading archive window'>
      <div className='archive-toolbar'>Opening the requested archive window…</div>
      {Array.from({ length: 9 }, (_, index) => (
        <div key={index} className='archive-skeleton-row' />
      ))}
    </section>
  )
}
