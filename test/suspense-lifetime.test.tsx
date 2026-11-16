import { TestClock } from './clock'
import { RENDER_READ_LEASE_MS } from '../lib/core/renderReadLease'
import { Component, Suspense, type ReactNode } from 'react'
import {
  createHooks,
  createSchema,
  service,
  Figbird,
  FigbirdProvider,
  useQueryResult,
} from '../lib'
import { dom, it } from './dom'
import { createTestApp } from './helpers'

const schema = createSchema({
  services: { jobs: service<{ item: { id: number; status: string } }>() },
})
const { q, useQuery, useQueries } = createHooks(schema)

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override render() {
    return this.state.failed ? <div className='failed'>Failed</div> : this.props.children
  }
}

it('entity queries: 21 and 40 cold siblings commit without evicting their render reads', async t => {
  for (const count of [21, 40]) {
    const { App, figbird, adapter } = createTestApp(schema, { jobs: { data: {} } })
    t.teardown(() => figbird.dispose())
    adapter.get = async (_service, id) => ({ data: { id, status: 'done' } })
    const d = dom({ onCaughtError: () => {} })
    let renders = 0
    function Sibling({ id }: { id: number }) {
      if (++renders > 400) throw new Error('Suspense retry loop')
      return <span className='ready'>{useQuery(q.jobs.get(id))?.status}</span>
    }
    d.render(
      <App>
        <Boundary>
          <Suspense fallback={<div>Loading</div>}>
            {Array.from({ length: count }, (_, id) => (
              <Sibling key={id} id={id} />
            ))}
          </Suspense>
        </Boundary>
      </App>,
    )
    await d.flush()
    t.is(d.$all('.ready').length, count)
    t.falsy(d.$('.failed'))
    d.unmount()
  }
})

it('entity queries: a prepare pin does not trap an error-boundary retry', async t => {
  const { App, figbird, adapter } = createTestApp(schema, { jobs: { data: {} } })
  t.teardown(() => figbird.dispose())
  adapter.get = async () => {
    throw new Error('offline')
  }
  const builder = q.jobs.get(1)
  const prepared = figbird.prepare(builder)
  await t.throwsAsync(prepared.promise, { message: 'offline' })
  function Probe() {
    return <div className='ready'>{useQuery(builder)?.status}</div>
  }
  const d = dom({ onCaughtError: () => {} })
  d.render(
    <App>
      <Boundary key='first'>
        <Suspense fallback={<div>Loading</div>}>
          <Probe />
        </Suspense>
      </Boundary>
    </App>,
  )
  await d.flush()
  t.truthy(d.$('.failed'))
  adapter.get = async (_service, id) => ({ data: { id, status: 'recovered' } })
  d.render(
    <App>
      <Boundary key='retry'>
        <Suspense fallback={<div>Loading</div>}>
          <Probe />
        </Suspense>
      </Boundary>
    </App>,
  )
  await d.flush()
  t.is(d.$('.ready')?.textContent, 'recovered')
  d.unmount()
  prepared.release()
})

it('entity queries: a non-Suspense reader does not trap a boundary retry', async t => {
  for (const parallel of [false, true]) {
    const { App, figbird, adapter } = createTestApp(schema, { jobs: { data: {} } })
    t.teardown(() => figbird.dispose())
    let calls = 0
    adapter.get = async () => {
      calls++
      throw new Error('offline')
    }
    const builder = q.jobs.get(1)
    function Holder() {
      const result = useQueryResult(builder, { suspense: false })
      return <div className='holder'>{result.status}</div>
    }
    function Probe() {
      return <div className='ready'>{useQuery(builder)?.status}</div>
    }
    function ParallelProbe() {
      return <div className='ready'>{useQueries([builder])[0]?.status}</div>
    }
    const d = dom({ onCaughtError: () => {} })
    const tree = (key: string) => (
      <App>
        <Holder />
        <Boundary key={key}>
          <Suspense fallback={<div>Loading</div>}>
            {parallel ? <ParallelProbe /> : <Probe />}
          </Suspense>
        </Boundary>
      </App>
    )
    d.render(tree('first'))
    await d.flush()
    t.truthy(d.$('.failed'))
    t.is(d.$('.holder')?.textContent, 'error')
    await d.flush()
    t.is(calls, 1, 'the holder does not automatically restart failed reads')
    adapter.get = async (_service, id) => {
      calls++
      return { data: { id, status: 'recovered' } }
    }
    d.render(tree('retry'))
    await d.flush()
    t.is(d.$('.ready')?.textContent, 'recovered')
    t.is(d.$('.holder')?.textContent, 'success')
    t.is(calls, 2)
    d.unmount()
  }
})

it('entity queries: unused references become eligible for budget eviction', async t => {
  const { figbird: original, adapter } = createTestApp(schema, { jobs: { data: {} } })
  original.dispose()
  const clock = new TestClock()
  const figbird = new Figbird({ schema, adapter, clock, retry: false })
  t.teardown(() => figbird.dispose())
  let calls = 0
  adapter.get = async (_service, id) => {
    calls++
    return { data: { id, status: 'unused' } }
  }
  const first = figbird.query(q.jobs.get(0))
  for (let id = 1; id < 40; id++) figbird.query(q.jobs.get(id))
  t.is(calls, 0)
  await clock.advance(RENDER_READ_LEASE_MS + 1)
  t.not(figbird.query(q.jobs.get(0)), first)
  t.is(calls, 0)
})

it('entity queries: lease expiry during a long boundary refetches expired reads at most once and still commits', async t => {
  for (const waitingOn of ['fetch', 'backoff']) {
    const { figbird: original, adapter } = createTestApp(schema, { jobs: { data: {} } })
    original.dispose()
    const clock = new TestClock()
    const figbird = new Figbird({
      schema,
      adapter,
      clock,
      gcTime: 0,
      staleTime: Infinity,
      retry: 1,
      retryDelay: RENDER_READ_LEASE_MS + 100,
    })
    t.teardown(() => figbird.dispose())
    const calls = new Map<string | number, number>()
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    adapter.get = async (_service, id) => {
      const attempt = (calls.get(id) ?? 0) + 1
      calls.set(id, attempt)
      if (id === 20 && waitingOn === 'fetch') await gate
      if (id === 20 && waitingOn === 'backoff' && attempt === 1) throw new Error('retry later')
      return { data: { id, status: 'done' } }
    }
    const d = dom({ onCaughtError: () => {} })
    let renders = 0
    function Sibling({ id }: { id: number }) {
      if (++renders > 400) throw new Error('Suspense retry loop after expiry')
      return <span className='ready'>{useQuery(q.jobs.get(id))?.status}</span>
    }
    d.render(
      <FigbirdProvider figbird={figbird}>
        <Boundary>
          <Suspense fallback={<div className='waiting'>Loading</div>}>
            {Array.from({ length: 21 }, (_, id) => (
              <Sibling key={id} id={id} />
            ))}
          </Suspense>
        </Boundary>
      </FigbirdProvider>,
    )
    await d.flush()
    t.truthy(d.$('.waiting'))
    t.is(calls.size, 21)
    await d.flush(() => clock.advance(RENDER_READ_LEASE_MS + 1))
    t.is(calls.get(0), 1, 'expiry alone does not start another fetch')
    t.is(calls.get(20), 1, 'the waiting read is retained during its fetch or retry delay')
    if (waitingOn === 'fetch') await d.flush(() => release())
    else await d.flush(() => clock.advance(99))
    await d.flush()
    t.is(d.$all('.ready').length, 21)
    t.falsy(d.$('.failed'))
    t.is(calls.get(0), 2, 'an expired sibling is fetched again')
    for (let id = 1; id < 20; id++)
      t.true((calls.get(id) ?? 0) <= 2, 'no sibling enters a refetch loop')
    t.is(calls.get(20), waitingOn === 'fetch' ? 1 : 2)
    d.unmount()
  }
})

it('entity queries: an abandoned read is adopted only within its render lease', async t => {
  for (const elapsed of [RENDER_READ_LEASE_MS - 1000, RENDER_READ_LEASE_MS + 1000]) {
    const { figbird: original, adapter } = createTestApp(schema, { jobs: { data: {} } })
    original.dispose()
    const clock = new TestClock()
    const figbird = new Figbird({ schema, adapter, clock, retry: false })
    t.teardown(() => figbird.dispose())
    let calls = 0
    adapter.get = async (_service, id) => {
      calls++
      return { data: { id, status: `fetch ${calls}` } }
    }
    // A snapshot has no realtime maintenance, so only a fetch can refresh it.
    const builder = q.jobs.get(1).snapshot()
    // A suspended render that never commits starts the read and leaves it unowned.
    await figbird.query(builder).suspensePromise()
    t.is(calls, 1)
    await clock.advance(elapsed)

    const ref = figbird.query(builder)
    const release = ref.subscribe(() => {}, { staleTime: 1000 })
    await clock.advance(0)
    const expected = elapsed > RENDER_READ_LEASE_MS ? 2 : 1
    t.is(calls, expected, `after ${elapsed}ms`)
    t.is(ref.getSnapshot().data?.status, `fetch ${expected}`)
    release()
  }
})

it('releasing a pin while a Suspense read is pending does not strand the read', async t => {
  for (const pin of ['prepare', 'prefetch']) {
    const { figbird: original, adapter } = createTestApp(schema, { jobs: { data: {} } })
    original.dispose()
    const clock = new TestClock()
    const figbird = new Figbird({ schema, adapter, clock, retry: false })
    t.teardown(() => figbird.dispose())
    let land!: () => void
    const landed = new Promise<void>(resolve => {
      land = resolve
    })
    let calls = 0
    adapter.get = async (_service, id) => {
      calls++
      await landed
      return { data: { id, status: 'done' } }
    }
    const builder = q.jobs.get(1)
    const prepared = pin === 'prepare' ? figbird.prepare(builder) : null
    if (pin === 'prefetch') figbird.prefetch(builder, { staleTime: 50 })
    // What a suspended render holds: the promise React waits on before rendering again.
    const read = figbird.query(builder).suspensePromise()

    // The pin goes away before the slow fetch lands.
    prepared?.release()
    await clock.advance(60)
    land()
    const outcome = await Promise.race([
      read.then(() => 'settled'),
      new Promise(resolve => setTimeout(() => resolve('still pending'), 100)),
    ])
    t.is(outcome, 'settled', pin)
    t.is(calls, 1, pin)
    t.is(figbird.query(builder).getSnapshot().data?.status, 'done', pin)
  }
})
