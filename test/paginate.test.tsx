import test from 'ava'
import React from 'react'
import { createSchema, service, useQuery } from '../lib'
import { createTestApp, dom } from './helpers'

// ============================================================================
// Test types & schema
// ============================================================================

interface Issue {
  id: number
  title: string
  status: 'open' | 'closed'
  rank: number
  [key: string]: unknown
}

interface IssueService {
  item: Issue
}

interface Comment {
  id: number
  issueId: number
  body: string
  [key: string]: unknown
}

interface CommentService {
  item: Comment
}

const paginateSchema = createSchema({
  services: {
    issues: service<IssueService>(),
    comments: service<CommentService>(),
  },
  relationships: {
    issues: ({ many: manyRel }) => ({
      comments: manyRel({
        sourceField: 'id',
        destService: 'comments',
        destField: 'issueId',
      }),
    }),
  },
})

function makeIssues(n: number): Record<string, Issue> {
  const data: Record<string, Issue> = {}
  for (let i = 1; i <= n; i++) {
    data[i] = {
      id: i,
      title: `Issue ${i}`,
      status: i % 2 === 0 ? 'closed' : 'open',
      rank: i,
    }
  }
  return data
}

function makeComments(forIssueIds: number[]): Record<string, Comment> {
  const data: Record<string, Comment> = {}
  let id = 0
  for (const issueId of forIssueIds) {
    id++
    data[id] = { id, issueId, body: `Comment for issue ${issueId}` }
  }
  return data
}

interface PaginateAppOptions {
  totalIssues?: number
  skipTotal?: boolean
}

function createPaginateApp(opts: PaginateAppOptions = {}) {
  const totalIssues = opts.totalIssues ?? 10
  const { App, figbird, feathers } = createTestApp(
    paginateSchema,
    {
      issues: { data: makeIssues(totalIssues) },
      comments: {
        data: makeComments(Array.from({ length: totalIssues }, (_, i) => i + 1)),
      },
    },
    { queryAwareFind: true, ...(opts.skipTotal ? { skipTotal: true } : {}) },
  )

  return { App, figbird, feathers, issuesService: feathers.service('issues') }
}

// ============================================================================
// QueryBuilder unit tests
// ============================================================================

test('QueryBuilder.paginate: sets kind=paginate, pageSize, returnTotal in AST', t => {
  const { figbird } = createPaginateApp()
  const ast = figbird.q.issues.paginate({ pageSize: 4, returnTotal: true }).toAST()
  t.is(ast.kind, 'paginate')
  t.is(ast.pageSize, 4)
  t.is(ast.returnTotal, true)
  t.is(ast.cardinality, 'many')
})

test('QueryBuilder.paginate: returnTotal defaults to omitted (undefined)', t => {
  const { figbird } = createPaginateApp()
  const ast = figbird.q.issues.paginate({ pageSize: 4 }).toAST()
  t.is(ast.kind, 'paginate')
  t.is(ast.pageSize, 4)
  t.is(ast.returnTotal, undefined)
})

test('QueryBuilder.paginate: rejects non-positive pageSize', t => {
  const { figbird } = createPaginateApp()
  t.throws(() => figbird.q.issues.paginate({ pageSize: 0 }), { message: /pageSize/i })
  t.throws(() => figbird.q.issues.paginate({ pageSize: -3 }), { message: /pageSize/i })
})

test('QueryBuilder.paginate: composes with where and orderBy before paginate', t => {
  const { figbird } = createPaginateApp()
  const ast = figbird.q.issues
    .where({ status: 'open' })
    .orderBy('rank', 'desc')
    .paginate({ pageSize: 5 })
    .toAST()
  t.is(ast.kind, 'paginate')
  t.is(ast.pageSize, 5)
  t.deepEqual(ast.query, { status: 'open', $sort: { rank: -1 } })
})

test('QueryBuilder.paginate: hash differs by pageSize and returnTotal', t => {
  const { figbird } = createPaginateApp()
  const a = figbird.q.issues.paginate({ pageSize: 4 })
  const b = figbird.q.issues.paginate({ pageSize: 5 })
  const c = figbird.q.issues.paginate({ pageSize: 4, returnTotal: true })
  t.not(a.hash(), b.hash(), 'pageSize must affect hash')
  t.not(a.hash(), c.hash(), 'returnTotal must affect hash')
})

// ============================================================================
// Hook integration tests
// ============================================================================

test('useQuery + paginate: first page renders, hasMore reflects whether the server returned a full page', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird } = createPaginateApp({ totalIssues: 7 })

  function IssueList() {
    const { data, hasMore, isLoadingMore } = useQuery(
      figbird.q.issues.orderBy('rank', 'asc').paginate({ pageSize: 3 }),
    )
    return (
      <div
        className='issues'
        data-titles={data.map(i => i.title).join(',')}
        data-has-more={String(hasMore)}
        data-loading-more={String(isLoadingMore)}
      />
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='fallback'>...</div>}>
        <IssueList />
      </React.Suspense>
    </App>,
  )

  await flush()

  t.is($('.issues')!.getAttribute('data-titles'), 'Issue 1,Issue 2,Issue 3')
  t.is($('.issues')!.getAttribute('data-has-more'), 'true')
  t.is($('.issues')!.getAttribute('data-loading-more'), 'false')

  unmount()
})

test('useQuery + paginate: loadMore appends the next page and flips hasMore false on partial page', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird } = createPaginateApp({ totalIssues: 7 })

  let loadMoreFn: (() => void) | null = null

  function IssueList() {
    const { data, hasMore, loadMore } = useQuery(
      figbird.q.issues.orderBy('rank', 'asc').paginate({ pageSize: 3 }),
    )
    loadMoreFn = loadMore
    return (
      <div
        className='issues'
        data-count={String(data.length)}
        data-titles={data.map(i => i.title).join(',')}
        data-has-more={String(hasMore)}
      />
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='fallback'>...</div>}>
        <IssueList />
      </React.Suspense>
    </App>,
  )

  await flush()

  // Page 0: 1, 2, 3 — full, hasMore truthy
  t.is($('.issues')!.getAttribute('data-count'), '3')
  t.is($('.issues')!.getAttribute('data-has-more'), 'true')

  // Page 1: 4, 5, 6 — full, still hasMore
  await flush(() => {
    loadMoreFn!()
  })
  t.is($('.issues')!.getAttribute('data-titles'), 'Issue 1,Issue 2,Issue 3,Issue 4,Issue 5,Issue 6')
  t.is($('.issues')!.getAttribute('data-has-more'), 'true')

  // Page 2: 7 only — partial, hasMore must flip to false
  await flush(() => {
    loadMoreFn!()
  })
  t.is(
    $('.issues')!.getAttribute('data-titles'),
    'Issue 1,Issue 2,Issue 3,Issue 4,Issue 5,Issue 6,Issue 7',
  )
  t.is($('.issues')!.getAttribute('data-has-more'), 'false')

  unmount()
})

test('useQuery + paginate: returnTotal exposes totalCount from the first page meta', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird } = createPaginateApp({ totalIssues: 12 })

  function IssueList() {
    const { totalCount } = useQuery(
      figbird.q.issues.orderBy('rank', 'asc').paginate({ pageSize: 4, returnTotal: true }),
    )
    return <div className='issues' data-total={String(totalCount ?? 'unset')} />
  }

  render(
    <App>
      <React.Suspense fallback={<div className='fallback'>...</div>}>
        <IssueList />
      </React.Suspense>
    </App>,
  )

  await flush()
  t.is($('.issues')!.getAttribute('data-total'), '12')

  unmount()
})

test('useQuery + paginate: totalCount is undefined when adapter omits total', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird } = createPaginateApp({ totalIssues: 12, skipTotal: true })

  function IssueList() {
    const { totalCount } = useQuery(
      figbird.q.issues.orderBy('rank', 'asc').paginate({ pageSize: 4, returnTotal: true }),
    )
    return <div className='issues' data-total={String(totalCount ?? 'unset')} />
  }

  render(
    <App>
      <React.Suspense fallback={<div className='fallback'>...</div>}>
        <IssueList />
      </React.Suspense>
    </App>,
  )

  await flush()
  t.is($('.issues')!.getAttribute('data-total'), 'unset')

  unmount()
})

test('useQuery + paginate: refetch drops follow-up pages and re-fetches page 0 in place', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird, issuesService } = createPaginateApp({ totalIssues: 9 })

  let loadMoreFn: (() => void) | null = null
  let refetchFn: (() => void) | null = null

  function IssueList() {
    const { data, loadMore, refetch, hasMore } = useQuery(
      figbird.q.issues.orderBy('rank', 'asc').paginate({ pageSize: 3 }),
    )
    loadMoreFn = loadMore
    refetchFn = refetch
    return (
      <div className='issues' data-count={String(data.length)} data-has-more={String(hasMore)} />
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='fallback'>...</div>}>
        <IssueList />
      </React.Suspense>
    </App>,
  )

  await flush()

  // Load 3 pages: total 9 visible
  await flush(() => loadMoreFn!())
  await flush(() => loadMoreFn!())
  t.is($('.issues')!.getAttribute('data-count'), '9')

  const findCountBefore = issuesService.counts.find

  // refetch: pages 1+ are dropped, only page 0 re-fetches
  await flush(() => refetchFn!())
  t.is($('.issues')!.getAttribute('data-count'), '3')
  t.is(issuesService.counts.find, findCountBefore + 1, 'refetch must re-fetch only page 0')
  t.is($('.issues')!.getAttribute('data-has-more'), 'true')

  unmount()
})

test('useQuery + paginate: composes with .related() — relations attach to every page', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird } = createPaginateApp({ totalIssues: 4 })

  let loadMoreFn: (() => void) | null = null

  function IssueList() {
    const { data, loadMore } = useQuery(
      figbird.q.issues.orderBy('rank', 'asc').paginate({ pageSize: 2 }).related('comments'),
    )
    loadMoreFn = loadMore
    return (
      <div
        className='issues'
        data-rows={data.map(issue => `${issue.title}:${issue.comments.length}`).join('|')}
      />
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='fallback'>...</div>}>
        <IssueList />
      </React.Suspense>
    </App>,
  )

  await flush()

  t.is($('.issues')!.getAttribute('data-rows'), 'Issue 1:1|Issue 2:1')

  await flush(() => loadMoreFn!())
  t.is($('.issues')!.getAttribute('data-rows'), 'Issue 1:1|Issue 2:1|Issue 3:1|Issue 4:1')

  unmount()
})

test('useQuery + paginate: realtime create that provably sorts into a page merges locally', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird, feathers, issuesService } = createPaginateApp({ totalIssues: 5 })

  function IssueList() {
    const { data, hasMore } = useQuery(
      figbird.q.issues.orderBy('rank', 'asc').paginate({ pageSize: 3 }),
    )
    return (
      <div
        className='issues'
        data-count={String(data.length)}
        data-titles={data.map(i => i.title).join(',')}
        data-has-more={String(hasMore)}
      />
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='fallback'>...</div>}>
        <IssueList />
      </React.Suspense>
    </App>,
  )

  await flush()
  // Page 0: rank 1,2,3 — hasMore true (full page)
  t.is($('.issues')!.getAttribute('data-count'), '3')
  t.is($('.issues')!.getAttribute('data-has-more'), 'true')
  const findCountBefore = issuesService.counts.find

  // Insert a new issue with rank 0 — it should sort to the front of page 0.
  await flush(async () => {
    await feathers.service('issues').create({
      id: 99,
      title: 'Inserted',
      status: 'open',
      rank: 0,
    })
  })

  // The new row sorts strictly inside page 0's window (rank 0 < rank 1), so window
  // maintenance inserts it locally and evicts the overflow row — no refetch.
  t.is(
    issuesService.counts.find,
    findCountBefore,
    'a provable insert must merge locally without a refetch',
  )
  t.is(
    $('.issues')!.getAttribute('data-titles'),
    'Inserted,Issue 1,Issue 2',
    'inserted row must appear at the top of page 0, evicting the overflow row',
  )
  t.is($('.issues')!.getAttribute('data-count'), '3')

  unmount()
})
