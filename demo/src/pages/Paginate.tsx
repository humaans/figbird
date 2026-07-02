import { Suspense, useState } from 'react'
import { Link } from 'react-space-router'
import { figbird, useQuery } from '../figbird'

const pageSizeOptions = [5, 10, 20] as const

interface PaginateScreenProps {
  pageSize: number
  returnTotal: boolean
}

function PaginatedIssues({ pageSize, returnTotal }: PaginateScreenProps) {
  const {
    data: issues,
    isFetching,
    refetch,
    loadMore,
    hasMore,
    isLoadingMore,
    loadMoreError,
    totalCount,
  } = useQuery(
    figbird.q.issues
      .orderBy('priorityScore', 'desc')
      .orderBy('id', 'asc')
      .paginate({ pageSize, returnTotal })
      .related('assignee')
      .related('team'),
  )

  return (
    <>
      <div className='detail-meta-line'>
        <span className='dim'>
          Loaded {issues.length}
          {totalCount != null ? ` of ${totalCount}` : ''} · pageSize {pageSize}
          {returnTotal ? ' · returnTotal on' : ''}
        </span>
        {isFetching ? <span className='dim'>· refreshing…</span> : null}
        <span className='spacer' />
        <button className='link' onClick={refetch} disabled={isFetching || isLoadingMore}>
          Refetch
        </button>
      </div>

      {issues.length === 0 ? (
        <p className='empty-line'>No issues.</p>
      ) : (
        <ul className='issue-rows'>
          {issues.map(issue => (
            <li key={issue.id}>
              <Link href={`/issues/${issue.id}`} className='issue-row'>
                <span className={`status-dot ${issue.status}`} />
                <span className='issue-row-main'>
                  <span className='issue-row-title'>{issue.title}</span>
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

      <div className='detail-meta-line'>
        {loadMoreError ? (
          <span className='dim' style={{ color: 'var(--danger, #d33)' }}>
            Load more failed: {loadMoreError.message}
          </span>
        ) : null}
        <span className='spacer' />
        {hasMore ? (
          <button className='link' onClick={loadMore} disabled={isLoadingMore}>
            {isLoadingMore ? 'Loading…' : 'Load more'}
          </button>
        ) : (
          <span className='dim'>End of list.</span>
        )}
      </div>
    </>
  )
}

export function PaginatePanel() {
  const [pageSize, setPageSize] = useState<number>(10)
  const [returnTotal, setReturnTotal] = useState(true)
  // Bump nonce to force a fresh Suspense boundary for the new builder hash, so changing
  // pageSize visibly re-suspends instead of silently reusing a stale wrapped query.
  const suspenseKey = `${pageSize}-${returnTotal}`

  return (
    <main className='detail'>
      <header className='detail-head'>
        <h1 className='detail-title'>Paginated issues</h1>
        <div className='detail-meta'>
          The query <code>figbird.q.issues.orderBy(...).paginate(...)</code> returns just the first
          page. <code>loadMore()</code> appends the next page; relations attach to every page;
          realtime events refetch the affected page in place. <code>returnTotal: true</code> reads
          the adapter's <code>total</code> so a "Loaded X of Y" indicator stays live.
        </div>
      </header>

      <div className='detail-meta-line'>
        <span className='eyebrow'>Page size</span>
        {pageSizeOptions.map(opt => (
          <button
            key={opt}
            className={`link ${pageSize === opt ? 'selected' : ''}`}
            onClick={() => setPageSize(opt)}
          >
            {opt}
          </button>
        ))}
        <span className='sep' aria-hidden>
          ·
        </span>
        <button
          className={`link ${returnTotal ? 'selected' : ''}`}
          onClick={() => setReturnTotal(t => !t)}
        >
          returnTotal: {returnTotal ? 'on' : 'off'}
        </button>
      </div>

      <Suspense key={suspenseKey} fallback={<p className='empty-line'>Loading first page…</p>}>
        <PaginatedIssues pageSize={pageSize} returnTotal={returnTotal} />
      </Suspense>
    </main>
  )
}
