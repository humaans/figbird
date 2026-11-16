import { RENDER_READ_LEASE_MS } from '../lib/core/renderReadLease'
import test from 'ava'
import { createSchema, Figbird } from '../lib'
import { waitFor } from './helpers'
import { collectEvents, deferred } from './mutation-test-helpers'
import { TestClock } from './clock'
import { createCollector, createRemoteCollector } from '../lib/devtools/collector.js'
import { buildDevtoolsModel } from '../lib/devtools/model.js'
import { buildActivities, buildTraceIndex } from '../lib/devtools/eventModel.js'
import { buildTimelineActivities } from '../lib/devtools/timelineModel.js'

import { app, schema } from './custom-query-helpers'

test('custom q: descriptors are inert and query refs share structurally equal arguments', async t => {
  const { figbird, adapter } = app()
  t.teardown(() => figbird.dispose())
  const gate = deferred<unknown>()
  const calls: Array<[string, string, unknown[]]> = []
  adapter.call = (...args) => {
    calls.push(args)
    return gate.promise
  }
  const input = { id: 1 }
  const builder = figbird.q.jobs.getCheck(input, undefined)
  t.is(calls.length, 0)
  const first = figbird.query(builder)
  const second = figbird.query(figbird.q('jobs').getCheck({ id: 1 }, undefined))
  t.is(first, second)
  const ready = first.suspensePromise()
  t.is(first.suspensePromise(), ready)
  t.deepEqual(calls, [['api/jobs', 'getCheck', [input, undefined]]])
  t.is(calls[0]?.[2][0], input)
  const result = { id: 1, status: 'done' }
  gate.resolve(result)
  await ready
  t.is(first.getSnapshot().data, result)
  t.is(calls.length, 1)
  t.like(first.getSnapshot(), { status: 'success', isFetching: false })
})

test('custom q: mutation activity and cached entity queries remain unchanged', async t => {
  const { figbird, feathers } = app()
  t.teardown(() => figbird.dispose())
  const list = figbird.query(figbird.q.jobs.all())
  const detail = figbird.query(figbird.q.jobs.get(1))
  t.teardown(list.subscribe(() => {}))
  t.teardown(detail.subscribe(() => {}))
  await waitFor(
    () => list.getSnapshot().status === 'success' && detail.getSnapshot().status === 'success',
    'cached queries',
  )
  const beforeList = list.getSnapshot()
  const beforeDetail = detail.getSnapshot()
  const cache = figbird.inspectCache()
  const events = collectEvents(figbird, '')
  const gate = deferred<unknown>()
  feathers.service('api/jobs').getCheck = () => gate.promise
  const ref = figbird.query(figbird.q.jobs.getCheck({ id: 1 }))
  const ready = ref.suspensePromise()
  t.deepEqual(figbird.mutating.getSnapshot(), [])
  await Promise.resolve()
  t.deepEqual(
    events.map(event => event.kind),
    ['read:start'],
  )
  gate.resolve({ id: 1, status: 'different' })
  await ready
  t.is(list.getSnapshot(), beforeList)
  t.is(detail.getSnapshot(), beforeDetail)
  t.deepEqual(figbird.inspectCache(), cache)
  t.deepEqual(
    events.map(event => event.kind),
    ['read:start', 'read:end'],
  )
  t.like(events[0], { queryId: ref.hash(), serviceName: 'api/jobs', method: 'getCheck' })
})

test('custom q: refetch keeps previous data and exposes background errors', async t => {
  const { figbird, feathers } = app()
  t.teardown(() => figbird.dispose())
  feathers.service('api/jobs').getCheck = async () => ({ id: 1, status: 'first' })
  const ref = figbird.query(figbird.q.jobs.getCheck({ id: 1 }))
  t.teardown(ref.subscribe(() => {}))
  await ref.suspensePromise()
  const result = ref.getSnapshot().data
  const gate = deferred<unknown>()
  feathers.service('api/jobs').getCheck = () => gate.promise
  ref.refetch()
  t.like(ref.getSnapshot(), { status: 'success', data: result, isFetching: true })
  gate.reject(new Error('offline'))
  await waitFor(() => !ref.getSnapshot().isFetching, 'background error')
  t.like(ref.getSnapshot(), {
    status: 'success',
    data: result,
    isFetching: false,
    error: { message: 'offline' },
  })
  feathers.service('api/jobs').getCheck = async () => ({ id: 1, status: 'second' })
  figbird.refetch('jobs')
  await waitFor(
    () => ref.getSnapshot().status === 'success' && !ref.getSnapshot().isFetching,
    'manual refetch',
  )
  t.like(ref.getSnapshot(), { data: { status: 'second' }, error: null })
})

test('custom q: different keys resolve independently out of order', async t => {
  const { figbird, adapter } = app()
  t.teardown(() => figbird.dispose())
  const first = deferred<unknown>()
  const second = deferred<unknown>()
  let calls = 0
  adapter.call = () => (++calls === 1 ? first.promise : second.promise)
  const a = figbird.query(figbird.q.jobs.getCheck({ id: 1 }))
  const b = figbird.query(figbird.q.jobs.getCheck({ id: 2 }))
  const pa = a.suspensePromise()
  const pb = b.suspensePromise()
  second.resolve({ id: 2, status: 'second' })
  await pb
  t.like(b.getSnapshot(), { data: { status: 'second' } })
  t.is(a.getSnapshot().status, 'loading')
  first.resolve({ id: 1, status: 'first' })
  await pa
  t.like(a.getSnapshot(), { data: { status: 'first' } })
  t.is(calls, 2)
})

test('custom q: errors use query state and the configured retry policy', async t => {
  const { adapter } = app()
  const clock = new TestClock()
  const figbird = new Figbird({ schema, adapter, clock, retry: 1, retryDelay: 10 })
  t.teardown(() => figbird.dispose())
  let calls = 0
  adapter.call = async () => {
    if (++calls === 1) throw new Error('temporary')
    return { id: 1, status: 'retried' }
  }
  const ref = figbird.query(figbird.q.jobs.getCheck({ id: 1 }))
  const ready = ref.suspensePromise()
  await clock.advance(9)
  t.is(calls, 1)
  t.is(ref.getSnapshot().status, 'loading')
  await clock.advance(1)
  await ready
  t.is(calls, 2)
  t.like(ref.getSnapshot(), { data: { status: 'retried' } })
  t.deepEqual(figbird.mutating.getSnapshot(), [])
})

test('custom q: synchronous failures reject Suspense and retry=false sends once', async t => {
  const { figbird, adapter } = app()
  t.teardown(() => figbird.dispose())
  let calls = 0
  adapter.call = () => {
    calls++
    throw new Error('bad request')
  }
  const ref = figbird.query(figbird.q.jobs.getCheck({ id: 1 }))
  await t.throwsAsync(ref.suspensePromise(), { message: 'bad request' })
  t.is(calls, 1)
  t.like(ref.getSnapshot(), { status: 'error', error: { message: 'bad request' } })
  ref.releaseColdStart()
  await Promise.resolve()
  t.not(figbird.query(figbird.q.jobs.getCheck({ id: 1 })), ref)
})

test('custom q: primitives, null, undefined, and arrays remain opaque results', async t => {
  const { figbird, adapter } = app()
  t.teardown(() => figbird.dispose())
  const values = [null, undefined, 0, false, '', [{ id: 1, status: 'opaque' }]]
  for (const [index, value] of values.entries()) {
    adapter.call = async () => value
    const ref = figbird.query(figbird.q.jobs.getCheck({ id: index }))
    await ref.suspensePromise()
    t.is(ref.getSnapshot().status, 'success')
    t.true(Object.is(ref.getSnapshot().data, value))
  }
  t.deepEqual(figbird.inspectCache(), [])
})

test('custom q: cache identity distinguishes method, argument count, undefined, null and object properties', t => {
  const { figbird } = app()
  t.teardown(() => figbird.dispose())
  const builders = [
    figbird.q.jobs.getCheck({ id: 1 }),
    figbird.q.jobs.getCheck({ id: 1 }, undefined),
    figbird.q.jobs.getCheck({ id: 1 }, null),
    figbird.q.jobs.getCheck({ id: 1 }, {}),
    figbird.q.jobs.getCheck({ id: 1 }, { value: undefined }),
    figbird.q.jobs.getCheck({ id: 1 }, ['undefined']),
    figbird.q.jobs.count(),
  ]
  t.is(new Set(builders.map(builder => builder.hash())).size, builders.length)
  t.is(
    figbird.q.jobs.getCheck({ id: 1 }, { a: 1, b: 2 }).hash(),
    figbird.q.jobs.getCheck({ id: 1 }, { b: 2, a: 1 }).hash(),
  )
  t.not(
    figbird.q.jobs.getCheck({ id: 1 }, { query: { $sort: { first: 1, second: -1 } } }).hash(),
    figbird.q.jobs.getCheck({ id: 1 }, { query: { $sort: { second: -1, first: 1 } } }).hash(),
  )
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  t.throws(() => figbird.q.jobs.getCheck({ id: 1 }, cyclic), { message: /arguments/ })
  t.throws(() => figbird.q.jobs.getCheck({ id: 1 }, () => {}), { message: /arguments/ })
})

test('custom q: preparation, staleness and idle retention share the ordinary query contract', async t => {
  const { adapter } = app()
  const clock = new TestClock()
  const figbird = new Figbird({ schema, adapter, clock, staleTime: 100, gcTime: 200, retry: false })
  t.teardown(() => figbird.dispose())
  let calls = 0
  adapter.call = async () => ({ id: 1, status: String(++calls) })
  const builder = figbird.q.jobs.getCheck({ id: 1 })
  const preparation = figbird.prepare(builder)
  await preparation.promise
  const ref = figbird.query(builder)
  const unsubscribe = ref.subscribe(() => {})
  preparation.release()
  t.is(calls, 1)
  unsubscribe()
  await Promise.resolve()
  await clock.advance(99)
  t.is(figbird.query(builder), ref)
  const release = ref.subscribe(() => {})
  t.is(calls, 1)
  release()
  await clock.advance(101)
  const releaseStale = ref.subscribe(() => {})
  await waitFor(() => !ref.getSnapshot().isFetching, 'stale query revalidation')
  t.is(calls, 2)
  releaseStale()
  await Promise.resolve()
  await clock.advance(200)
  t.not(figbird.query(builder), ref)
})

test('custom q: disposal blocks new work and late responses cannot resurrect cached data', async t => {
  const { figbird, adapter } = app()
  const gate = deferred<unknown>()
  let calls = 0
  adapter.call = () => {
    calls++
    return gate.promise
  }
  const builder = figbird.q.jobs.getCheck({ id: 1 })
  const ref = figbird.query(builder)
  const rejection = t.throwsAsync(ref.suspensePromise(), { message: /disposed/ })
  figbird.dispose()
  await rejection
  t.throws(() => ref.refetch(), { message: /disposed/ })
  t.throws(() => figbird.query(builder), { message: /disposed/ })
  gate.resolve({ id: 1, status: 'late' })
  await Promise.resolve()
  t.is(calls, 1)
  t.deepEqual(figbird.inspect(), [])
})

test('custom q: schema mismatch is rejected before transport', t => {
  const { figbird } = app()
  t.teardown(() => figbird.dispose())
  const other = createSchema({ services: schema.services })
  const foreign = new Figbird({ schema: other, adapter: figbird.adapter })
  t.teardown(() => foreign.dispose())
  t.throws(() => figbird.query(foreign.q.jobs.getCheck({ id: 1 })), { message: /different schema/ })
})

test('custom q: devtools identifies real custom queries and keeps their results out of entity cache', async t => {
  const { figbird, adapter } = app()
  t.teardown(() => figbird.dispose())
  adapter.call = async () => ({ id: 1, status: 'done' })
  const collector = createCollector(figbird)
  collector.start()
  t.teardown(() => collector.stop())
  const ref = figbird.query(figbird.q.jobs.getCheck({ id: 1 }))
  t.teardown(ref.subscribe(() => {}))
  await ref.suspensePromise()
  await Promise.resolve()
  const snapshot = collector.getSnapshot()
  t.like(snapshot.queries[0], {
    queryId: ref.hash(),
    method: 'getCheck',
    custom: true,
    data: { status: 'done' },
    fetchCount: 1,
  })
  const activities = buildActivities(snapshot.events, buildTraceIndex(snapshot.events))
  t.like(activities[0], { kind: 'custom read', queryId: ref.hash(), status: 'success' })
  const timeline = buildTimelineActivities(
    snapshot,
    buildDevtoolsModel(snapshot),
    performance.now(),
  )
  t.like(timeline[0], { kind: 'read', queryId: ref.hash(), status: 'success' })
  t.deepEqual(snapshot.writes, [])
  t.deepEqual(figbird.inspectCache(), [])
  t.like(figbird.explain(figbird.q.jobs.getCheck({ id: 1 })).nodes[0], {
    kind: 'custom',
    realtime: 'manual',
  })
})

test('custom q: clearing the timeline keeps pending reads visible through completion', t => {
  const collector = createRemoteCollector()
  collector.ingest({
    events: [
      {
        kind: 'read:start',
        readId: 1,
        serviceName: 'jobs',
        method: 'getCheck',
        timestamp: Date.now() - 100,
      },
    ],
  })
  collector.clearTimeline()
  const activities = () => {
    const s = collector.getSnapshot()
    return buildTimelineActivities(s, buildDevtoolsModel(s), performance.now())
  }
  t.is(activities()[0]?.status, 'pending')
  collector.ingest({
    events: [
      {
        kind: 'read:end',
        readId: 1,
        serviceName: 'jobs',
        method: 'getCheck',
        durationMs: 120,
        timestamp: Date.now() + 20,
      },
    ],
  })
  t.is(activities()[0]?.status, 'success')
})

test('custom q: results are snapshots with no realtime subscriptions or automatic invalidation', async t => {
  const { figbird, adapter, feathers } = app()
  t.teardown(() => figbird.dispose())
  let subscriptions = 0
  let calls = 0
  adapter.subscribe = () => {
    subscriptions++
    return () => {}
  }
  adapter.call = async () => {
    calls++
    return { id: 1, status: 'opaque' }
  }
  const ref = figbird.query(figbird.q.jobs.getCheck({ id: 1 }))
  t.teardown(ref.subscribe(() => {}))
  await ref.suspensePromise()
  const before = ref.getSnapshot()
  feathers.service('api/jobs').emit('patched', { id: 1, status: 'event' })
  await Promise.resolve()
  t.is(ref.getSnapshot(), before)
  t.is(subscriptions, 0)
  t.is(calls, 1)
})

test('custom q: prefetch is idempotent and preparation adopts the warmed result', async t => {
  const { adapter } = app()
  const clock = new TestClock()
  const figbird = new Figbird({ schema, adapter, clock, staleTime: 0, retry: false })
  t.teardown(() => figbird.dispose())
  let calls = 0
  adapter.call = async () => ({ id: 1, status: String(++calls) })
  const builder = figbird.q.jobs.getCheck({ id: 1 })
  figbird.prefetch(builder, { staleTime: 100 })
  figbird.prefetch(builder, { staleTime: 100 })
  await clock.advance(0)
  t.is(calls, 1)
  const prepared = figbird.prepare(builder)
  await prepared.promise
  const ref = figbird.query(builder)
  t.teardown(ref.subscribe(() => {}))
  prepared.release()
  t.is(calls, 1)
})

test('custom q: abandoned Suspense results are bounded while parallel groups are retained together', async t => {
  const { figbird: original, adapter } = app()
  original.dispose()
  const clock = new TestClock()
  const figbird = new Figbird({ schema, adapter, clock, retry: false })
  t.teardown(() => figbird.dispose())
  adapter.call = async () => ({ id: 1, status: 'done' })
  for (let id = 0; id < 25; id++)
    await figbird.query(figbird.q.jobs.getCheck({ id })).suspensePromise()
  t.is(figbird.inspect().length, 25)
  await clock.advance(RENDER_READ_LEASE_MS)
  t.is(figbird.inspect().length, 20)
  const group = {}
  const refs = Array.from({ length: 25 }, (_, id) => {
    const ref = figbird.query(figbird.q.jobs.getCheck({ id: id + 100 }))
    ref.setColdReadGroup(group)
    return ref
  })
  await Promise.all(refs.map(ref => ref.suspensePromise()))
  t.true(refs.every(ref => ref.getSnapshot().status === 'success'))
  for (let id = 100; id < 125; id++)
    t.is(figbird.query(figbird.q.jobs.getCheck({ id })), refs[id - 100]!)
})

test('custom q: an invalidation during a pending read runs one trailing fetch', async t => {
  const { figbird, adapter } = app()
  t.teardown(() => figbird.dispose())
  const first = deferred<unknown>()
  const second = deferred<unknown>()
  let calls = 0
  adapter.call = () => (++calls === 1 ? first.promise : second.promise)
  const ref = figbird.query(figbird.q.jobs.getCheck({ id: 1 }))
  const ready = ref.suspensePromise()
  figbird.refetch('jobs')
  ref.refetch()
  first.resolve({ id: 1, status: 'before mutation' })
  await waitFor(() => calls === 2, 'trailing custom read')
  second.resolve({ id: 1, status: 'after mutation' })
  await ready
  await waitFor(() => !ref.getSnapshot().isFetching, 'trailing completion')
  t.like(ref.getSnapshot(), { data: { status: 'after mutation' } })
  t.is(calls, 2)
})

test('custom q: equal refetch results retain their data reference', async t => {
  const { figbird, adapter } = app()
  t.teardown(() => figbird.dispose())
  adapter.call = async () => ({ id: 1, status: 'same' })
  const ref = figbird.query(figbird.q.jobs.getCheck({ id: 1 }))
  await ref.suspensePromise()
  const before = ref.getSnapshot().data
  ref.refetch()
  await waitFor(() => !ref.getSnapshot().isFetching, 'refetch')
  t.is(ref.getSnapshot().data, before)
})

test('custom q: reads notify inspection subscribers without notifying entity-state subscribers', async t => {
  const { figbird, adapter } = app()
  t.teardown(() => figbird.dispose())
  adapter.call = async () => ({ id: 1, status: 'done' })
  let inspected = 0
  t.teardown(figbird.subscribeToInspectionChanges(() => inspected++))
  let changes = 0
  t.teardown(figbird.subscribeToStateChanges(() => changes++))
  const before = figbird.getState()
  await figbird.query(figbird.q.jobs.getCheck({ id: 1 })).suspensePromise()
  await Promise.resolve()
  t.is(changes, 0)
  t.true(inspected > 0)
  t.is(figbird.getState(), before)
})

test('custom q: adapter.call is preferred and legacy adapter.mutate remains supported', async t => {
  const { figbird, adapter } = app()
  t.teardown(() => figbird.dispose())
  let calls = 0
  let legacy = 0
  adapter.call = async () => {
    calls++
    return { id: 1, status: 'call' }
  }
  adapter.mutate = async () => {
    legacy++
    return { id: 2, status: 'legacy' }
  }
  await figbird.query(figbird.q.jobs.getCheck({ id: 1 })).suspensePromise()
  t.is(calls, 1)
  t.is(legacy, 0)
  Reflect.set(adapter, 'call', undefined)
  const ref = figbird.query(figbird.q.jobs.getCheck({ id: 2 }))
  await ref.suspensePromise()
  t.like(ref.getSnapshot(), { data: { status: 'legacy' } })
  t.is(legacy, 1)
})

test('custom q: a refresh during retry backoff is retained until a fresh trailing read', async t => {
  const { figbird: original, adapter } = app()
  original.dispose()
  const clock = new TestClock()
  const figbird = new Figbird({ schema, adapter, clock, retry: 1, retryDelay: 10 })
  t.teardown(() => figbird.dispose())
  let calls = 0
  adapter.call = async () => {
    calls++
    if (calls === 1) throw new Error('temporary')
    return { id: 1, status: calls === 2 ? 'before mutation' : 'after mutation' }
  }
  const ref = figbird.query(figbird.q.jobs.getCheck({ id: 1 }))
  const ready = ref.suspensePromise()
  await clock.advance(0)
  figbird.refetch('jobs')
  await clock.advance(10)
  await ready
  t.is(calls, 3)
  t.like(ref.getSnapshot(), { data: { status: 'after mutation' }, isFetching: false })
})

test('a refetch queued behind a failing cold read still settles the Suspense read', async t => {
  for (const kind of ['custom', 'entity']) {
    const { figbird, adapter } = app()
    t.teardown(() => figbird.dispose())
    const first = deferred<{ id: number; status: string }>()
    let calls = 0
    const run = () => (++calls === 1 ? first.promise : Promise.resolve({ id: 1, status: 'ok' }))
    adapter.call = run
    adapter.get = async () => ({ data: await run() })
    const ref = figbird.query(
      kind === 'custom' ? figbird.q.jobs.getCheck({ id: 1 }) : figbird.q.jobs.get(1),
    )
    // What a suspended render holds: the promise React waits on before rendering again.
    const read = ref.suspensePromise()
    figbird.refetch('jobs')
    first.reject(new Error('offline'))

    const outcome = await Promise.race([
      read.then(
        () => 'settled',
        () => 'settled',
      ),
      new Promise(resolve => setTimeout(() => resolve('still pending'), 100)),
    ])
    t.is(outcome, 'settled', kind)
    t.is(calls, 2, kind)
    t.like(ref.getSnapshot(), { status: 'success', data: { id: 1, status: 'ok' } }, kind)
  }
})
