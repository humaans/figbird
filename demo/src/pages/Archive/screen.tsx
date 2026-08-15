/**
 * A deep, relational archive driven by Figbird's viewport query and rendered with
 * TanStack Virtual. Query windows and DOM windows stay independent and bounded.
 */

import { Suspense, useEffect, useRef, useState } from 'react'
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import { useDebouncedTransition } from 'figbird'
import { Explain } from '../../components/Explain'
import { StatusDot } from '../../components/ui'
import {
  q,
  useWindowQuery,
  type ArchivedIssue,
  type Label,
  type Team,
  type User,
} from '../../figbird'

const PAGE_SIZE = 40
const ROW_HEIGHT = 72
const RESTORE_KEY = 'figbird-demo:archive-scroll'
const INITIAL_WINDOW_SIZE = 18

interface SavedPosition {
  offset: number
  index: number
}

type ArchiveSort = 'deleted-desc' | 'deleted-asc' | 'title-asc'

type ArchiveRow = ArchivedIssue & {
  assignee: User | null
  team: Team | null
  labels: Label[]
}

function readSavedPosition(): SavedPosition | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(RESTORE_KEY) ?? 'null')
    if (
      value != null &&
      typeof value === 'object' &&
      'offset' in value &&
      'index' in value &&
      typeof value.offset === 'number' &&
      typeof value.index === 'number'
    ) {
      return { offset: value.offset, index: value.index }
    }
  } catch {
    // A malformed browser value should never keep the demo from rendering.
  }
  return null
}

export function ArchivePage() {
  return (
    <main className='detail archive-page'>
      <header className='archive-head'>
        <div>
          <div className='archive-kicker'>Cold storage / 5,000 records</div>
          <h1 className='archive-title'>The long tail</h1>
          <p className='archive-deck'>
            A bounded relational data window follows the virtualized viewport in either direction.
          </p>
        </div>
        <div className='archive-head-note'>
          Grab the scrollbar or reload deep in the list. Only that window is fetched.
        </div>
      </header>
      <Suspense fallback={<ArchiveSkeleton />}>
        <VirtualArchive />
      </Suspense>
    </main>
  )
}

function VirtualArchive() {
  const savedPosition = useRef(readSavedPosition())
  const initialIndex = savedPosition.current?.index ?? 0
  const [range, setRange] = useState({
    start: initialIndex,
    end: initialIndex + INITIAL_WINDOW_SIZE,
  })
  const [searchInput, setSearchInput] = useState('')
  const search = useDebouncedTransition(searchInput.trim(), 250)
  const [sort, setSort] = useState<ArchiveSort>('deleted-desc')
  const queryIdentity = `${search}\u0000${sort}`
  const committedIdentity = useRef(queryIdentity)
  const queryChanged = committedIdentity.current !== queryIdentity
  const requestedRange = queryChanged ? { start: 0, end: INITIAL_WINDOW_SIZE } : range

  let archiveQuery = q.archivedIssues.where(search === '' ? {} : { $search: search })
  archiveQuery =
    sort === 'title-asc'
      ? archiveQuery.orderBy('title', 'asc').orderBy('id', 'asc')
      : sort === 'deleted-asc'
        ? archiveQuery.orderBy('deletedAt', 'asc').orderBy('id', 'asc')
        : archiveQuery.orderBy('deletedAt', 'desc').orderBy('id', 'desc')

  const {
    data: rows,
    total,
    isFetching,
    error,
  } = useWindowQuery(archiveQuery.related('assignee').related('team').related('labels'), {
    range: requestedRange,
    pageSize: PAGE_SIZE,
    preloadPages: 1,
    maxPages: 5,
  })
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const virtualizer = useVirtualizer({
    count: total ?? Math.max(1, requestedRange.end),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 5,
    initialOffset: savedPosition.current?.offset ?? 0,
    getItemKey: index => index,
    onChange: instance => {
      if (committedIdentity.current !== queryIdentity) return
      persistPosition(instance)
      const items = instance.getVirtualItems()
      const first = items[0]?.index
      const last = items.at(-1)?.index
      if (first === undefined || last === undefined) return
      setRange(current =>
        current.start === first && current.end === last + 1
          ? current
          : { start: first, end: last + 1 },
      )
    },
  })

  useEffect(() => {
    if (!queryChanged) return
    committedIdentity.current = queryIdentity
    savedPosition.current = null
    sessionStorage.removeItem(RESTORE_KEY)
    setRange({ start: 0, end: INITIAL_WINDOW_SIZE })
    virtualizer.scrollToOffset(0)
  }, [queryChanged, queryIdentity, virtualizer])

  const virtualRows = virtualizer.getVirtualItems()
  const mountedRows = virtualRows.filter(item => rows.has(item.index)).length
  const visibleStart = virtualRows[0]?.index ?? requestedRange.start
  const visibleEnd = virtualRows.at(-1)?.index ?? Math.max(0, requestedRange.end - 1)

  const jumpToTop = () => {
    sessionStorage.removeItem(RESTORE_KEY)
    virtualizer.scrollToOffset(0)
  }

  return (
    <section className='archive-ledger'>
      <div className='archive-toolbar'>
        <input
          value={searchInput}
          onChange={event => setSearchInput(event.target.value)}
          className='search-input compact archive-search'
          placeholder='Search archive…'
          aria-label='Search archived issues'
        />
        <select
          className='archive-sort'
          value={sort}
          onChange={event => setSort(event.target.value as ArchiveSort)}
          aria-label='Sort archived issues'
        >
          <option value='deleted-desc'>Recently deleted</option>
          <option value='deleted-asc'>Oldest deleted</option>
          <option value='title-asc'>Title A–Z</option>
        </select>
        <div className='archive-stat'>
          <span className='archive-stat-value'>{rows.size.toLocaleString()}</span>
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
        <button className='link archive-top-button' onClick={jumpToTop}>
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

      <div className='archive-columns' aria-hidden>
        <span>No.</span>
        <span>Archived issue</span>
        <span>Assignee</span>
        <span>Labels</span>
        <span>Deleted</span>
      </div>

      <div ref={scrollRef} className='archive-scroll' role='list' aria-label='Archived issues'>
        <div className='archive-virtual-space' style={{ height: virtualizer.getTotalSize() }}>
          {virtualRows.map(virtualRow => {
            const row = rows.get(virtualRow.index) as ArchiveRow | undefined
            return (
              <div
                key={virtualRow.key}
                className='archive-virtual-row'
                style={{
                  height: virtualRow.size,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {row ? (
                  <ArchiveLedgerRow row={row} index={virtualRow.index} />
                ) : (
                  <ArchiveWindowPlaceholder />
                )}
              </div>
            )
          })}
        </div>
      </div>

      {error ? (
        <div className='archive-error'>
          This window failed to refresh. Scroll away and back to retry.
        </div>
      ) : null}
    </section>
  )
}

function persistPosition(virtualizer: Virtualizer<HTMLDivElement, Element>) {
  const offset = virtualizer.scrollOffset ?? 0
  const value: SavedPosition = {
    offset,
    index: Math.max(0, Math.floor(offset / ROW_HEIGHT)),
  }
  sessionStorage.setItem(RESTORE_KEY, JSON.stringify(value))
}

function ArchiveWindowPlaceholder() {
  return (
    <div className='archive-loader' aria-label='Loading row'>
      <span className='spinner archive-spinner' /> Fetching this window…
    </div>
  )
}

function ArchiveLedgerRow({ row, index }: { row: ArchiveRow; index: number }) {
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
        {new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(row.deletedAt))}
      </time>
    </article>
  )
}

function ArchiveSkeleton() {
  return (
    <section className='archive-ledger archive-skeleton' aria-label='Loading archive window'>
      <div className='archive-toolbar'>Opening the requested archive window…</div>
      {Array.from({ length: 9 }, (_, index) => (
        <div key={index} className='archive-skeleton-row' />
      ))}
    </section>
  )
}
