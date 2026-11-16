import test from 'ava'
import { createSchema, Figbird, service } from '../lib'
import { createTestApp, waitFor } from './helpers'
import { collectEvents, deferred } from './mutation-test-helpers'
import { createCollector, createRemoteCollector } from '../lib/devtools/collector.js'
import { buildDevtoolsModel } from '../lib/devtools/model.js'
import { buildActivities, buildTraceIndex, eventPayload } from '../lib/devtools/eventModel.js'
import { decodeEvent } from '../extensions/src/protocol.js'
import { buildTimelineActivities } from '../lib/devtools/timelineModel.js'

const schema = createSchema({
  services: {
    jobs: service<{
      item: { id: number; status: string }
      methods: {
        getCheck: (
          input: { id: number },
          extra?: unknown,
        ) => Promise<{ id: number; status: string }>
      }
    }>().at('api/jobs'),
  },
})

function app() {
  return createTestApp(schema, {
    'api/jobs': { data: { 1: { id: 1, status: 'cached' } } },
  })
}

test('r: uses the adapter once, preserving arguments and bypassing mutations while pending', async t => {
  const { figbird, adapter } = app()
  const events = collectEvents(figbird, '')
  const gate = deferred<unknown>()
  const calls: Array<[string, string, unknown[]]> = []
  adapter.mutate = (...args) => {
    calls.push(args)
    return gate.promise
  }
  let activityChanges = 0
  const unsubscribe = figbird.mutating.subscribe(() => activityChanges++)
  t.teardown(unsubscribe)
  t.teardown(() => figbird.dispose())
  const input = { id: 1 }
  const pending = figbird.r.jobs.getCheck(input, undefined)
  t.deepEqual(figbird.mutating.getSnapshot(), [])
  await Promise.resolve()
  t.deepEqual(
    events.map(event => event.kind),
    ['read:start'],
  )
  t.deepEqual(calls, [['api/jobs', 'getCheck', [input, undefined]]])
  t.is(calls[0]?.[2][0], input)
  const result = { id: 1, status: 'done' }
  gate.resolve(result)
  t.is(await pending, result)
  t.is(activityChanges, 0)
  t.is(calls.length, 1)
  t.deepEqual(
    events.map(event => event.kind),
    ['read:start', 'read:end'],
  )
  t.like(events[1], { serviceName: 'api/jobs', method: 'getCheck', readId: 1 })
  t.true(events[1]?.kind === 'read:end' && events[1].durationMs >= 0)
})

test('r: async and synchronous transport errors reject without retry or mutation activity', async t => {
  for (const synchronous of [false, true]) {
    const { adapter } = app()
    const figbird = new Figbird({ schema, adapter, retry: 3 })
    t.teardown(() => figbird.dispose())
    const events = collectEvents(figbird, '')
    const error = new Error('status unavailable')
    let calls = 0
    adapter.mutate = () => {
      calls++
      if (synchronous) throw error
      return Promise.reject(error)
    }
    t.is(await t.throwsAsync(figbird.r.jobs.getCheck({ id: 1 })), error)
    t.is(calls, 1)
    t.deepEqual(figbird.mutating.getSnapshot(), [])
    t.deepEqual(
      events.map(event => event.kind),
      ['read:start', 'read:error'],
    )
    t.like(events[1], { error, readId: 1, serviceName: 'api/jobs', method: 'getCheck' })
  }
})

test('r: entity-shaped responses leave cached queries and entities unchanged', async t => {
  const { figbird, feathers } = app()
  t.teardown(() => figbird.dispose())
  const list = figbird.query(figbird.q.jobs.all())
  const detail = figbird.query(figbird.q.jobs.get(1))
  const unsubscribeList = list.subscribe(() => {})
  const unsubscribeDetail = detail.subscribe(() => {})
  t.teardown(unsubscribeList)
  t.teardown(unsubscribeDetail)
  await waitFor(
    () => list.getSnapshot()?.status === 'success' && detail.getSnapshot()?.status === 'success',
    'cached queries',
  )
  const listBefore = list.getSnapshot()
  const detailBefore = detail.getSnapshot()
  const cacheBefore = figbird.inspectCache()
  const events = collectEvents(figbird, '')
  feathers.service('api/jobs').getCheck = async () => ({ id: 1, status: 'different' })
  t.deepEqual(await figbird.r.jobs.getCheck({ id: 1 }), { id: 1, status: 'different' })
  t.is(list.getSnapshot(), listBefore)
  t.is(detail.getSnapshot(), detailBefore)
  t.deepEqual(figbird.inspectCache(), cacheBefore)
  t.deepEqual(
    events.map(event => event.kind),
    ['read:start', 'read:end'],
  )
})

test('r: identical concurrent requests resolve independently out of order', async t => {
  const { figbird, feathers } = app()
  t.teardown(() => figbird.dispose())
  const first = deferred<unknown>()
  const second = deferred<unknown>()
  let calls = 0
  feathers.service('api/jobs').getCheck = () => (++calls === 1 ? first.promise : second.promise)
  const events = collectEvents(figbird, 'read:')
  const a = figbird.r.jobs.getCheck({ id: 1 })
  const b = figbird.r.jobs.getCheck({ id: 1 })
  second.resolve({ id: 1, status: 'second' })
  t.is((await b).status, 'second')
  first.resolve({ id: 1, status: 'first' })
  t.is((await a).status, 'first')
  t.is(calls, 2)
  t.deepEqual(
    events.map(event => ('readId' in event ? event.readId : undefined)),
    [1, 2, 2, 1],
  )
})

test('r: stable service handles and protocol probes never dispatch requests', async t => {
  const { figbird, adapter } = app()
  t.teardown(() => figbird.dispose())
  let calls = 0
  adapter.mutate = async () => {
    calls++
    return null
  }
  t.is(figbird.r, figbird.r)
  t.is(figbird.r.jobs, figbird.r('jobs'))
  t.is(await figbird.r.jobs, figbird.r.jobs)
  t.is(await figbird.r, figbird.r)
  t.notThrows(() => JSON.stringify(figbird.r.jobs))
  t.notThrows(() => JSON.stringify(figbird.r))
  t.is(calls, 0)
})

test('r: devtools shows independent custom reads with lifecycle, arguments and errors', async t => {
  const { figbird, feathers } = app()
  t.teardown(() => figbird.dispose())
  const collector = createCollector(figbird)
  collector.start()
  t.teardown(() => collector.stop())
  const gate = deferred<unknown>()
  feathers.service('api/jobs').getCheck = () => gate.promise
  const pending = figbird.r.jobs.getCheck({ id: 1 })
  await Promise.resolve()
  const snapshot = () => collector.getSnapshot()
  const activities = () => buildActivities(snapshot().events, buildTraceIndex(snapshot().events))
  t.like(activities()[0], {
    kind: 'custom read',
    subject: 'api/jobs',
    operation: 'getCheck',
    status: 'pending',
  })
  t.deepEqual(eventPayload(activities()[0]!.representative.event), [{ id: 1 }])
  gate.resolve({ id: 1, status: 'done' })
  await pending
  feathers.service('api/jobs').getCheck = () => Promise.reject(new Error('offline'))
  await t.throwsAsync(figbird.r.jobs.getCheck({ id: 2 }))
  const current = snapshot()
  const reads = buildTimelineActivities(current, buildDevtoolsModel(current), Date.now())
  t.is(reads.length, 2)
  t.true(
    reads.every(
      read => read.kind === 'read' && read.queryId === undefined && read.durationMs !== undefined,
    ),
  )
  t.deepEqual(reads.map(read => read.status).sort(), ['error', 'success'])
  t.true(reads.find(read => read.error)?.detail.includes('offline'))
  t.deepEqual(current.queries, [])
  t.deepEqual(current.writes, [])
})

test('r: custom read timeline history is bounded independently of the event log', t => {
  const collector = createRemoteCollector({ eventLimit: 1, timelineLimit: 2 })
  const events: import('../lib').FigbirdEvent[] = []
  const timestamp = Date.now() + 10
  for (let readId = 1; readId <= 3; readId++) {
    events.push(
      {
        kind: 'read:start',
        readId,
        serviceName: 'jobs',
        method: 'getCheck',
        timestamp: timestamp + readId,
      },
      {
        kind: 'read:end',
        readId,
        serviceName: 'jobs',
        method: 'getCheck',
        durationMs: 1,
        timestamp: timestamp + readId + 1,
      },
    )
  }
  collector.ingest({ events })
  const snapshot = collector.getSnapshot()
  t.is(snapshot.events.length, 1)
  t.deepEqual(
    snapshot.timeline.reads?.map(read => read.readId),
    [2, 3],
  )
  t.is(snapshot.timeline.evictedCount, 1)
  collector.clearEvents()
  t.is(collector.getSnapshot().timeline.reads?.length, 2)
  collector.clearTimeline()
  t.deepEqual(collector.getSnapshot().timeline.reads, [])
})

test('r: extension decodes structured custom read failures', t => {
  const event = decodeEvent({
    kind: 'read:error',
    readId: 1,
    serviceName: 'jobs',
    method: 'getCheck',
    durationMs: 12,
    error: {
      name: 'ValidationError',
      message: 'invalid job',
      details: { name: 'ValidationError', message: 'invalid job', code: 422 },
    },
  })
  t.true(event.kind === 'read:error' && event.error instanceof Error)
  if (event.kind === 'read:error') t.like(event.error, { message: 'invalid job', code: 422 })
})
