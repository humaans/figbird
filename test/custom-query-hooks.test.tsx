import { Component, StrictMode, Suspense, type ReactNode } from 'react'
import { createHooks, Figbird, FigbirdProvider } from '../lib'
import { flushTasks, TestClock } from './clock'
import { dom, it } from './dom'
import { deferred } from './mutation-test-helpers'
import { app, schema } from './custom-query-helpers'

const { q, useQuery, useQueryResult, useQueries, useMutating, defineQuery } = createHooks(schema)

class FailureBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override render() {
    return this.state.failed ? <div className='failed'>Failed</div> : this.props.children
  }
}

it('custom q: useQuery suspends, deduplicates readers, and commits under StrictMode', async t => {
  const { figbird: original, adapter } = app()
  original.dispose()
  const figbird = new Figbird({ schema, adapter, staleTime: 0, gcTime: 0, retry: false })
  t.teardown(() => figbird.dispose())
  const gate = deferred<unknown>()
  let calls = 0
  adapter.call = () => {
    calls++
    return gate.promise
  }
  const d = dom()
  function Probe() {
    const result = useQuery(q.jobs.getCheck({ id: 1 }))
    return <span className='status'>{result.status}</span>
  }
  d.render(
    <StrictMode>
      <FigbirdProvider figbird={figbird}>
        <Suspense fallback={<div className='loading'>Loading</div>}>
          <Probe />
          <Probe />
        </Suspense>
      </FigbirdProvider>
    </StrictMode>,
  )
  t.truthy(d.$('.loading'))
  await d.flush(async () => {
    gate.resolve({ id: 1, status: 'done' })
    await gate.promise
  })
  t.is(calls, 1)
  t.deepEqual(
    d.$all('.status').map(element => element.textContent),
    ['done', 'done'],
  )
  t.falsy(d.$('.loading'))
  d.unmount()
})

it('custom q: useQueryResult exposes pending, errors, and refetch without mutation activity', async t => {
  const { App, figbird, adapter } = app()
  t.teardown(() => figbird.dispose())
  const gate = deferred<unknown>()
  adapter.call = () => gate.promise
  const d = dom()
  let refetch!: () => void
  function Probe() {
    const result = useQueryResult(q.jobs.getCheck({ id: 1 }), { suspense: false })
    const busy = useMutating()
    refetch = result.refetch
    return (
      <div className='status'>{`${result.status}:${busy}:${result.error?.message ?? result.data?.status ?? ''}`}</div>
    )
  }
  d.render(
    <App>
      <Probe />
    </App>,
  )
  await d.flush()
  t.is(d.$('.status')?.textContent, 'loading:false:')
  await d.flush(async () => {
    gate.reject(new Error('offline'))
    await gate.promise.catch(() => {})
  })
  t.is(d.$('.status')?.textContent, 'error:false:offline')
  adapter.call = async () => ({ id: 1, status: 'recovered' })
  await d.flush(() => refetch())
  t.is(d.$('.status')?.textContent, 'success:false:recovered')
  d.unmount()
})

it('custom q: definition requests, skip/null, and mixed parallel queries use existing hooks', async t => {
  const { App, figbird, feathers } = app()
  t.teardown(() => figbird.dispose())
  let calls = 0
  feathers.service('api/jobs').getCheck = async () => {
    calls++
    return { id: 1, status: 'checked' }
  }
  const status = defineQuery((id: number) => q.jobs.getCheck({ id }))
  const d = dom()
  function Probe({ skip }: { skip: boolean }) {
    const skipped = useQuery(status(99), { skip })
    const absent = useQuery(skip ? null : status(1))
    const [job, check] = useQueries([q.jobs.get(1), status(1)])
    return (
      <div className='status'>{`${job?.status}:${check.status}:${String(skipped)}:${absent?.status ?? 'absent'}`}</div>
    )
  }
  d.render(
    <App>
      <Suspense fallback={<div>Loading</div>}>
        <Probe skip />
      </Suspense>
    </App>,
  )
  await d.flush()
  t.is(d.$('.status')?.textContent, 'cached:checked:undefined:absent')
  t.is(calls, 1)
  d.unmount()
})

it('parallel cold sibling reads commit beyond the abandoned-read budget', async t => {
  for (const count of [21, 40]) {
    const { App, figbird, adapter } = app()
    adapter.call = async () => ({ id: 1, status: 'done' })
    adapter.get = async (_service, id) => ({ data: { id, status: 'done' } })
    const d = dom()
    let renders = 0
    class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
      override state = { failed: false }
      static getDerivedStateFromError() {
        return { failed: true }
      }
      override render() {
        return this.state.failed ? (
          <div className='loop'>Render budget exceeded</div>
        ) : (
          this.props.children
        )
      }
    }
    function Sibling({ id }: { id: number }) {
      if (++renders > 400) throw new Error('Suspense retry loop')
      const value = useQuery(q.jobs.getCheck({ id }))
      return <span className='sibling'>{value?.status}</span>
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
    t.is(d.$all('.sibling').length, count)
    t.falsy(d.$('.loop'))
    d.unmount()
    figbird.dispose()
  }
})

it('custom q: boundary retries recover with prepare or non-Suspense holders', async t => {
  for (const holder of ['prepare', 'reader']) {
    const { App, figbird, adapter } = app()
    t.teardown(() => figbird.dispose())
    let calls = 0
    adapter.call = async () => {
      calls++
      throw new Error('offline')
    }
    const builder = q.jobs.getCheck({ id: 1 })
    const prepared = holder === 'prepare' ? figbird.prepare(builder) : null
    if (prepared) await t.throwsAsync(prepared.promise, { message: 'offline' })
    class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
      override state = { failed: false }
      static getDerivedStateFromError() {
        return { failed: true }
      }
      override render() {
        return this.state.failed ? <div className='failed'>Failed</div> : this.props.children
      }
    }
    function Holder() {
      return <div className='holder'>{useQueryResult(builder, { suspense: false }).status}</div>
    }
    function Probe() {
      return <div className='ready'>{useQuery(builder)?.status}</div>
    }
    const d = dom({ onCaughtError: () => {} })
    const tree = (key: string) => (
      <App>
        {holder === 'reader' ? <Holder /> : null}
        <Boundary key={key}>
          <Suspense fallback={<div>Loading</div>}>
            <Probe />
          </Suspense>
        </Boundary>
      </App>
    )
    d.render(tree('first'))
    await d.flush()
    t.truthy(d.$('.failed'))
    await d.flush()
    t.is(calls, 1)
    adapter.call = async () => {
      calls++
      return { id: 1, status: 'recovered' }
    }
    d.render(tree('retry'))
    await d.flush()
    t.is(d.$('.ready')?.textContent, 'recovered')
    if (holder === 'reader') t.is(d.$('.holder')?.textContent, 'success')
    t.is(calls, 2)
    d.unmount()
    prepared?.release()
  }
})

it('custom q: releasing a failed preparation does not expire the query that replaced it', async t => {
  const { figbird: original, adapter } = app()
  original.dispose()
  const clock = new TestClock()
  const figbird = new Figbird({ schema, adapter, clock, retry: false, gcTime: 1000 })
  t.teardown(() => figbird.dispose())
  let calls = 0
  adapter.call = async () => {
    calls++
    throw new Error('offline')
  }
  const builder = q.jobs.getCheck({ id: 1 })
  const preparation = figbird.prepare(builder)
  await t.throwsAsync(preparation.promise, { message: 'offline' })
  function Probe() {
    return <span className='status'>{useQuery(builder).status}</span>
  }
  const d = dom({ onCaughtError: () => {} })
  const tree = (key: string) => (
    <FigbirdProvider figbird={figbird}>
      <FailureBoundary key={key}>
        <Suspense fallback={<div className='loading'>Loading</div>}>
          <Probe />
        </Suspense>
      </FailureBoundary>
    </FigbirdProvider>
  )
  d.render(tree('first'))
  await d.flush()
  t.truthy(d.$('.failed'))
  adapter.call = async () => {
    calls++
    return { id: 1, status: 'recovered' }
  }
  d.render(tree('retry'))
  await d.flush()
  t.is(d.$('.status')?.textContent, 'recovered')
  const mounted = figbird.query(builder)

  // The router lets go of the failed navigation's handle after its replacement mounted.
  preparation.release()
  await d.flush(() => clock.advance(5000))
  t.is(figbird.query(builder), mounted)
  t.is(mounted.getSnapshot().status, 'success')
  t.is(calls, 2)
  d.unmount()
})

it('custom q: idle retention does not expire a result a pending boundary has rendered', async t => {
  const { figbird: original, adapter } = app()
  original.dispose()
  const clock = new TestClock()
  const figbird = new Figbird({ schema, adapter, clock, retry: false, gcTime: 1000 })
  t.teardown(() => figbird.dispose())
  const slow = deferred<unknown>()
  const calls: unknown[] = []
  adapter.call = async (_service, method, args) => {
    calls.push(method)
    if (method === 'count') return slow.promise
    return args[0]
  }
  const warm = q.jobs.getCheck({ id: 1 })
  const release = figbird.query(warm).subscribe(() => {})
  await flushTasks()
  release()
  await flushTasks()

  function Warm() {
    return <span className='warm'>{useQuery(warm).id}</span>
  }
  function Slow() {
    return <span className='slow'>{useQuery(q.jobs.count())}</span>
  }
  const d = dom({ onCaughtError: () => {} })
  d.render(
    <FigbirdProvider figbird={figbird}>
      <FailureBoundary>
        <Suspense fallback={<div className='loading'>Loading</div>}>
          <Warm />
          <Slow />
        </Suspense>
      </FailureBoundary>
    </FigbirdProvider>,
  )
  await d.flush()
  t.truthy(d.$('.loading'))
  // The warm result was rendered but cannot subscribe until its sibling settles.
  await d.flush(() => clock.advance(2000))
  await d.flush(() => slow.resolve(7))
  await d.flush()
  t.falsy(d.$('.failed'))
  t.is(d.$('.warm')?.textContent, '1')
  t.is(d.$('.slow')?.textContent, '7')
  t.deepEqual(calls, ['getCheck', 'count'])
  d.unmount()
})
