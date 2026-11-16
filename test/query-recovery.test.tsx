import { Component, Suspense, useLayoutEffect, useState, type ReactNode } from 'react'
import { createHooks, Figbird, FigbirdProvider, type FeathersAdapter } from '../lib'
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
