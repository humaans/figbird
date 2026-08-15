/**
 * A deliberately deep archive combining Figbird's relational pagination with
 * TanStack Virtual. The query owns server/cache concerns; the virtualizer owns
 * which of the loaded rows are mounted in the DOM.
 */

import { Suspense, useEffect, useRef, useState } from 'react'
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import { Explain } from '../../components/Explain'
import { StatusDot } from '../../components/ui'
import { q, useQuery, type ArchivedIssue, type Label, type Team, type User } from '../../figbird'

const PAGE_SIZE = 40
const ROW_HEIGHT = 72
const RESTORE_KEY = 'figbird-demo:archive-scroll'

interface SavedPosition {
  offset: number
  index: number
}

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
            Relational pages arrive just ahead of the viewport. Only the visible ledger rows exist
            in the DOM.
          </p>
        </div>
        <div className='archive-head-note'>
          Scroll deep, then reload. Your exact place is restored.
        </div>
      </header>
      <Suspense fallback={<ArchiveSkeleton />}>
        <VirtualArchive />
      </Suspense>
    </main>
  )
}

function VirtualArchive() {
  const {
    data: rows,
    total,
    hasMore,
    loadMore,
    isLoadingMore,
    isFetching,
    loadMoreError,
  } = useQuery(
    q.archivedIssues
      .orderBy('deletedAt', 'desc')
      .paginate({ pageSize: PAGE_SIZE, includeTotal: true })
      .related('assignee')
      .related('team')
      .related('labels'),
  )
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const savedPosition = useRef(readSavedPosition())
  const restored = useRef(savedPosition.current === null)
  const [restoreComplete, setRestoreComplete] = useState(restored.current)

  const virtualizer = useVirtualizer({
    count: hasMore ? rows.length + 1 : rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 5,
    getItemKey: index => rows[index]?.id ?? 'archive-loader',
    onChange: instance => persistPosition(instance, restored.current),
  })
  const virtualRows = virtualizer.getVirtualItems()
  const lastVirtualIndex = virtualRows.at(-1)?.index

  // There is no public "page 2 query" to prefetch: pagination cursors belong to
  // the query ref. Calling loadMore one viewport early is the appropriate prefetch
  // primitive, and the ref deduplicates overlapping calls.
  useEffect(() => {
    if (
      restoreComplete &&
      lastVirtualIndex != null &&
      lastVirtualIndex >= rows.length - 12 &&
      hasMore &&
      !isLoadingMore
    ) {
      loadMore()
    }
  }, [hasMore, isLoadingMore, lastVirtualIndex, loadMore, restoreComplete, rows.length])

  // Reload recovery first rebuilds the paginated prefix needed to reach the saved
  // row, then asks the virtualizer to land on the exact pixel offset. This works
  // without persisting Figbird's cache or teaching the server about UI state.
  useEffect(() => {
    if (restoreComplete) return
    const target = savedPosition.current
    if (target === null) {
      restored.current = true
      setRestoreComplete(true)
      return
    }
    if (rows.length <= target.index && hasMore) {
      if (!isLoadingMore) loadMore()
      return
    }

    const frame = requestAnimationFrame(() => {
      virtualizer.scrollToOffset(target.offset, { align: 'start' })
      restored.current = true
      setRestoreComplete(true)
    })
    return () => cancelAnimationFrame(frame)
  }, [hasMore, isLoadingMore, loadMore, restoreComplete, rows.length, virtualizer])

  const mountedRows = virtualRows.filter(item => item.index < rows.length).length
  const visibleStart = virtualRows.find(item => item.index < rows.length)?.index ?? 0
  const visibleEnd =
    virtualRows
      .slice()
      .reverse()
      .find(item => item.index < rows.length)?.index ?? Math.max(0, rows.length - 1)

  const jumpToTop = () => {
    sessionStorage.removeItem(RESTORE_KEY)
    virtualizer.scrollToOffset(0)
  }

  return (
    <section className='archive-ledger'>
      <div className='archive-toolbar'>
        <div className='archive-stat'>
          <span className='archive-stat-value'>{rows.length.toLocaleString()}</span>
          <span>loaded</span>
        </div>
        <div className='archive-stat'>
          <span className='archive-stat-value'>{mountedRows}</span>
          <span>mounted</span>
        </div>
        <div className='archive-stat archive-stat-wide'>
          <span className='archive-stat-value'>
            {visibleStart + 1}–{visibleEnd + 1}
          </span>
          <span>render window</span>
        </div>
        <StatusDot active={isFetching || isLoadingMore} />
        <span className='archive-prefetch-state'>
          {isLoadingMore
            ? 'preloading next page…'
            : hasMore
              ? 'next page armed'
              : 'archive complete'}
        </span>
        <button className='link archive-top-button' onClick={jumpToTop}>
          ↑ Top
        </button>
        <Explain
          label='Virtualized relational pagination'
          query={`q.archivedIssues
  .orderBy('deletedAt', 'desc')
  .paginate({ pageSize: 40, includeTotal: true })
  .related('assignee')     // one
  .related('team')         // one
  .related('labels')       // many, two-hop junction

// TanStack Virtual mounts visible rows only.
// loadMore() runs one viewport before the edge.`}
        >
          Figbird fetches and assembles each page, including an assignee, team, and the two-hop
          label list for every row. TanStack Virtual independently limits DOM work. Near the end of
          the loaded window, <code>loadMore()</code> warms the next page before it is visible.
          Scroll position is stored as a row plus pixel offset; reload reconstructs only the prefix
          needed to reach it.
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
            const row = rows[virtualRow.index]
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
                  <div className='archive-loader'>
                    <span className='spinner archive-spinner' /> Fetching the next {PAGE_SIZE}…
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {!restoreComplete && savedPosition.current ? (
        <div className='archive-restore'>
          Restoring row{' '}
          {Math.min(savedPosition.current.index + 1, total ?? Infinity).toLocaleString()}…{' '}
          {rows.length.toLocaleString()} loaded
        </div>
      ) : null}
      {loadMoreError ? (
        <div className='archive-error'>Next page failed. Scroll again to retry.</div>
      ) : null}
    </section>
  )
}

function persistPosition(virtualizer: Virtualizer<HTMLDivElement, Element>, canPersist: boolean) {
  if (!canPersist) return
  const offset = virtualizer.scrollOffset ?? 0
  const value: SavedPosition = {
    offset,
    index: Math.max(0, Math.floor(offset / ROW_HEIGHT)),
  }
  sessionStorage.setItem(RESTORE_KEY, JSON.stringify(value))
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
    <section className='archive-ledger archive-skeleton' aria-label='Loading archive'>
      <div className='archive-toolbar'>Opening the archive…</div>
      {Array.from({ length: 9 }, (_, index) => (
        <div key={index} className='archive-skeleton-row' />
      ))}
    </section>
  )
}
