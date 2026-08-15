/**
 * A deep, relational archive driven by Figbird's viewport query and rendered with
 * TanStack Virtual. Query windows and DOM windows stay independent and bounded.
 */

import { Suspense, startTransition, useRef, useState } from 'react'
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import { useDebouncedTransition } from 'figbird'
import { q, useWindowQuery } from '../../figbird'
import {
  ArchiveLedgerRow,
  ArchiveSkeleton,
  ArchiveToolbar,
  ArchiveWindowPlaceholder,
  type ArchiveSort,
} from './components'

const PAGE_SIZE = 40
const ROW_HEIGHT = 72
const RESTORE_KEY = 'figbird-demo:archive-scroll'
const INITIAL_WINDOW_SIZE = 18
const DEFAULT_SORT: ArchiveSort = 'deleted-desc'

interface SavedPosition {
  offset: number
  index: number
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
  const [searchInput, setSearchInput] = useState('')
  const search = useDebouncedTransition(searchInput.trim(), 250)
  const [sort, setSort] = useState<ArchiveSort>(DEFAULT_SORT)

  const changeSearch = (value: string) => {
    clearSavedPosition()
    setSearchInput(value)
  }

  const changeSort = (value: ArchiveSort) => {
    clearSavedPosition()
    startTransition(() => setSort(value))
  }

  return (
    <ArchiveWindow
      key={`${sort}:${search}`}
      search={search}
      searchInput={searchInput}
      onSearchInputChange={changeSearch}
      sort={sort}
      onSortChange={changeSort}
    />
  )
}

interface ArchiveWindowProps {
  search: string
  searchInput: string
  onSearchInputChange: (value: string) => void
  sort: ArchiveSort
  onSortChange: (value: ArchiveSort) => void
}

function ArchiveWindow({
  search,
  searchInput,
  onSearchInputChange,
  sort,
  onSortChange,
}: ArchiveWindowProps) {
  const [initialPosition] = useState(readSavedPosition)
  const [range, setRange] = useState(() => {
    const start = initialPosition?.index ?? 0
    return { start, end: start + INITIAL_WINDOW_SIZE }
  })
  const archiveQuery = buildArchiveQuery(search, sort)

  const {
    data: rows,
    total,
    isFetching,
    error,
  } = useWindowQuery(archiveQuery, {
    range,
    pageSize: PAGE_SIZE,
    preloadPages: 1,
    maxPages: 5,
  })
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const virtualizer = useVirtualizer({
    count: total ?? Math.max(1, range.end),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 5,
    initialOffset: initialPosition?.offset ?? 0,
    getItemKey: index => index,
    onChange: instance => {
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

  const virtualRows = virtualizer.getVirtualItems()
  const mountedRows = virtualRows.filter(item => rows.has(item.index)).length
  const visibleStart = virtualRows[0]?.index ?? range.start
  const visibleEnd = virtualRows.at(-1)?.index ?? Math.max(0, range.end - 1)

  const jumpToTop = () => {
    clearSavedPosition()
    virtualizer.scrollToOffset(0)
  }

  return (
    <section className='archive-ledger'>
      <ArchiveToolbar
        searchInput={searchInput}
        onSearchInputChange={onSearchInputChange}
        sort={sort}
        onSortChange={onSortChange}
        cachedRows={rows.size}
        mountedRows={mountedRows}
        visibleStart={visibleStart}
        visibleEnd={visibleEnd}
        total={total}
        isFetching={isFetching}
        onJumpToTop={jumpToTop}
      />

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
            const row = rows.get(virtualRow.index)
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

function buildArchiveQuery(search: string, sort: ArchiveSort) {
  let query = q.archivedIssues.where(search === '' ? {} : { $search: search })
  query =
    sort === 'title-asc'
      ? query.orderBy('title', 'asc').orderBy('id', 'asc')
      : sort === 'deleted-asc'
        ? query.orderBy('deletedAt', 'asc').orderBy('id', 'asc')
        : query.orderBy('deletedAt', 'desc').orderBy('id', 'desc')
  return query.related('assignee').related('team').related('labels')
}

function clearSavedPosition() {
  sessionStorage.removeItem(RESTORE_KEY)
}

function persistPosition(virtualizer: Virtualizer<HTMLDivElement, Element>) {
  const offset = virtualizer.scrollOffset ?? 0
  const value: SavedPosition = {
    offset,
    index: Math.max(0, Math.floor(offset / ROW_HEIGHT)),
  }
  sessionStorage.setItem(RESTORE_KEY, JSON.stringify(value))
}
