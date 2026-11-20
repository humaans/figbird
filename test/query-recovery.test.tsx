import { Component, Suspense, useLayoutEffect, useState, type ReactNode } from 'react'
import {
  createHooks,
  createSchema,
  Figbird,
  FigbirdProvider,
  service,
  type FeathersAdapter,
} from '../lib'
import { createTestApp } from './helpers'
import { dom, it } from './dom'
import { app, schema } from './custom-query-helpers'
import { deferred } from './mutation-test-helpers'
import { TestClock } from './clock'

const { q, useQuery, useQueryResult, useQueries } = createHooks(schema)
type Job = { id: number; status: string }

class Boundary extends Component<{ children: ReactNode; name?: string }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  override render() {
    return this.state.error ? (
      <div data-failed={this.props.name ?? 'main'}>{this.state.error.message}</div>
    ) : (
      this.props.children
    )
  }
}

function installTransport(adapter: FeathersAdapter, run: () => Promise<Job>): void {
  adapter.get = async () => ({ data: await run() })
  adapter.call = run
}

it('manual recovery: a pending refetch of a cold error suspends instead of spinning', async t => {
  for (const kind of ['entity', 'custom'])
    for (const refresh of ['reader', 'service']) {
      const { App, figbird, adapter } = app()
      t.teardown(() => figbird.dispose())
      let calls = 0
      let run: () => Promise<Job> = async () => {
        calls++
        throw new Error('offline')
      }
      installTransport(adapter, () => run())
      const builder = kind === 'entity' ? q.jobs.get(1) : q.jobs.getCheck({ id: 1 })
      let refetch = () => {}
      let show = () => {}
      let renders = 0
      function Holder() {
        const result = useQueryResult(builder, { suspense: false })
        useLayoutEffect(() => {
          refetch = result.refetch
        })
        return <div className='holder'>{result.status}</div>
      }
      function Probe() {
        if (++renders > 200) throw new Error('Suspense render loop')
        return <div className='ready'>{useQuery(builder)?.status}</div>
      }
      function Screen() {
        const [visible, setVisible] = useState(false)
        show = () => setVisible(true)
        return (
          <>
            <Holder />
            {visible && (
              <Boundary>
                <Suspense fallback={<div className='waiting'>Waiting</div>}>
                  <Probe />
                </Suspense>
              </Boundary>
            )}
          </>
        )
      }
      const d = dom({ onCaughtError: () => {} })
      d.render(
        <App>
          <Screen />
        </App>,
      )
      await d.flush()
      t.is(d.$('.holder')?.textContent, 'error')
      const gate = deferred<Job>()
      run = () => {
        calls++
        return gate.promise
      }
      await d.flush(() => {
        if (refresh === 'reader') refetch()
        else figbird.refetch('jobs')
        show()
      })
      t.is(
        d.$('[data-failed]')?.textContent,
        undefined,
        `${kind}: pending recovery must not hit the render budget`,
      )
      t.truthy(d.$('.waiting'))
      await d.flush(() => gate.resolve({ id: 1, status: 'recovered' }))
      t.is(d.$('.ready')?.textContent, 'recovered')
      t.is(calls, 2)
      d.unmount()
    }
})

it('warm remount: store-cached data renders synchronously and honors reader staleTime', async t => {
  for (const parallel of [false, true])
    for (const staleTime of [undefined, Infinity, 1000, 0]) {
      const { figbird: original, adapter } = app()
      original.dispose()
      const clock = new TestClock()
      const figbird = new Figbird({
        schema,
        adapter,
        clock,
        staleTime: 1000,
        gcTime: 60_000,
        retry: false,
      })
      t.teardown(() => figbird.dispose())
      const readerOptions = staleTime === undefined ? {} : { staleTime }
      let calls = 0
      const gate = deferred<Job>()
      installTransport(adapter, async () =>
        ++calls === 1 ? { id: 1, status: 'cached' } : gate.promise,
      )
      let fallbackCommits = 0
      function Fallback() {
        useLayoutEffect(() => {
          fallbackCommits++
        })
        return <div className='waiting'>Waiting</div>
      }
      function Single() {
        return <div className='ready'>{useQuery(q.jobs.get(1), readerOptions)?.status}</div>
      }
      function Parallel() {
        return <div className='ready'>{useQueries([q.jobs.get(1)], readerOptions)[0]?.status}</div>
      }
      const d = dom()
      const tree = (visible: boolean) => (
        <FigbirdProvider figbird={figbird}>
          {visible && (
            <Suspense fallback={<Fallback />}>{parallel ? <Parallel /> : <Single />}</Suspense>
          )}
        </FigbirdProvider>
      )
      d.render(tree(true))
      await d.flush()
      t.is(d.$('.ready')?.textContent, 'cached')
      const initialFallbackCommits = fallbackCommits
      d.render(tree(false))
      await d.flush()
      await clock.advance(100)
      d.render(tree(true))
      t.deepEqual(
        { calls, fallbackCommits, data: d.$('.ready')?.textContent },
        {
          calls: staleTime === 0 ? 2 : 1,
          fallbackCommits: initialFallbackCommits,
          data: 'cached',
        },
        `${parallel ? 'parallel' : 'single'} reader, staleTime=${staleTime}`,
      )
      await d.flush(() => gate.resolve({ id: 1, status: 'updated' }))
      d.unmount()
    }
})

it('permanent failures make one request per boundary reset and unrelated renders do not retry', async t => {
  for (const kind of ['entity', 'custom']) {
    const { App, figbird, adapter } = app()
    t.teardown(() => figbird.dispose())
    let calls = 0
    installTransport(adapter, async () => {
      calls++
      throw new Error('permanent')
    })
    const builder = kind === 'entity' ? q.jobs.get(1) : q.jobs.getCheck({ id: 1 })
    let renders = 0
    function Holder({ tick }: { tick: number }) {
      const result = useQueryResult(builder, { suspense: false })
      return (
        <div className='tick'>
          {tick}:{result.status}
        </div>
      )
    }
    function Probe() {
      if (++renders > 200) throw new Error('retry loop')
      return <div>{useQuery(builder)?.status}</div>
    }
    const d = dom({ onCaughtError: () => {} })
    const tree = (reset: number, tick: number) => (
      <App>
        <Holder tick={tick} />
        <Boundary key={reset}>
          <Suspense fallback={<div>Waiting</div>}>
            <Probe />
          </Suspense>
        </Boundary>
      </App>
    )
    d.render(tree(0, 0))
    await d.flush()
    for (let reset = 0; reset <= 3; reset++) {
      if (reset > 0) {
        d.render(tree(reset, 0))
        await d.flush()
      }
      t.is(calls, reset + 1)
      t.truthy(d.$('[data-failed]'))
      d.render(tree(reset, 1))
      await d.flush()
      t.is(d.$('.tick')?.textContent, '1:error')
      t.is(calls, reset + 1, 'an unrelated update must not consume the query retry')
    }
    t.true(renders < 100)
    d.unmount()
  }
})

it('resetting one of two failed boundaries recovers their shared query', async t => {
  for (const kind of ['entity', 'custom']) {
    const { App, figbird, adapter } = app()
    t.teardown(() => figbird.dispose())
    let calls = 0
    let run: () => Promise<Job> = async () => {
      calls++
      throw new Error('offline')
    }
    installTransport(adapter, () => run())
    const builder = kind === 'entity' ? q.jobs.get(1) : q.jobs.getCheck({ id: 1 })
    function Holder() {
      const result = useQueryResult(builder, { suspense: false })
      return <div className='holder'>{result.status}</div>
    }
    function Probe({ name }: { name: string }) {
      return <div data-ready={name}>{useQuery(builder)?.status}</div>
    }
    const d = dom({ onCaughtError: () => {} })
    const tree = (a: number, b: number) => (
      <App>
        <Holder />
        <Boundary name='a' key={`a:${a}`}>
          <Suspense fallback={<div>Waiting</div>}>
            <Probe name='a' />
          </Suspense>
        </Boundary>
        <Boundary name='b' key={`b:${b}`}>
          <Suspense fallback={<div>Waiting</div>}>
            <Probe name='b' />
          </Suspense>
        </Boundary>
      </App>
    )
    d.render(tree(0, 0))
    await d.flush()
    t.is(calls, 1)
    t.truthy(d.$('[data-failed="a"]'))
    t.truthy(d.$('[data-failed="b"]'))
    run = async () => {
      calls++
      return { id: 1, status: 'recovered' }
    }
    d.render(tree(1, 0))
    await d.flush()
    t.is(d.$('[data-ready="a"]')?.textContent, 'recovered')
    t.is(d.$('.holder')?.textContent, 'success')
    t.truthy(d.$('[data-failed="b"]'))
    t.is(calls, 2)
    d.render(tree(1, 1))
    await d.flush()
    t.is(d.$('[data-ready="b"]')?.textContent, 'recovered')
    t.is(calls, 2)
    d.unmount()
  }
})

it('warm remount: the strictest reader in a commit decides revalidation', async t => {
  const cases = [0, 100].flatMap(age =>
    ['loose first', 'strict first', 'both loose'].map(order => ({ age, order })),
  )
  for (const { age, order } of cases) {
    const { figbird: original, adapter } = app()
    original.dispose()
    const clock = new TestClock()
    const figbird = new Figbird({ schema, adapter, clock, gcTime: 60_000, retry: false })
    t.teardown(() => figbird.dispose())
    let calls = 0
    installTransport(adapter, async () => ({ id: 1, status: `fetch ${++calls}` }))
    function Reader({ staleTime }: { staleTime: number }) {
      return <span className='ready'>{useQuery(q.jobs.get(1), { staleTime })?.status}</span>
    }
    const staleTimes =
      order === 'loose first'
        ? [Infinity, 0]
        : order === 'strict first'
          ? [0, Infinity]
          : [Infinity, Infinity]
    const d = dom()
    const tree = (visible: boolean) => (
      <FigbirdProvider figbird={figbird}>
        {visible && (
          <Suspense fallback={<div className='waiting'>Waiting</div>}>
            {staleTimes.map((staleTime, i) => (
              <Reader key={i} staleTime={staleTime} />
            ))}
          </Suspense>
        )}
      </FigbirdProvider>
    )
    d.render(tree(true))
    await d.flush()
    t.is(calls, 1)
    d.render(tree(false))
    await d.flush()
    await clock.advance(age)
    d.render(tree(true))
    await d.flush()
    t.is(calls, order === 'both loose' ? 1 : 2, `${order}, cache age ${age}`)
    d.unmount()
  }
})

it('a reader that mounts beside an already failed query does not waste the first boundary retry', async t => {
  for (const kind of ['entity', 'custom']) {
    const { App, figbird, adapter } = app()
    t.teardown(() => figbird.dispose())
    let calls = 0
    let run: () => Promise<Job> = async () => {
      calls++
      throw new Error('offline')
    }
    installTransport(adapter, () => run())
    const builder = kind === 'entity' ? q.jobs.get(1) : q.jobs.getCheck({ id: 1 })
    // The route's preparation fails before any component mounts.
    const prepared = figbird.prepare(builder)
    await t.throwsAsync(prepared.promise, { message: 'offline' })
    function Holder() {
      return <span className='holder'>{useQueryResult(builder, { suspense: false }).status}</span>
    }
    function Probe() {
      return <span className='ready'>{useQuery(builder)?.status}</span>
    }
    const d = dom({ onCaughtError: () => {} })
    const tree = (key: string) => (
      <App>
        <Holder />
        <Boundary key={key}>
          <Suspense fallback={<div className='waiting'>Waiting</div>}>
            <Probe />
          </Suspense>
        </Boundary>
      </App>
    )
    d.render(tree('first'))
    await d.flush()
    t.truthy(d.$('[data-failed]'), kind)
    prepared.release()
    await d.flush()
    run = async () => {
      calls++
      return { id: 1, status: 'recovered' }
    }
    d.render(tree('retry'))
    await d.flush()
    t.is(d.$('.ready')?.textContent, 'recovered', kind)
    t.is(calls, 2, kind)
    d.unmount()
  }
})

it('warm remount: a stricter reader revalidates what the cold start served from cache', async t => {
  const relational = createSchema({
    services: {
      issues: service<{ item: { id: number; assigneeId: number } }>(),
      users: service<{ item: { id: number; name: string } }>(),
    },
    relationships: {
      issues: ({ one }) => ({ assignee: one({ sourceField: 'assigneeId', destService: 'users' }) }),
    },
  })
  const hooks = createHooks(relational)
  const {
    figbird: original,
    adapter,
    feathers,
  } = createTestApp(relational, {
    issues: { data: { 1: { id: 1, assigneeId: 7 } } },
    users: { data: { 7: { id: 7, name: 'Ada' } } },
  })
  original.dispose()
  const clock = new TestClock()
  const figbird = new Figbird({ schema: relational, adapter, clock, retry: false })
  t.teardown(() => figbird.dispose())
  const finds = () => ({
    issues: feathers.service('issues').counts.find,
    users: feathers.service('users').counts.find,
  })

  // Cache the root list only, then let it age well past any finite tolerance.
  const warm = figbird.query(hooks.q.issues).subscribe(() => {})
  await clock.advance(0)
  warm()
  await clock.advance(10 * 60_000)
  t.deepEqual(finds(), { issues: 1, users: 0 })

  function Reader({ staleTime }: { staleTime: number }) {
    const issues = hooks.useQuery(hooks.q.issues.related('assignee'), { staleTime })
    return <span className='ready'>{issues[0]?.assignee?.name}</span>
  }
  const d = dom()
  d.render(
    <FigbirdProvider figbird={figbird}>
      <Suspense fallback={<div className='waiting'>Waiting</div>}>
        <Reader staleTime={Infinity} />
        <Reader staleTime={0} />
      </Suspense>
    </FigbirdProvider>,
  )
  await d.flush()
  await d.flush(() => clock.advance(0))
  t.is(d.$('.ready')?.textContent, 'Ada')
  // The strict reader refreshes the stale root; the relation this render just fetched is left alone.
  t.deepEqual(finds(), { issues: 2, users: 1 })
  d.unmount()
})

it('a retry that refetches the service and resets the boundary makes one request', async t => {
  for (const kind of ['entity', 'custom']) {
    const { App, figbird, adapter } = app()
    t.teardown(() => figbird.dispose())
    let calls = 0
    installTransport(adapter, async () => {
      calls++
      throw new Error('permanent')
    })
    const builder = kind === 'entity' ? q.jobs.get(1) : q.jobs.getCheck({ id: 1 })
    function Holder() {
      return <span className='holder'>{useQueryResult(builder, { suspense: false }).status}</span>
    }
    function Probe() {
      return <span className='ready'>{useQuery(builder)?.status}</span>
    }
    const d = dom({ onCaughtError: () => {} })
    const tree = (reset: number) => (
      <App>
        <Holder />
        <Boundary key={reset}>
          <Suspense fallback={<div className='waiting'>Waiting</div>}>
            <Probe />
          </Suspense>
        </Boundary>
      </App>
    )
    d.render(tree(0))
    await d.flush()
    await d.flush()
    t.is(calls, 1, kind)
    t.truthy(d.$('[data-failed]'), kind)

    // One Retry button: refresh the service's queries and reset the failed boundary.
    await d.flush(() => {
      figbird.refetch('jobs')
      d.render(tree(1))
    })
    await d.flush()
    await d.flush()
    t.truthy(d.$('[data-failed]'), kind)
    t.is(calls, 2, `${kind}: the failed refetch is not retried again on its own`)
    d.unmount()
  }
})

it('parallel recovery preserves the freshness policy of cached siblings', async t => {
  for (const staleTime of [Infinity, 0]) {
    const { figbird: original, adapter } = app()
    original.dispose()
    const clock = new TestClock()
    const figbird = new Figbird({ schema, adapter, clock, staleTime: 0, retry: false })
    t.teardown(() => figbird.dispose())
    const calls = new Map<string | number, number>()
    let fail = true
    adapter.get = async (_service, id) => {
      calls.set(id, (calls.get(id) ?? 0) + 1)
      if (id === 1 && fail) throw new Error('offline')
      return { data: { id, status: 'ready' } }
    }
    const warm = q.jobs.get(2)
    const preparation = figbird.prepare(warm)
    await preparation.promise
    preparation.release()
    await clock.advance(100)
    const failed = q.jobs.get(1)
    const failedRef = figbird.query(failed)
    const releaseFailed = failedRef.subscribe(() => {})
    t.teardown(releaseFailed)
    await t.throwsAsync(failedRef.suspensePromise(), { message: 'offline' })
    function Probe() {
      const [first, second] = useQueries([failed, warm], { staleTime })
      return (
        <span className='ready'>
          {first?.status}:{second?.status}
        </span>
      )
    }
    const d = dom({ onCaughtError: () => {} })
    const tree = (reset: number) => (
      <FigbirdProvider figbird={figbird}>
        <Boundary key={reset}>
          <Suspense fallback={<div>Waiting</div>}>
            <Probe />
          </Suspense>
        </Boundary>
      </FigbirdProvider>
    )
    d.render(tree(0))
    await d.flush()
    t.truthy(d.$('[data-failed]'))
    t.is(calls.get(2), 1, 'failure does not fetch the sibling')
    fail = false
    d.render(tree(1))
    await d.flush()
    t.is(d.$('.ready')?.textContent, 'ready:ready')
    t.is(calls.get(2), staleTime === 0 ? 2 : 1, `retry respects staleTime ${staleTime}`)
    d.unmount()
  }
})
