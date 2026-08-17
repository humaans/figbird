import test from 'ava'
import React from 'react'
import { createSchema, createHooks, defineQuery, service, useQueries } from '../lib'
import { createTestApp, dom } from './helpers'

interface Issue {
  id: number
  title: string
  status: string
}

interface User {
  id: number
  name: string
}

const schema = createSchema({
  services: {
    issues: service<{ item: Issue }>(),
    users: service<{ item: User }>(),
  },
})

function createApp() {
  return createTestApp(schema, {
    issues: {
      data: {
        1: { id: 1, title: 'First issue', status: 'open' },
        2: { id: 2, title: 'Second issue', status: 'closed' },
      },
    },
    users: {
      data: {
        1: { id: 1, name: 'Alice' },
        2: { id: 2, name: 'Bob' },
      },
    },
  })
}

class ErrorBoundary extends React.Component<
  { fallback: (err: Error) => React.ReactNode; children?: React.ReactNode },
  { error: Error | null }
> {
  override state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  override render() {
    if (this.state.error) return this.props.fallback(this.state.error)
    return this.props.children
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

test('useQueries: fetches all queries in parallel under a single suspension', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird, feathers } = createApp()
  const openIssues = defineQuery(({ status }: { status: string }) =>
    figbird.q.issues.where({ status }),
  )
  const allUsers = defineQuery(() => figbird.q.users)

  // Record when each service's find is *issued* and delay resolution, so a
  // sequential waterfall would be observable: with per-query suspension, `users`
  // would only be called ~20ms after `issues` resolved.
  const calls: string[] = []
  for (const name of ['issues', 'users'] as const) {
    const svc = feathers.service(name)
    svc.setDelay(20)
    const origFind = svc.find.bind(svc)
    svc.find = (params: Parameters<typeof origFind>[0]) => {
      calls.push(name)
      return origFind(params)
    }
  }

  function Dashboard() {
    const [issues, users] = useQueries([openIssues({ status: 'open' }), allUsers])
    // Type-inference assertions — the tuple element types flow from each builder.
    const issueRows: Issue[] = issues.data
    const userRows: User[] = users.data
    return (
      <div className='dashboard'>
        <div className='issues'>{issueRows.map(i => i.title).join(',')}</div>
        <div className='users'>{userRows.map(u => u.name).join(',')}</div>
      </div>
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='fallback'>Loading...</div>}>
        <Dashboard />
      </React.Suspense>
    </App>,
  )

  t.truthy($('.fallback'))

  // Well before either 20ms delay elapses, both fetches must already be in flight.
  await flush(() => sleep(5))
  t.deepEqual([...new Set(calls)].sort(), ['issues', 'users'], 'both fetches started in parallel')
  t.truthy($('.fallback'), 'still suspended while both are in flight')

  await flush(() => sleep(30))
  t.falsy($('.fallback'))
  t.is($('.issues')!.innerHTML, 'First issue,Second issue')
  t.is($('.users')!.innerHTML, 'Alice,Bob')

  unmount()
})

test('useQueries: kit-bound variant works and an empty array resolves immediately', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App } = createApp()
  const hooks = createHooks(schema)

  function Dashboard() {
    const [issues] = hooks.useQueries([hooks.q.issues])
    const none = hooks.useQueries([])
    return (
      <div className='dashboard'>
        <div className='issues'>{issues.data.map(i => i.title).join(',')}</div>
        <div className='none'>{none.length}</div>
      </div>
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='fallback'>Loading...</div>}>
        <Dashboard />
      </React.Suspense>
    </App>,
  )

  await flush(() => sleep(5))
  t.is($('.issues')!.innerHTML, 'First issue,Second issue')
  t.is($('.none')!.innerHTML, '0', 'an empty set never suspends')

  unmount()
})

test('useQueries: a cold error on any query throws to the ErrorBoundary', async t => {
  const caughtErrors: unknown[] = []
  const { render, unmount, flush, $ } = dom({
    onCaughtError: error => caughtErrors.push(error),
  })
  const { App, figbird, feathers } = createApp()

  feathers.service('issues').setDelay(20)
  feathers.service('users').find = () => Promise.reject(new Error('users are broken'))

  function Dashboard() {
    const [issues, users] = useQueries([figbird.q.issues, figbird.q.users])
    return (
      <div className='dashboard'>
        {issues.data.length},{users.data.length}
      </div>
    )
  }

  render(
    <App>
      <ErrorBoundary fallback={err => <div className='error'>{err.message}</div>}>
        <React.Suspense fallback={<div className='fallback'>Loading...</div>}>
          <Dashboard />
        </React.Suspense>
      </ErrorBoundary>
    </App>,
  )

  await flush(() => sleep(10))
  t.deepEqual(caughtErrors, [new Error('users are broken')])
  t.is($('.error')!.innerHTML, 'users are broken')
  t.falsy($('.dashboard'))

  await flush(() => sleep(30))
  t.true(
    figbird.inspect().every(row => row.subscriberCount === 0),
    'abandoned sibling refs release their internal query subscriptions after settling',
  )

  unmount()
})

test('useQueries: refetch on one element refetches only that query', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird, feathers } = createApp()

  let refetchUsers: (() => void) | null = null

  function Dashboard() {
    const [issues, users] = useQueries([figbird.q.issues, figbird.q.users])
    refetchUsers = users.refetch
    return (
      <div className='dashboard'>
        <div className='issues'>{issues.data.map(i => i.title).join(',')}</div>
        <div className='users'>{users.data.map(u => u.name).join(',')}</div>
      </div>
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='fallback'>Loading...</div>}>
        <Dashboard />
      </React.Suspense>
    </App>,
  )
  await flush()

  t.is($('.users')!.innerHTML, 'Alice,Bob')

  // Rename Bob on the server, then refetch just the users element. The component
  // stays mounted (no re-suspend) and picks up the new value.
  feathers.service('users').patch(2, { name: 'Bobby' })
  await flush(() => refetchUsers!())

  t.falsy($('.fallback'))
  t.is($('.users')!.innerHTML, 'Alice,Bobby')

  unmount()
})

test('useQueries: warm cache renders synchronously without re-suspending', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird } = createApp()

  // Warm both queries via the non-React surface before the component mounts.
  figbird.query(figbird.q.issues).subscribe(() => {})
  figbird.query(figbird.q.users).subscribe(() => {})
  await flush()

  let sawFallback = false

  function Dashboard() {
    const [issues, users] = useQueries([figbird.q.issues, figbird.q.users])
    return (
      <div className='dashboard'>
        {issues.data.length},{users.data.length}
      </div>
    )
  }

  render(
    <App>
      <React.Suspense
        fallback={
          <Fallback
            onRender={() => {
              sawFallback = true
            }}
          />
        }
      >
        <Dashboard />
      </React.Suspense>
    </App>,
  )

  t.false(sawFallback, 'a warm set renders without ever showing the fallback')
  t.is($('.dashboard')!.innerHTML, '2,2')

  unmount()
})

test('useQueries: a paginated element widens with loadMore; siblings stay plain', async t => {
  const { render, unmount, flush, $ } = dom()
  // Inline index signature so the rows satisfy the mock's TestItem shape without
  // loosening the shared `Issue` interface the other tests type-assert against.
  const issueRows: Record<string, Issue & Record<string, unknown>> = {}
  for (let i = 1; i <= 5; i++) {
    issueRows[i] = { id: i, title: `Issue ${i}`, status: 'open' }
  }
  const { App, figbird } = createTestApp(
    schema,
    {
      issues: { data: issueRows },
      users: { data: { 1: { id: 1, name: 'Alice' }, 2: { id: 2, name: 'Bob' } } },
    },
    { queryAwareFind: true },
  )

  let loadMoreIssues: (() => void) | null = null
  let userHasLoadMore = true

  function Dashboard() {
    const [issues, users] = useQueries([
      figbird.q.issues.orderBy('id', 'asc').paginate({ pageSize: 2 }),
      figbird.q.users,
    ])
    loadMoreIssues = issues.loadMore
    // The plain sibling carries no loadMore — a compile-time and runtime check.
    userHasLoadMore = 'loadMore' in users
    return (
      <div className='dashboard'>
        <div className='issues' data-has-more={String(issues.hasMore)}>
          {issues.data.map(i => i.title).join(',')}
        </div>
        <div className='users'>{users.data.map(u => u.name).join(',')}</div>
      </div>
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='fallback'>Loading...</div>}>
        <Dashboard />
      </React.Suspense>
    </App>,
  )
  await flush()

  // Page 0 of issues and all users, both from the one suspension.
  t.is($('.issues')!.innerHTML, 'Issue 1,Issue 2')
  t.is($('.issues')!.getAttribute('data-has-more'), 'true')
  t.is($('.users')!.innerHTML, 'Alice,Bob')
  t.false(userHasLoadMore, 'the non-paginated element has no loadMore')

  // loadMore on the paginated element appends its next page without re-suspending;
  // the sibling users element is untouched.
  await flush(() => loadMoreIssues!())
  t.falsy($('.fallback'))
  t.is($('.issues')!.innerHTML, 'Issue 1,Issue 2,Issue 3,Issue 4')
  t.is($('.users')!.innerHTML, 'Alice,Bob')

  unmount()
})

function Fallback({ onRender }: { onRender: () => void }) {
  onRender()
  return <div className='fallback'>Loading...</div>
}
