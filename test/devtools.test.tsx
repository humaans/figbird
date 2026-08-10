import test from 'ava'
import { createSchema, service, type FigbirdEvent } from '../lib/index.js'
import { FigbirdEventEmitter } from '../lib/core/events.js'
import {
  FigbirdDevtoolsPanel,
  type DevtoolsInspectionController,
} from '../lib/devtools/Devtools.js'
import {
  createCollector,
  type DevtoolsSnapshot,
  type FigbirdLikeForDevtools,
  type QueryRecord,
} from '../lib/devtools/collector.js'
import { inspectQueryArea } from '../lib/core/devtoolsInspection.js'
import { buildDevtoolsModel } from '../lib/devtools/model.js'
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
  t.true(row?.lastDurationMs !== undefined)
  t.true(snapshot.events.length > 0)
  t.true(snapshot.events.every(event => event.wallAt !== undefined))
  t.true(snapshot.timeline.realtime.length > 0)
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
  t.is(clearedTimeline.timeline.realtime.length, 0)
  t.is(clearedRow?.spans.length, 0)
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

  feathers.service('notes').patch = () => Promise.reject(new Error('nope'))

  await t.throwsAsync(figbird.m.notes.patch(1, { content: 'bad' }))
  await sleep(70)

  const mutation = collector.getSnapshot().writes.find(write => write.type === 'mutation')
  t.truthy(mutation)
  t.is(mutation?.status, 'error')
  t.true(mutation?.rolledBack)
  t.is(mutation?.error, 'nope')
  t.deepEqual(mutation?.args, [1, { content: 'bad' }])

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
    error: new Error('old generation failed'),
  })
  const afterStaleError = collector.getSnapshot().queries.find(query => query.queryId === 'live-3')
  t.is(afterStaleError?.generation, 2)
  t.is(afterStaleError?.status, 'success')
  t.is(afterStaleError?.lastError?.generation, 1)

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

  collector.clearWrites()
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

  listeners.event?.({
    kind: 'fetch:start',
    queryId: 'live-3',
    generation: 2,
    serviceName: 'notes',
    method: 'find',
  })
  const timelineClearStartedAt = performance.now()
  collector.clearTimeline()
  listeners.event?.({
    kind: 'fetch:end',
    queryId: 'live-3',
    generation: 2,
    serviceName: 'notes',
    method: 'find',
    durationMs: 100,
    itemCount: 1,
  })
  const postClearSpan = collector
    .getSnapshot()
    .queries.find(query => query.queryId === 'live-3')
    ?.spans.at(-1)
  t.true((postClearSpan?.startAt ?? 0) >= timelineClearStartedAt)

  collector.stop()
})

test('devtools model keeps operation identity separate from shared fetch identity', t => {
  const root = queryRecord('root', 'issues')
  const team = queryRecord('team', 'teams')
  const labels = queryRecord('labels', 'labels')
  const page1 = queryRecord('page-1', 'issues', { itemCount: 25, fetchCount: 2 })
  const page2 = queryRecord('page-2', 'issues', { itemCount: 10, fetchCount: 1 })
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
        nodes: [
          { path: '(root)', queryId: page1.queryId },
          { path: '(root)', queryId: page2.queryId },
        ],
      },
    ],
    events: [],
    timeline: { realtime: [] },
    writes: [],
    inFlightWrites: 0,
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
  t.false(pages ? 'queryId' in pages.summary : true)
  t.is(model.scopesByQueryId.get(root.queryId)?.length, 2)
})

test('extension bridge starts debug collection only while connected', t => {
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
        readJson(sessionId: string): string | null
      }
    }
  ).__FIGBIRD_DEVTOOLS__
  const connection = bridgeState.connect()
  t.truthy(connection)
  t.is(inspectCalls, 0)
  t.is(eventSubscriptions, 1)
  const read = bridgeState.readJson(connection!.sessionId)
  t.truthy(read)
  t.true(Array.isArray(JSON.parse(read!).queries))
  t.is(inspectCalls, 1)
  bridgeState.disconnect(connection!.sessionId)
  t.is(eventSubscriptions, 0)
  t.is(bridgeState.readJson(connection!.sessionId), null)
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
      },
    ],
    events: [],
    timeline: { realtime: [{ at: timelineAt - 3, serviceName: 'issues' }] },
    writes: [],
    inFlightWrites: 0,
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
    active: false,
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
    events.emit({
      kind: 'fetch:start',
      queryId: 'root',
      generation: 1,
      serviceName: 'issues',
      method: 'find',
    })
    events.emit({
      kind: 'fetch:end',
      queryId: 'root',
      generation: 1,
      serviceName: 'issues',
      method: 'find',
      durationMs: 8,
      itemCount: 1,
    })
    events.emit({
      kind: 'fetch:start',
      queryId: 'labels',
      generation: 1,
      serviceName: 'issueLabels',
      method: 'find',
    })
    events.emit({
      kind: 'fetch:end',
      queryId: 'labels',
      generation: 1,
      serviceName: 'issueLabels',
      method: 'find',
      durationMs: 5,
      itemCount: 2,
    })
    events.emit({
      kind: 'realtime',
      serviceName: 'issues',
      type: 'patched',
      itemId: 76,
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
  t.is(rowText.length, 1)
  t.true(rowText[0]!.includes('issues'))
  t.true(rowText[0]!.includes('find · with labels'))
  t.false(rowText[0]!.includes('issueLabels'))

  const classHeader = $all('th').find(header => header.textContent === 'class')
  t.true(classHeader?.getAttribute('title')?.includes('local-exact'))
  const classBadge = $all('span').find(element => element.textContent === 'local-exact')
  t.true(classBadge?.getAttribute('title')?.includes('merge directly'))

  const issuesRow = $all('tbody tr')[0]
  t.truthy(issuesRow)
  click(issuesRow!)

  const devtoolsText = $('[aria-label="Figbird devtools"]')?.textContent ?? ''
  t.true(devtoolsText.includes('Query plan'))
  t.true(devtoolsText.includes('Parameters'))
  t.true(devtoolsText.includes('issueLabels'))
  t.false(devtoolsText.includes('Composition'))
  t.false(devtoolsText.includes('Underlying fetches'))
  t.truthy($('[role="separator"][aria-label="Resize details pane"]'))

  const rootQueryId = $all('code').find(element => element.textContent === 'root')
  t.true(rootQueryId?.getAttribute('title')?.includes('Cache identity'))

  const nestedQuery = $('[aria-label="Inspect nested query labels"]')
  t.truthy(nestedQuery)
  click(nestedQuery!)

  const nestedText = $('[aria-label="Figbird devtools"]')?.textContent ?? ''
  t.true(nestedText.includes('issues.find›labels'))
  t.true(nestedText.includes('issueLabels.find · labels'))
  t.true(nestedText.includes('2rows'))
  t.false(nestedText.includes('issues root'))

  const rootBreadcrumb = $('[aria-label="Back to root query"]')
  t.truthy(rootBreadcrumb)
  click(rootBreadcrumb!)
  t.true(($('[aria-label="Figbird devtools"]')?.textContent ?? '').includes('Query plan'))

  const timelineButton = $all('button').find(button => button.textContent === 'timeline')
  t.truthy(timelineButton)
  click(timelineButton!)
  const timelineText = $('[aria-label="Figbird devtools"]')?.textContent ?? ''
  t.true(timelineText.includes('issues.find'))
  t.true(timelineText.includes('issueLabels.find'))
  t.is(timelineText.match(/issues realtime/g)?.length, 1)

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
