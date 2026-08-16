import test from 'ava'
import { createSchema, service, type FigbirdEvent } from '../lib/index.js'
import { FigbirdEventEmitter } from '../lib/core/events.js'
import {
  FigbirdDevtoolsPanel,
  type DevtoolsInspectionController,
} from '../lib/devtools/Devtools.js'
import {
  createCollector,
  type Collector,
  type DevtoolsSnapshot,
  type FigbirdLikeForDevtools,
  type QueryRecord,
} from '../lib/devtools/collector.js'
import { ExtensionInspectionSession } from '../extensions/src/inspection.js'
import { inspectQueryArea } from '../extensions/src/inspectionPage.js'
import { ExtensionSession } from '../extensions/src/remote.js'
import { buildDevtoolsModel } from '../lib/devtools/model.js'
import { buildActivities, buildTraceIndex, eventPayload } from '../lib/devtools/eventModel.js'
import { buildTimelineActivities } from '../lib/devtools/timelineModel.js'
import { createTestApp, dom } from './helpers.js'

interface Note {
  id: number
  content: string
}

const schema = createSchema({
  services: {
    notes: service<{ item: Note }>(),
  },
})

function app() {
  return createTestApp(schema, {
    notes: {
      data: {
        1: { id: 1, content: 'hello' },
        2: { id: 2, content: 'world' },
      },
    },
  })
}

function inspectedQuery(
  queryId: string,
  overrides: Partial<ReturnType<FigbirdLikeForDevtools['inspect']>[number]> = {},
): ReturnType<FigbirdLikeForDevtools['inspect']>[number] {
  return {
    queryId,
    generation: 1,
    serviceName: 'notes',
    method: 'find',
    query: {},
    classification: 'local-exact',
    status: 'success',
    isFetching: false,
    itemCount: 1,
    fetchedAt: Date.now(),
    subscriberCount: 0,
    fetchCount: 0,
    errorCount: 0,
    totalDurationMs: 0,
    ...overrides,
  }
}

function queryRecord(
  queryId: string,
  serviceName: string,
  overrides: Partial<QueryRecord> = {},
): QueryRecord {
  return {
    queryId,
    generation: 1,
    present: true,
    serviceName,
    method: 'find',
    query: {},
    classification: 'local-exact',
    status: 'success',
    isFetching: false,
    itemCount: 1,
    fetchedAt: Date.now(),
    subscriberCount: 1,
    fetchCount: 1,
    errorCount: 0,
    totalDurationMs: 5,
    lastDurationMs: 5,
    spans: [],
    realtimeSeen: 0,
    reconciles: 0,
    ...overrides,
  }
}

function inspectedRow(record: QueryRecord): ReturnType<FigbirdLikeForDevtools['inspect']>[number] {
  const result: Partial<QueryRecord> = { ...record }
  delete result.present
  delete result.spans
  delete result.realtimeSeen
  delete result.reconciles
  delete result.lastError
  return result as ReturnType<FigbirdLikeForDevtools['inspect']>[number]
}

function relationalGroup(
  key: string,
  rootQueryId: string,
  path: string,
  nestedQueryId: string,
): DevtoolsSnapshot['relational'][number] {
  return {
    key,
    service: 'issues',
    ast: {
      service: 'issues',
      kind: 'find',
      query: {},
      cardinality: 'many',
      related: {
        [path]: {
          service: path,
          kind: 'find',
          query: {},
          cardinality: 'many',
          related: {},
        },
      },
    },
    nodes: [
      { path: '(root)', queryId: rootQueryId },
      { path, queryId: nestedQueryId },
    ],
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('collector records fetch spans and keeps event and timeline history independent', async t => {
  const { figbird, feathers } = app()
  const collector = createCollector(figbird)
  collector.start()

  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  const unsub = ref.subscribe(() => {})

  await sleep(70)
  feathers.service('notes').emit('patched', { id: 1, content: 'changed' })
  await sleep(70)

  const snapshot = collector.getSnapshot()
  const row = snapshot.queries.find(query => query.serviceName === 'notes')
  t.truthy(row)
  t.is(row?.fetchCount, 1)
  t.is(row?.spans.length, 1)
  t.is(row?.fetchHistory?.length, 1)
  t.true(row?.lastDurationMs !== undefined)
  t.true(snapshot.events.length > 0)
  t.true(snapshot.events.every(event => event.wallAt !== undefined))
  t.true(snapshot.events.every(event => event.wallAt === event.event.timestamp))
  t.true(snapshot.timeline.startedAt > 0)
  t.true(snapshot.timeline.realtime.length > 0)
  t.deepEqual(snapshot.timeline.laneOrder, [])
  t.is(collector.getSnapshot(), snapshot)

  collector.clearEvents()
  const clearedEvents = collector.getSnapshot()
  t.is(clearedEvents.events.length, 0)
  t.is(clearedEvents.timeline.realtime.length, snapshot.timeline.realtime.length)

  feathers.service('notes').emit('patched', { id: 1, content: 'changed again' })
  await sleep(70)
  const beforeTimelineClear = collector.getSnapshot()
  const beforeTimelineClearRow = beforeTimelineClear.queries.find(
    query => query.serviceName === 'notes',
  )
  t.true(beforeTimelineClear.events.length > 0)

  collector.clearTimeline()
  const clearedTimeline = collector.getSnapshot()
  const clearedRow = clearedTimeline.queries.find(query => query.serviceName === 'notes')
  t.is(clearedTimeline.events.length, beforeTimelineClear.events.length)
  t.true(clearedTimeline.timeline.startedAt >= beforeTimelineClear.timeline.startedAt)
  t.deepEqual(clearedTimeline.timeline.laneOrder, [])
  t.is(clearedTimeline.timeline.realtime.length, 0)
  t.is(clearedRow?.spans.length, 0)
  t.is(clearedRow?.fetchHistory?.length, beforeTimelineClearRow?.fetchHistory?.length)
  t.is(clearedRow?.realtimeSeen, beforeTimelineClearRow?.realtimeSeen)
  t.is(clearedRow?.reconciles, beforeTimelineClearRow?.reconciles)

  unsub()

  feathers.service('notes').setDelay(30)
  const abandoned = figbird.queryDesc(
    { serviceName: 'notes', method: 'find', params: { query: { content: 'slow' } } },
    { fetchPolicy: 'network-only' },
  )
  const abandonedQueryId = abandoned.details().queryId
  const abandon = abandoned.subscribe(() => {})
  abandon()
  await sleep(70)

  const abandonedEvents = collector
    .getSnapshot()
    .events.filter(
      item =>
        'queryId' in item.event &&
        item.event.queryId === abandonedQueryId &&
        item.event.kind.startsWith('fetch:'),
    )
  t.deepEqual(
    abandonedEvents.map(item => item.event.kind),
    ['fetch:start', 'fetch:end'],
  )
  const abandonedRow = collector
    .getSnapshot()
    .queries.find(query => query.queryId === abandonedQueryId)
  t.false(abandonedRow?.present ?? true)
  t.is(abandonedRow?.fetchCount, 1)
  t.is(abandonedRow?.spans.length, 1)

  collector.stop()

  const emitter = new FigbirdEventEmitter()
  const unsubscribeExistingListener = emitter.subscribe(() => {})
  emitter.emit({
    kind: 'fetch:end',
    queryId: 'already-finished',
    generation: 1,
    serviceName: 'notes',
    method: 'find',
    durationMs: 10,
    itemCount: 1,
  })
  const lateCollector = createCollector(
    {
      events: emitter,
      inspect: () => [
        inspectedQuery('already-finished', {
          fetchCount: 1,
          lastDurationMs: 10,
          totalDurationMs: 10,
        }),
      ],
    },
    { heartbeatMs: 0 },
  )
  lateCollector.start()
  await Promise.resolve()
  t.is(lateCollector.getSnapshot().queries[0]?.fetchCount, 1)
  lateCollector.stop()
  unsubscribeExistingListener()
})

test('collector heartbeat refreshes snapshots without events', async t => {
  const { figbird } = app()
  const collector = createCollector(figbird, { heartbeatMs: 20 })
  collector.start()
  const unsubscribe = collector.subscribe(() => {})

  const initial = collector.getSnapshot()
  await sleep(60)
  const refreshed = collector.getSnapshot()

  t.not(refreshed, initial)

  unsubscribe()
  collector.stop()
})

test('collector attributes realtime events to active queries on the same service', async t => {
  const { figbird, feathers } = app()
  const collector = createCollector(figbird)
  collector.start()

  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  const unsub = ref.subscribe(() => {})
  await sleep(70)

  feathers.service('notes').emit('patched', { id: 1, content: 'changed' })
  await sleep(70)

  const row = collector.getSnapshot().queries.find(query => query.serviceName === 'notes')
  t.is(row?.realtimeSeen, 1)

  unsub()
  collector.stop()
})

test('collector backfills fetch timing for queries loaded before it starts', async t => {
  const { figbird } = app()

  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  const unsub = ref.subscribe(() => {})
  await sleep(70)

  const collector = createCollector(figbird)
  collector.start()

  const row = collector.getSnapshot().queries.find(query => query.serviceName === 'notes')
  t.truthy(row)
  t.is(row?.fetchCount, 1)
  t.true(row?.lastDurationMs !== undefined)
  t.true(row?.totalDurationMs !== undefined)

  unsub()
  collector.stop()
})

test('collector marks optimistic mutation failures as rolled back writes', async t => {
  const { figbird, feathers } = app()
  const collector = createCollector(figbird)
  collector.start()

  const validationError = Object.assign(new Error('Validation Error'), {
    name: 'ValidationError',
    code: 422,
    issues: [{ name: 'content', reason: 'required' }],
  })
  feathers.service('notes').patch = () => Promise.reject(validationError)

  await t.throwsAsync(figbird.m.notes.patch(1, { content: 'bad' }))
  await sleep(70)

  const snapshot = collector.getSnapshot()
  const mutation = snapshot.writes.find(write => write.type === 'mutation')
  t.truthy(mutation)
  t.is(mutation?.status, 'error')
  t.true(mutation?.rolledBack)
  t.is(mutation?.error, 'Validation Error')
  t.deepEqual(mutation?.errorDetails, {
    name: 'ValidationError',
    message: 'Validation Error',
    code: 422,
    issues: [{ name: 'content', reason: 'required' }],
  })
  t.deepEqual(mutation?.args, [1, { content: 'bad' }])

  const writeActivity = buildTimelineActivities(
    snapshot,
    buildDevtoolsModel(snapshot),
    performance.now(),
  ).find(activity => activity.kind === 'write')
  t.is(writeActivity?.status, 'error')
  t.is(writeActivity?.effect, 'rolled back')
  t.deepEqual(writeActivity?.errorDetails, mutation?.errorDetails)

  const mutationError = snapshot.events.find(item => item.event.kind === 'mutate:error')
  t.deepEqual(mutationError ? eventPayload(mutationError.event) : undefined, mutation?.errorDetails)

  const mutationGroup = buildActivities(snapshot.events, buildTraceIndex(snapshot.events)).find(
    activity => activity.kind === 'mutation',
  )
  t.is(mutationGroup?.status, 'error')
  t.is(mutationGroup?.tone, 'red')

  collector.stop()
})

test('collector bounds inactive query and settled write history', t => {
  let rows: ReturnType<FigbirdLikeForDevtools['inspect']> = []
  let relational: DevtoolsSnapshot['relational'] = []
  const capturedQuery = { value: 'captured' }
  const listeners: {
    state?: () => void
    event?: (event: FigbirdEvent) => void
  } = {}
  const figbird: FigbirdLikeForDevtools = {
    events: {
      subscribe(listener) {
        listeners.event = listener
        return () => {
          delete listeners.event
        }
      },
    },
    inspect: () => rows,
    inspectRelational: () => relational,
    subscribeToStateChanges(listener) {
      listeners.state = () => listener(undefined)
      return () => {
        delete listeners.state
      }
    },
  }
  const collector = createCollector(figbird, {
    heartbeatMs: 0,
    queryHistoryLimit: 2,
    writeLimit: 2,
  })
  collector.start()

  for (let index = 1; index <= 3; index++) {
    rows = [inspectedQuery(`query-${index}`)]
    relational = [relationalGroup(`rq/${index}`, `query-${index}`, 'child', `child-${index}`)]
    listeners.state?.()
    collector.getSnapshot()
  }
  t.is(collector.getSnapshot().queries.length, 2)
  t.deepEqual(
    collector.getSnapshot().relational.map(group => group.key),
    ['rq/2', 'rq/3'],
  )

  rows = [inspectedQuery('live-1'), inspectedQuery('live-2'), inspectedQuery('live-3')]
  relational = [
    relationalGroup('rq/live-1', 'live-1', 'child', 'child-live-1'),
    relationalGroup('rq/live-2', 'live-2', 'child', 'child-live-2'),
    relationalGroup('rq/live-3', 'live-3', 'child', 'child-live-3'),
  ]
  listeners.state?.()
  t.is(collector.getSnapshot().queries.length, 3)
  t.is(collector.getSnapshot().relational.length, 3)

  rows = [inspectedQuery('live-3')]
  relational = [relationalGroup('rq/live-3', 'live-3', 'child', 'child-live-3')]
  listeners.state?.()
  t.is(collector.getSnapshot().queries.length, 2)
  t.is(collector.getSnapshot().relational.length, 2)

  const relationalBeforeTimelineClear = collector.getSnapshot().relational.map(group => group.key)
  collector.clearTimeline()
  t.deepEqual(
    collector.getSnapshot().relational.map(group => group.key),
    relationalBeforeTimelineClear,
  )

  const generationOne = inspectedQuery('live-3', {
    generation: 1,
    query: capturedQuery,
    subscriberCount: 1,
    fetchCount: 2,
    totalDurationMs: 20,
  })
  for (const durationMs of [8, 12]) {
    listeners.event?.({
      kind: 'fetch:start',
      queryId: 'live-3',
      generation: 1,
      serviceName: 'notes',
      method: 'find',
    })
    listeners.event?.({
      kind: 'fetch:end',
      queryId: 'live-3',
      generation: 1,
      serviceName: 'notes',
      method: 'find',
      durationMs,
      itemCount: 1,
    })
  }
  const generationPlan = relationalGroup('rq/live-3', 'live-3', 'child', 'child-live-3')
  generationPlan.ast.query = capturedQuery
  rows = [generationOne]
  relational = [generationPlan]
  listeners.state?.()
  const capturedGeneration = collector
    .getSnapshot()
    .queries.find(query => query.queryId === 'live-3')
  t.deepEqual(capturedGeneration?.query, { value: 'captured' })
  t.deepEqual(
    collector.getSnapshot().relational.find(group => group.key === 'rq/live-3')?.ast.query,
    { value: 'captured' },
  )

  capturedQuery.value = 'changed later'
  rows = []
  relational = []
  listeners.state?.()
  const retainedGeneration = collector
    .getSnapshot()
    .queries.find(query => query.queryId === 'live-3')
  t.false(retainedGeneration?.present ?? true)
  t.is(retainedGeneration?.subscriberCount, 0)

  const staleValidationError = Object.assign(new Error('old generation failed'), {
    name: 'ValidationError',
    code: 422,
    issues: [{ name: 'title', reason: 'required' }],
  })
  listeners.event?.({
    kind: 'realtime',
    serviceName: 'notes',
    type: 'patched',
    itemId: 1,
  })
  collector.getSnapshot()

  rows = [
    inspectedQuery('live-3', {
      generation: 2,
      subscriberCount: 1,
      fetchCount: 1,
      totalDurationMs: 7,
    }),
  ]
  listeners.event?.({
    kind: 'fetch:start',
    queryId: 'live-3',
    generation: 2,
    serviceName: 'notes',
    method: 'find',
  })
  listeners.state?.()
  listeners.event?.({
    kind: 'fetch:end',
    queryId: 'live-3',
    generation: 2,
    serviceName: 'notes',
    method: 'find',
    durationMs: 7,
    itemCount: 1,
  })
  const recreatedGeneration = collector
    .getSnapshot()
    .queries.find(query => query.queryId === 'live-3')
  t.true(recreatedGeneration?.present ?? false)
  t.is(recreatedGeneration?.fetchCount, 3)
  t.is(recreatedGeneration?.totalDurationMs, 27)
  t.is(recreatedGeneration?.realtimeSeen, 0)

  listeners.event?.({
    kind: 'fetch:error',
    queryId: 'live-3',
    generation: 1,
    serviceName: 'notes',
    method: 'find',
    durationMs: 11,
    error: staleValidationError,
  })
  const afterStaleError = collector.getSnapshot().queries.find(query => query.queryId === 'live-3')
  t.is(afterStaleError?.generation, 2)
  t.is(afterStaleError?.status, 'success')
  t.is(afterStaleError?.lastError?.generation, 1)
  t.deepEqual(afterStaleError?.lastError?.details, {
    name: 'ValidationError',
    message: 'old generation failed',
    code: 422,
    issues: [{ name: 'title', reason: 'required' }],
  })
  t.deepEqual(afterStaleError?.spans.at(-1)?.errorDetails, afterStaleError?.lastError?.details)

  for (let mutationId = 1; mutationId <= 3; mutationId++) {
    listeners.event?.({
      kind: 'mutate:start',
      mutationId,
      serviceName: 'notes',
      method: 'patch',
      optimistic: true,
      args: [mutationId, { content: String(mutationId) }],
    })
    listeners.event?.({
      kind: 'mutate:end',
      mutationId,
      serviceName: 'notes',
      method: 'patch',
      durationMs: mutationId,
      optimistic: true,
    })
  }
  t.is(collector.getSnapshot().writes.length, 2)

  collector.clearTimeline()
  t.is(collector.getSnapshot().writes.length, 0)

  for (let mutationId = 4; mutationId <= 6; mutationId++) {
    listeners.event?.({
      kind: 'mutate:start',
      mutationId,
      serviceName: 'notes',
      method: 'patch',
      optimistic: true,
      args: [mutationId, { content: String(mutationId) }],
    })
  }
  t.is(collector.getSnapshot().writes.length, 3)

  listeners.event?.({
    kind: 'mutate:end',
    mutationId: 4,
    serviceName: 'notes',
    method: 'patch',
    durationMs: 4,
    optimistic: true,
  })
  t.is(collector.getSnapshot().writes.length, 2)

  listeners.event?.({
    kind: 'reconcile:started',
    queryId: 'live-3',
    serviceName: 'notes',
  })
  t.is(
    collector.getSnapshot().queries.find(query => query.queryId === 'live-3')?.reconciles,
    1,
    'started reconciliation counts as a refetch',
  )

  const retainedPayload = { content: 'captured' }
  listeners.event?.({
    kind: 'mutate:start',
    mutationId: 7,
    serviceName: 'notes',
    method: 'patch',
    optimistic: true,
    args: [7, retainedPayload],
  })
  retainedPayload.content = 'changed later'
  const retainedWrite = collector.getSnapshot().writes.find(write => write.id === 'mutation:7')
  t.deepEqual(retainedWrite?.args, [7, { content: 'captured' }])
  const retainedEvent = collector
    .getSnapshot()
    .events.find(item => item.event.kind === 'mutate:start' && item.event.mutationId === 7)
  t.false(retainedEvent ? 'args' in retainedEvent.event : true)

  const updatedPayload = { content: 'coalesced' }
  listeners.event?.({
    kind: 'mutate:update',
    mutationId: 7,
    serviceName: 'notes',
    method: 'patch',
    optimistic: true,
    args: [7, updatedPayload],
  })
  updatedPayload.content = 'changed later'
  const updatedWrite = collector.getSnapshot().writes.find(write => write.id === 'mutation:7')
  t.deepEqual(updatedWrite?.args, [7, { content: 'coalesced' }])

  listeners.event?.({
    kind: 'fetch:start',
    queryId: 'live-3',
    generation: 2,
    serviceName: 'notes',
    method: 'find',
    fetchId: 99,
    reason: 'retry',
  })
  const activeSpan = collector
    .getSnapshot()
    .queries.find(query => query.queryId === 'live-3')
    ?.spans.at(-1)
  t.is(activeSpan?.fetchId, 99)
  t.is(activeSpan?.endAt, undefined)
  t.is(activeSpan?.reason, 'retry')
  const timelineClearStartedAt = performance.now()
  collector.clearTimeline()
  listeners.event?.({
    kind: 'fetch:end',
    queryId: 'live-3',
    generation: 2,
    serviceName: 'notes',
    method: 'find',
    fetchId: 99,
    durationMs: 100,
    itemCount: 1,
  })
  const postClearSpan = collector
    .getSnapshot()
    .queries.find(query => query.queryId === 'live-3')
    ?.spans.at(-1)
  t.true((postClearSpan?.startAt ?? 0) >= timelineClearStartedAt)
  t.is(postClearSpan?.ok, true)

  const sourceTime = Date.now() + 1_000
  listeners.event?.({
    kind: 'fetch:start',
    queryId: 'timing-root',
    generation: 1,
    serviceName: 'teams',
    method: 'find',
    fetchId: 100,
    timestamp: sourceTime,
  })
  listeners.event?.({
    kind: 'fetch:start',
    queryId: 'timing-child',
    generation: 1,
    serviceName: 'users',
    method: 'find',
    fetchId: 101,
    timestamp: sourceTime + 25,
  })
  listeners.event?.({
    kind: 'fetch:end',
    queryId: 'timing-child',
    generation: 1,
    serviceName: 'users',
    method: 'find',
    fetchId: 101,
    durationMs: 50,
    itemCount: 1,
    timestamp: sourceTime + 75,
  })
  listeners.event?.({
    kind: 'fetch:end',
    queryId: 'timing-root',
    generation: 1,
    serviceName: 'teams',
    method: 'find',
    fetchId: 100,
    durationMs: 100,
    itemCount: 1,
    timestamp: sourceTime + 100,
  })
  const timedActivities = buildTimelineActivities(
    collector.getSnapshot(),
    buildDevtoolsModel(collector.getSnapshot()),
    performance.now(),
  )
  const timedRoot = timedActivities.find(activity => activity.queryId === 'timing-root')
  const timedChild = timedActivities.find(activity => activity.queryId === 'timing-child')
  t.true(Math.abs((timedChild?.startAt ?? 0) - (timedRoot?.startAt ?? 0) - 25) < 1)
  t.true(Math.abs((timedRoot?.endAt ?? 0) - (timedRoot?.startAt ?? 0) - 100) < 1)

  collector.stop()
})

test('devtools model keeps operation identity separate from shared fetch identity', t => {
  const root = queryRecord('root', 'issues', {
    spans: [
      {
        fetchId: 20,
        startAt: 10.4,
        endAt: 15,
        ok: true,
        graph: [{ operationId: 'rq/team', runId: 'rq/team:1', path: '(root)' }],
      },
    ],
  })
  const team = queryRecord('team', 'teams', {
    spans: [
      {
        fetchId: 10,
        startAt: 10.2,
        endAt: 14,
        ok: true,
        graph: [{ operationId: 'rq/team', runId: 'rq/team:1', path: 'team' }],
      },
    ],
  })
  const labels = queryRecord('labels', 'labels')
  const page1 = queryRecord('page-1', 'issues', {
    itemCount: 25,
    fetchCount: 2,
    classification: 'server-authoritative',
    page: {
      request: { limit: 25, includeTotal: true },
      info: { hasMore: true, endCursor: 'cursor:25', total: 35 },
    },
  })
  const page2 = queryRecord('page-2', 'issues', {
    itemCount: 10,
    fetchCount: 1,
    classification: 'server-authoritative',
    page: {
      request: { limit: 25, after: 'cursor:25', includeTotal: false },
      info: { hasMore: false },
    },
  })
  const snapshot: DevtoolsSnapshot = {
    queries: [root, team, labels, page1, page2],
    relational: [
      relationalGroup('rq/team', root.queryId, 'team', team.queryId),
      relationalGroup('rq/labels', root.queryId, 'labels', labels.queryId),
      {
        key: 'rq/pages',
        service: 'issues',
        ast: {
          service: 'issues',
          kind: 'paginate',
          query: {},
          cardinality: 'many',
          pageSize: 25,
          related: {},
        },
        pagination: {
          strategy: 'cursor',
          realtime: 'merge-or-reconcile',
          pageSize: 25,
          includeTotal: true,
          loadedPages: 2,
          hasMore: false,
          isLoadingMore: false,
          total: 35,
        },
        nodes: [
          { path: '(root)', queryId: page1.queryId },
          { path: '(root)', queryId: page2.queryId },
        ],
      },
    ],
    events: [],
    timeline: { startedAt: 0, laneOrder: [], realtime: [], connection: [] },
    writes: [],
  }

  const model = buildDevtoolsModel(snapshot)
  t.deepEqual(
    model.operations.map(operation => operation.key),
    ['rq/team', 'rq/labels', 'rq/pages'],
  )
  t.deepEqual(
    model.operations.map(operation => operation.underlying.map(item => item.path)),
    [['team'], ['labels'], []],
  )
  const pages = model.operations.find(operation => operation.key === 'rq/pages')
  t.is(pages?.rootFetches.length, 2)
  t.is(pages?.summary.itemCount, 35)
  t.is(pages?.summary.fetchCount, 3)
  t.false(pages ? 'page' in pages.summary : true)
  t.is(pages?.pagination?.strategy, 'cursor')
  t.true(pages?.composition?.detail.includes('paginate(25) · cursor · 2 pages') ?? false)
  t.is(pages?.rootFetches[1]?.page?.request.after, 'cursor:25')
  t.false(pages ? 'queryId' in pages.summary : true)
  t.is(model.scopesByQueryId.get(root.queryId)?.length, 2)
  const rootActivity = buildTimelineActivities(snapshot, model, 20).find(
    activity => activity.queryId === root.queryId,
  )
  t.is(rootActivity?.detail, 'root')
  t.true(rootActivity?.detailTooltip?.includes('Shared by 2 query operations') ?? false)
  t.deepEqual(
    buildTimelineActivities(snapshot, model, 20)
      .filter(activity => activity.kind === 'fetch')
      .map(activity => activity.queryId),
    [root.queryId, team.queryId],
  )
})

test('query details show a cursor operation as one inspectable page chain', t => {
  const { render, unmount, click, $, $all } = dom()
  const first = queryRecord('cursor-page-1', 'issues', {
    classification: 'server-authoritative',
    itemCount: 25,
    page: {
      request: { limit: 25, includeTotal: true },
      info: { hasMore: true, endCursor: 'cursor:25', total: 35 },
    },
  })
  const second = queryRecord('cursor-page-2', 'issues', {
    classification: 'server-authoritative',
    itemCount: 10,
    page: {
      request: { limit: 25, after: 'cursor:25', includeTotal: false },
      info: { hasMore: false },
    },
  })
  const snapshot: DevtoolsSnapshot = {
    queries: [first, second],
    relational: [
      {
        key: 'rq/cursor-pages',
        service: 'issues',
        ast: {
          service: 'issues',
          kind: 'paginate',
          query: { status: 'open', $sort: { createdAt: -1 } },
          cardinality: 'many',
          pageSize: 25,
          includeTotal: true,
          related: {},
        },
        pagination: {
          strategy: 'cursor',
          realtime: 'merge-or-reconcile',
          pageSize: 25,
          includeTotal: true,
          loadedPages: 2,
          hasMore: false,
          isLoadingMore: false,
          total: 35,
        },
        nodes: [
          { path: '(root)', queryId: first.queryId },
          { path: '(root)', queryId: second.queryId },
        ],
      },
    ],
    events: [],
    timeline: { startedAt: 0, laneOrder: [], realtime: [], connection: [] },
    writes: [],
  }
  const collector: Collector = {
    eventLimit: 500,
    start() {},
    stop() {},
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    clearEvents() {},
    clearTimeline() {},
    reset() {},
  }

  render(<FigbirdDevtoolsPanel collector={collector} theme='light' />)
  const row = $all('tbody tr')[0]
  t.truthy(row)
  t.is(row?.querySelectorAll('td')[1]?.textContent, 'paginate')
  t.is(
    row?.querySelectorAll('td')[2]?.textContent,
    '25, {"status":"open","$sort":{"createdAt":-1}}',
  )
  click(row!)

  const details = $('[aria-label="Figbird devtools"]')?.textContent ?? ''
  t.true(details.includes('issues.paginate(25)'))
  t.true(details.includes('find request'))
  t.true(details.includes('Pagination'))
  t.true(details.includes('35 of 35 rows loaded · 2 pages · complete'))
  t.true(details.includes('Page chain'))
  t.true(details.includes('after start · next "cursor:25"'))
  t.true(details.includes('after "cursor:25" · end'))
  t.false(details.includes('merges stable updates'))
  unmount()
})

test('extension bridge starts debug collection only while connected', async t => {
  dom()
  const { figbird } = app()
  const inspect = figbird.inspect.bind(figbird)
  let inspectCalls = 0
  figbird.inspect = () => {
    inspectCalls++
    return inspect()
  }
  const subscribe = figbird.events.subscribe.bind(figbird.events)
  let eventSubscriptions = 0
  figbird.events.subscribe = listener => {
    eventSubscriptions++
    const unsubscribe = subscribe(listener)
    return () => {
      eventSubscriptions--
      unsubscribe()
    }
  }
  t.is(inspectCalls, 0)
  t.is(eventSubscriptions, 0)

  const bridgeState = (
    globalThis as typeof globalThis & {
      __FIGBIRD_DEVTOOLS__: {
        connect(): { sessionId: string } | null
        disconnect(sessionId: string): void
        readJson(sessionId: string, version: number | null): string | null
      }
    }
  ).__FIGBIRD_DEVTOOLS__
  const connection = bridgeState.connect()
  t.truthy(connection)
  t.is(inspectCalls, 0)
  t.is(eventSubscriptions, 1)
  const read = bridgeState.readJson(connection!.sessionId, null)
  t.truthy(read)
  const envelope = JSON.parse(read!)
  t.is(envelope.protocol, 3)
  t.true(Array.isArray(envelope.read.queries))
  t.is(inspectCalls, 1)
  const unchanged = JSON.parse(bridgeState.readJson(connection!.sessionId, envelope.version)!)
  t.is(unchanged.version, envelope.version)
  t.is(unchanged.read, null)
  t.is(inspectCalls, 1)
  const queryUnsubscribe = figbird
    .queryDesc({ serviceName: 'notes', method: 'find' })
    .subscribe(() => {})
  await sleep(10)
  const changed = JSON.parse(bridgeState.readJson(connection!.sessionId, envelope.version)!)
  t.is(typeof changed.read.events[0].timestamp, 'number')

  const syntheticEvent: Record<string, unknown> = {
    type: 'click',
    nativeEvent: new window.MouseEvent('click'),
    target: window.document.createElement('button'),
  }
  syntheticEvent.self = syntheticEvent
  const unsafePayload: Record<string, unknown> = {
    circular: null,
    items: Array.from({ length: 50_000 }, (_, index) => index),
  }
  unsafePayload.circular = unsafePayload
  Object.defineProperty(unsafePayload, 'throwing', {
    enumerable: true,
    get: () => {
      throw new Error('getter failed')
    },
  })
  ;(figbird.events as FigbirdEventEmitter).emit({
    kind: 'action:start',
    actionId: 1,
    name: 'unsafe click',
    args: [syntheticEvent, unsafePayload],
  })
  await sleep(10)
  const safeReadJson = bridgeState.readJson(connection!.sessionId, changed.version)
  t.truthy(safeReadJson)
  t.true(safeReadJson!.length < 10_000)
  const safeRead = JSON.parse(safeReadJson!)
  const action = safeRead.read.events.find(
    (event: { kind: string }) => event.kind === 'action:start',
  )
  t.is(action.args[0], '[SyntheticEvent click]')
  t.is(action.args[1].circular, '[Circular]')
  t.is(action.args[1].items.length, 201)
  t.is(action.args[1].items.at(-1), '[49800 more items]')
  t.is(action.args[1].throwing, '[Property threw: getter failed]')
  ;(figbird.events as FigbirdEventEmitter).emit({
    kind: 'action:error',
    actionId: 2,
    name: 'validate',
    durationMs: 12,
    error: Object.assign(new Error('Validation Error'), {
      name: 'ValidationError',
      code: 422,
      issues: [{ name: 'email', reason: 'required' }],
    }),
  })
  await sleep(10)
  const errorRead = JSON.parse(bridgeState.readJson(connection!.sessionId, safeRead.version)!)
  const actionError = errorRead.read.events.find(
    (event: { kind: string }) => event.kind === 'action:error',
  )
  t.deepEqual(actionError.error.details, {
    name: 'ValidationError',
    message: 'Validation Error',
    code: 422,
    issues: [{ name: 'email', reason: 'required' }],
  })
  queryUnsubscribe()
  bridgeState.disconnect(connection!.sessionId)
  t.is(eventSubscriptions, 0)
  t.is(bridgeState.readJson(connection!.sessionId, envelope.version), null)
})

test('extension session disconnects after stop and preserves state across transient reads', async t => {
  let resolveConnect!: (connection: unknown) => void
  const connect = new Promise<unknown>(resolve => {
    resolveConnect = resolve
  })
  let resolveDisconnect!: () => void
  const disconnected = new Promise<void>(resolve => {
    resolveDisconnect = resolve
  })
  const expressions: string[] = []
  const session = new ExtensionSession(async expression => {
    expressions.push(expression)
    if (expression.endsWith('?.connect()')) return connect
    if (expression.includes('?.disconnect(')) {
      resolveDisconnect()
      return undefined
    }
    throw new Error(`Unexpected expression: ${expression}`)
  })

  session.start()
  session.stop()
  resolveConnect({ instanceCount: 1, instanceId: 1, protocol: 2, sessionId: 'late' })
  await disconnected

  t.true(expressions.some(expression => expression.includes('?.disconnect("late")')))
  t.false(expressions.some(expression => expression.includes('?.readJson(')))

  let connects = 0
  let reads = 0
  let resets = 0
  const transientSession = new ExtensionSession(async expression => {
    if (expression.endsWith('?.connect()')) {
      connects++
      return { instanceCount: 1, instanceId: 1, protocol: 3, sessionId: 'stable' }
    }
    if (expression.includes('?.readJson(')) {
      reads++
      if (reads === 1) throw new Error('temporary evaluation failure')
      return '{"protocol":3,"version":1,"read":{"events":[]}}'
    }
    if (expression.includes('?.disconnect(')) return undefined
    if (expression.endsWith('?.protocol')) return null
    throw new Error(`Unexpected expression: ${expression}`)
  })
  transientSession.subscribeReset(() => resets++)
  transientSession.start()
  await sleep(1_100)
  transientSession.stop()

  t.is(connects, 1)
  t.true(reads >= 2)
  t.is(resets, 0)
  transientSession.resetForNavigation()
  t.is(resets, 1)
})

test('extension inspection waits for picker startup before refreshing', async t => {
  let releaseProtocol!: () => void
  const protocol = new Promise<number>(resolve => {
    releaseProtocol = () => resolve(1)
  })
  let reads = 0
  let starts = 0
  const inspection = new ExtensionInspectionSession(async expression => {
    if (expression.endsWith('?.protocol')) return protocol
    if (expression.endsWith('?.read()')) {
      reads++
      return { kind: 'picking', version: 1 }
    }
    if (expression.includes('.start(')) {
      starts++
      return { kind: 'picking', version: 1 }
    }
    throw new Error(`Unexpected expression: ${expression}`)
  })

  inspection.start()
  const refresh = inspection.refresh()
  t.is(reads, 0)

  releaseProtocol()
  await refresh

  t.is(starts, 1)
  t.is(reads, 1)
  t.is(inspection.getSnapshot().kind, 'picking')
})

test('extension inspection serializes stop before restarting the picker', async t => {
  let page: { kind: 'idle' | 'picking'; version: number } = { kind: 'idle', version: 0 }
  let releaseStop!: () => void
  const stopGate = new Promise<void>(resolve => {
    releaseStop = resolve
  })
  let reportStopStarted!: () => void
  const stopStarted = new Promise<void>(resolve => {
    reportStopStarted = resolve
  })
  let starts = 0
  const inspection = new ExtensionInspectionSession(async expression => {
    if (expression.endsWith('?.protocol')) return 1
    if (expression.endsWith('?.read()')) return page
    if (expression.includes('.start(')) {
      starts++
      page = { kind: 'picking', version: page.version + 1 }
      return page
    }
    if (expression.endsWith('?.stop()')) {
      reportStopStarted()
      await stopGate
      page = { kind: 'idle', version: page.version + 1 }
      return page
    }
    throw new Error(`Unexpected expression: ${expression}`)
  })

  inspection.start()
  await inspection.refresh()
  inspection.stop()
  await stopStarted
  inspection.start()

  t.is(starts, 1)
  releaseStop()
  await inspection.refresh()

  t.is(starts, 2)
  t.deepEqual(page, { kind: 'picking', version: 3 })
  t.is(inspection.getSnapshot().kind, 'picking')
})

test('panel shows root queries and nests relation fetches in details', async t => {
  const { figbird } = app()
  const { render, unmount, click, $, $all, act } = dom()
  const inspectedRef = figbird.query(figbird.q.notes)
  const timelineAt = performance.now()
  const snapshot: DevtoolsSnapshot = {
    queries: [
      {
        queryId: 'root',
        generation: 1,
        present: true,
        serviceName: 'issues',
        method: 'find',
        query: {},
        classification: 'local-exact',
        status: 'success',
        isFetching: false,
        itemCount: 1,
        fetchedAt: Date.now(),
        subscriberCount: 1,
        fetchCount: 1,
        errorCount: 0,
        totalDurationMs: 8,
        lastDurationMs: 8,
        spans: [{ startAt: timelineAt - 20, endAt: timelineAt - 10, ok: true }],
        realtimeSeen: 0,
        reconciles: 0,
        data: [{ id: 76, title: 'Visible issue' }],
      },
      {
        queryId: 'labels',
        generation: 1,
        present: true,
        serviceName: 'issueLabels',
        method: 'find',
        query: { issueId: { $in: [76] } },
        classification: 'local-exact',
        status: 'success',
        isFetching: false,
        itemCount: 2,
        fetchedAt: Date.now(),
        subscriberCount: 1,
        fetchCount: 1,
        errorCount: 0,
        totalDurationMs: 5,
        lastDurationMs: 5,
        spans: [{ startAt: timelineAt - 15, endAt: timelineAt - 5, ok: true }],
        realtimeSeen: 0,
        reconciles: 0,
        data: [
          { id: 1, issueId: 76, name: 'bug' },
          { id: 2, issueId: 76, name: 'urgent' },
        ],
      },
    ],
    relational: [
      {
        key: inspectedRef.hash(),
        service: 'issues',
        ast: {
          service: 'issues',
          kind: 'find',
          query: {},
          cardinality: 'many',
          related: {
            labels: {
              service: 'issueLabels',
              kind: 'find',
              query: { issueId: { $in: [76] } },
              cardinality: 'many',
              related: {},
            },
          },
        },
        nodes: [
          { path: '(root)', queryId: 'root' },
          { path: 'labels', queryId: 'labels' },
        ],
        data: [
          {
            id: 76,
            title: 'Visible issue',
            labels: [
              { id: 1, issueId: 76, name: 'bug' },
              { id: 2, issueId: 76, name: 'urgent' },
            ],
          },
        ],
      },
    ],
    events: [],
    timeline: {
      startedAt: timelineAt - 25,
      laneOrder: ['query:root', 'query:labels', 'realtime:issues'],
      realtime: [{ at: timelineAt - 3, serviceName: 'issues' }],
      connection: [],
    },
    writes: [],
  }
  const events = new FigbirdEventEmitter()
  const inspectedRows = snapshot.queries.map(inspectedRow)
  const inspectedFigbird: FigbirdLikeForDevtools = {
    events,
    inspect: () => inspectedRows,
    inspectRelational: () => snapshot.relational,
  }
  const collector = createCollector(inspectedFigbird, { heartbeatMs: 0 })
  const inspectionSnapshot = {
    kind: 'selected' as const,
    label: 'div#issue-area',
    queryCounts: new Map([[inspectedRef.details().queryId, 1]]),
    supported: true,
    truncated: false,
    version: 1,
  }
  const inspection: DevtoolsInspectionController = {
    getSnapshot: () => inspectionSnapshot,
    start: () => {},
    stop: () => {},
    subscribe: () => () => {},
  }

  render(<FigbirdDevtoolsPanel collector={collector} inspection={inspection} />)
  await act(async () => {
    const graph = {
      operationId: inspectedRef.hash(),
      runId: `${inspectedRef.hash()}:1`,
    }
    events.emit({
      kind: 'fetch:start',
      queryId: 'root',
      generation: 1,
      serviceName: 'issues',
      method: 'find',
      fetchId: 10,
      reason: 'subscription',
      graph: [{ ...graph, path: '(root)' }],
    })
    events.emit({
      kind: 'fetch:end',
      queryId: 'root',
      generation: 1,
      serviceName: 'issues',
      method: 'find',
      fetchId: 10,
      durationMs: 8,
      itemCount: 1,
      graph: [{ ...graph, path: '(root)' }],
    })
    events.emit({
      kind: 'fetch:start',
      queryId: 'labels',
      generation: 1,
      serviceName: 'issueLabels',
      method: 'find',
      fetchId: 11,
      reason: 'subscription',
      graph: [{ ...graph, path: 'labels' }],
    })
    events.emit({
      kind: 'fetch:end',
      queryId: 'labels',
      generation: 1,
      serviceName: 'issueLabels',
      method: 'find',
      fetchId: 11,
      durationMs: 5,
      itemCount: 2,
      graph: [{ ...graph, path: 'labels' }],
    })
    events.emit({
      kind: 'realtime',
      serviceName: 'issues',
      type: 'patched',
      itemId: 76,
      item: { id: 76, title: 'Updated issue' },
    })
    events.emit({
      kind: 'connection:disconnected',
      reason: 'transport close',
      reconnecting: true,
    })
    events.emit({
      kind: 'connection:reconnected',
      attempt: 1,
      transport: 'websocket',
      connectionId: 'socket-2',
    })
    await Promise.resolve()
    await Promise.resolve()
  })

  const inspectedElement = window.document.createElement('div')
  inspectedElement.id = 'issue-area'
  window.document.body.append(inspectedElement)
  const hostFiber: Record<string, unknown> = { stateNode: inspectedElement }
  const componentFiber = {
    child: hostFiber,
    memoizedState: {
      memoizedState: (() => {
        const value = { refs: [inspectedRef] }
        Object.defineProperty(value, 'computed', {
          enumerable: true,
          get() {
            throw new Error('inspector must not invoke hook getters')
          },
        })
        return value
      })(),
      next: null,
    },
  }
  hostFiber.return = componentFiber
  Object.defineProperty(inspectedElement, '__reactFiber$figbirdTest', {
    value: hostFiber,
    enumerable: true,
  })

  t.true(($all('tbody tr')[0]?.textContent ?? '').includes('1 here'))

  const rowText = $all('tbody tr').map(row => row.textContent ?? '')
  const queryHeaders = $all('th').map(header => header.textContent ?? '')
  t.deepEqual(queryHeaders, [
    'service',
    'operation',
    'definition',
    'maintenance',
    'rows',
    'fetch activity',
    'last fetch',
    'fetched',
  ])
  t.is(rowText.length, 1)
  t.true(rowText[0]!.includes('issues'))
  t.true(rowText[0]!.includes('→ labels'))
  t.false(rowText[0]!.includes('find()'))
  t.false(rowText[0]!.includes('issueLabels'))

  const classHeader = $all('th').find(header => header.textContent === 'maintenance')
  t.true(classHeader?.getAttribute('data-tooltip')?.includes('local-exact'))
  const classBadge = $all('span').find(element => element.textContent === 'local-exact')
  t.true(classBadge?.getAttribute('data-tooltip')?.includes('merge directly'))

  const issuesRow = $all('tbody tr')[0]
  t.truthy(issuesRow)
  click(issuesRow!)

  const devtoolsText = $('[aria-label="Figbird devtools"]')?.textContent ?? ''
  t.true(devtoolsText.includes('Query plan'))
  t.true(devtoolsText.includes('Query data'))
  t.truthy($('[aria-label="Copy Query data"]'))
  t.true(devtoolsText.includes('Visible issue'))
  t.true(devtoolsText.includes('Parameters'))
  t.false(devtoolsText.includes('Realtime Updates'))
  t.false(devtoolsText.includes('Merges matching events locally'))
  t.true(devtoolsText.includes('issueLabels'))
  t.false(devtoolsText.includes('Composition'))
  t.false(devtoolsText.includes('Underlying fetches'))
  t.truthy($('[role="separator"][aria-label="Resize details pane"]'))

  const rootQueryId = $all('code').find(element => element.textContent?.includes('root'))
  t.true(rootQueryId?.getAttribute('data-tooltip')?.includes('Cache identity'))

  const nestedQuery = $('[aria-label="Inspect nested query labels"]')
  t.truthy(nestedQuery)
  click(nestedQuery!)

  const nestedText = $('[aria-label="Figbird devtools"]')?.textContent ?? ''
  t.true(nestedText.includes('issues.find›labels'))
  t.true(nestedText.includes('issueLabels.find · labels'))
  t.true(nestedText.includes('2 rows'))
  t.false(nestedText.includes('issues root'))

  const rootBreadcrumb = $('[aria-label="Back to root query"]')
  t.truthy(rootBreadcrumb)
  click(rootBreadcrumb!)
  t.true(($('[aria-label="Figbird devtools"]')?.textContent ?? '').includes('Query plan'))

  const fetchHistoryBar = $('[aria-label="8ms, success, subscription"]')
  t.truthy(fetchHistoryBar)
  t.true(fetchHistoryBar?.getAttribute('data-tooltip')?.includes('Trigger: subscription'))
  click(fetchHistoryBar!)
  const selectedFetch = $all('[data-timeline-activity="fetch"]').find(
    row => row.getAttribute('aria-selected') === 'true',
  )
  t.true(selectedFetch?.textContent?.includes('issues'))
  t.true(selectedFetch?.textContent?.includes('success'))
  t.true(
    ($('[aria-label="Figbird devtools"]')?.textContent ?? '').includes(
      'Response data at fetch time',
    ),
  )
  t.truthy($all('button').find(button => button.textContent?.includes('Open query root')))
  t.true(($('[aria-label="Figbird devtools"]')?.textContent ?? '').includes('Query graph'))
  t.true(($('[aria-label="Figbird devtools"]')?.textContent ?? '').includes('2 fetches'))
  const nestedGraphRow = $all('button').find(
    button =>
      button.textContent?.includes('nested: labels') && button.textContent.includes('issueLabels'),
  )
  t.truthy(nestedGraphRow)
  click(nestedGraphRow!)
  t.true(
    $all('[data-timeline-activity="fetch"]')
      .find(row => row.getAttribute('aria-selected') === 'true')
      ?.textContent?.includes('issueLabels'),
  )
  const showOnlyRelated = $all('button').find(button =>
    button.textContent?.includes('Show only related'),
  )
  t.truthy(showOnlyRelated)
  click(showOnlyRelated!)
  t.is($all('[data-timeline-activity]').length, 2)
  const showAll = $all('button').find(button => button.textContent?.includes('Show all'))
  t.truthy(showAll)
  click(showAll!)
  const resumeAfterFetchNavigation = $('[aria-label="Resume live timeline"]')
  t.truthy(resumeAfterFetchNavigation)
  click(resumeAfterFetchNavigation!)

  const timelineButton = $all('button').find(button => button.textContent === 'timeline')
  t.truthy(timelineButton)
  click(timelineButton!)
  const timelineText = $('[aria-label="Figbird devtools"]')?.textContent ?? ''
  const timelineRows = $all('[data-timeline-activity]')
  const timelineRowText = timelineRows.map(row => row.textContent ?? '')
  t.true(timelineRowText.some(text => text.includes('issues') && text.includes('find')))
  t.true(timelineRowText.some(text => text.includes('issueLabels') && text.includes('find')))
  t.is(
    timelineRows.filter(
      row =>
        row.getAttribute('data-timeline-activity') === 'realtime' &&
        row.textContent?.includes('issues') &&
        row.textContent.includes('patch'),
    ).length,
    1,
  )
  t.falsy($all('button').find(button => button.textContent === '30s'))
  t.truthy($('[aria-label="Timeline overview"]'))
  t.truthy($('[aria-label="Timeline overview"] canvas'))
  const fetchMarks = $all('[data-timeline-fetch]')
  t.true(fetchMarks.length > 0)
  t.true(fetchMarks.every(mark => mark.getAttribute('style')?.includes('border-radius: 999px')))
  const liveTimelineButton = $('[aria-label="Pause live timeline"]')
  t.truthy(liveTimelineButton)
  click(liveTimelineButton!)
  t.truthy($('[aria-label="Resume live timeline"]'))

  const timelineActivities = timelineRows.map(row => row.getAttribute('data-timeline-activity'))
  t.deepEqual(timelineActivities, ['fetch', 'fetch', 'realtime', 'connection', 'connection'])
  t.is($all('[data-timeline-outage="offline"]').length, 1)
  t.true(timelineText.includes('websocket'))

  const eventsButton = $all('button').find(button => button.textContent === 'events')
  t.truthy(eventsButton)
  click(eventsButton!)
  t.deepEqual(
    $all('[aria-label="Event visibility"] option').map(option => option.textContent ?? ''),
    ['Causal groups', 'Raw events'],
  )
  const eventHeaders = $all('[aria-label="Figbird devtools"] [style*="position: sticky"]').at(
    -1,
  )?.textContent
  t.true(eventHeaders?.includes('groupserviceoperationscopestatusdetails'))
  const realtimeEventRow = $all('[data-event-row]').find(row =>
    row.textContent?.includes('realtime'),
  )
  t.truthy(realtimeEventRow)
  click(realtimeEventRow!)
  const eventDetails = $('[aria-label="Figbird devtools"]')?.textContent ?? ''
  t.true(eventDetails.includes('Realtime payload'))
  t.true(eventDetails.includes('Updated issue'))

  const largeElement = window.document.createElement('div')
  const largeHostFiber: Record<string, unknown> = { stateNode: largeElement }
  const largeComponentFiber = {
    child: largeHostFiber,
    memoizedState: {
      memoizedState: new Array(25_000),
      next: null,
    },
  }
  largeHostFiber.return = largeComponentFiber
  Object.defineProperty(largeElement, '__reactFiber$figbirdLargeTest', {
    value: largeHostFiber,
    enumerable: true,
  })
  window.document.body.append(largeElement)
  const partialInspection = inspectQueryArea(largeElement)
  t.true(partialInspection.supported)
  t.true(partialInspection.truncated)

  unmount()
  inspectedElement.remove()
  largeElement.remove()
})
