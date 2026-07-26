import test from 'ava'
import { JSDOM } from 'jsdom'
import { createSchema, service, type FigbirdEvent } from '../lib/index.js'
import { createCollector, FigbirdDevtools } from '../lib/devtools.js'
import type {
  Collector,
  DevtoolsSnapshot,
  FigbirdLikeForDevtools,
  QueryRecord,
} from '../lib/devtools.js'
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

function inspectedQuery(queryId: string): ReturnType<FigbirdLikeForDevtools['inspect']>[number] {
  return {
    queryId,
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
  }
}

function queryRecord(
  queryId: string,
  serviceName: string,
  overrides: Partial<QueryRecord> = {},
): QueryRecord {
  return {
    queryId,
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
  collector.stop()
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
    kind: 'fetch:start',
    queryId: 'live-3',
    serviceName: 'notes',
    method: 'find',
  })
  const timelineClearStartedAt = performance.now()
  collector.clearTimeline()
  listeners.event?.({
    kind: 'fetch:end',
    queryId: 'live-3',
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

test('drawer renders, switches tabs, and pops out', t => {
  const { figbird } = app()
  const { render, unmount, click, $all, $, act } = dom()
  const storedPreferences = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storedPreferences.get(key) ?? null,
      setItem: (key: string, value: string) => storedPreferences.set(key, value),
    } as Pick<Storage, 'getItem' | 'setItem'>,
  })

  const shortcut = () => {
    act(() => {
      window.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          code: 'Period',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      )
    })
  }

  const inspect = figbird.inspect.bind(figbird)
  let inspectCalls = 0
  figbird.inspect = () => {
    inspectCalls++
    return inspect()
  }

  render(<FigbirdDevtools figbird={figbird} enabledByDefault={false} />)

  shortcut()
  t.is($('[aria-label="Figbird devtools"]'), null)
  t.is(inspectCalls, 0)

  act(() => figbird.devtools.enable())
  t.true(inspectCalls > 0)
  t.is(storedPreferences.get('figbird:devtools:enabled'), 'true')
  shortcut()
  t.truthy($('[aria-label="Figbird devtools"]'))
  t.false($all('button').some(button => button.textContent?.startsWith('Figbird devtools')))

  const buttons = $all('button')
  const eventsButton = buttons.find(button => button.textContent === 'events')
  t.truthy(eventsButton)
  click(eventsButton!)

  t.true($all('input').some(input => input.getAttribute('placeholder') === 'Filter events'))
  t.true($all('button').some(button => button.textContent === 'Clear'))

  const popupDom = new JSDOM('<!doctype html><html><head></head><body></body></html>')
  const popupWindow = popupDom.window as unknown as Window
  let popupClosed = false
  Object.defineProperties(popupWindow, {
    closed: { configurable: true, get: () => popupClosed },
    close: {
      configurable: true,
      value: () => {
        popupClosed = true
      },
    },
    focus: { configurable: true, value: () => {} },
  })
  Object.defineProperty(window, 'open', {
    configurable: true,
    value: () => popupWindow,
  })

  const popoutButton = $all('button').find(button => button.textContent === 'Pop out')
  t.truthy(popoutButton)
  click(popoutButton!)

  t.is($('[aria-label="Figbird devtools"]'), null)
  const dockButton = Array.from(popupDom.window.document.querySelectorAll('button')).find(
    button => button.textContent === 'Dock',
  )
  t.truthy(dockButton)
  t.is(popupDom.window.document.documentElement.style.fontSize, '11px')
  t.is(popupDom.window.document.body.style.fontSize, '11px')
  t.is(
    popupDom.window.document.querySelector('meta[name="viewport"]')?.getAttribute('content'),
    'width=device-width, initial-scale=1',
  )

  act(() => {
    dockButton!.dispatchEvent(
      new popupDom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
    )
  })

  t.true(popupClosed)
  t.truthy($('[aria-label="Figbird devtools"]'))

  act(() => figbird.devtools.disable())
  t.is(storedPreferences.get('figbird:devtools:enabled'), 'false')
  t.is($('[aria-label="Figbird devtools"]'), null)
  shortcut()
  t.is($('[aria-label="Figbird devtools"]'), null)
  act(() => figbird.devtools.enable())

  unmount()
})

test('drawer shows root queries and nests relation fetches in details', t => {
  const { figbird } = app()
  const { render, unmount, click, $, $all } = dom()
  const inspectedRef = figbird.query(figbird.q.notes)
  const snapshot: DevtoolsSnapshot = {
    queries: [
      {
        queryId: 'root',
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
        spans: [],
        realtimeSeen: 0,
        reconciles: 0,
      },
      {
        queryId: 'labels',
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
        spans: [],
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
    timeline: { realtime: [] },
    writes: [],
    inFlightWrites: 0,
  }
  let collectorStartCalls = 0
  const collector: Collector = {
    start() {
      collectorStartCalls++
    },
    stop() {},
    subscribe() {
      return () => {}
    },
    getSnapshot() {
      return snapshot
    },
    clearEvents() {},
    clearTimeline() {},
    clearWrites() {},
  }

  render(
    <FigbirdDevtools
      figbird={figbird as FigbirdLikeForDevtools}
      collector={collector}
      defaultOpen
      enabledByDefault
    />,
  )
  t.is(collectorStartCalls, 0)

  const inspectedElement = window.document.createElement('div')
  inspectedElement.id = 'issue-area'
  window.document.body.append(inspectedElement)
  const hostFiber: Record<string, unknown> = { stateNode: inspectedElement }
  const componentFiber = {
    child: hostFiber,
    memoizedState: { memoizedState: [() => {}, [inspectedRef]], next: null },
  }
  hostFiber.return = componentFiber
  Object.defineProperty(inspectedElement, '__reactFiber$figbirdTest', {
    value: hostFiber,
    enumerable: true,
  })

  const inspectButton = $all('button').find(button => button.textContent === 'Inspect')
  t.truthy(inspectButton)
  click(inspectButton!)
  click(inspectedElement)

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

  unmount()
  inspectedElement.remove()
})
