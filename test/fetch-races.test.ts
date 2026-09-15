import { TestClock, flushTasks } from './clock.js'
import test from 'ava'
import {
  FeathersAdapter,
  Figbird,
  createSchema,
  service,
  type RealtimeEventContext,
  type RetryDelay,
} from '../lib'
import { FetchEventJournal, MAX_FETCH_JOURNAL_EVENTS } from '../lib/core/fetchRebase'
import type { ProcessedCacheEvent } from '../lib/core/queryTypes'
import { mockFeathers, type TestItem } from './helpers'

interface Note extends TestItem {
  id: number
  content: string
  rank: number
  updatedAt?: number
  computed?: string
}

const schema = createSchema({
  services: {
    notes: service<{ item: Note }>(),
  },
})

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${message}`)
    await sleep(5)
  }
}

function createApp(
  data: Record<string, Note>,
  {
    eventBatchInterval = 0,
    retry,
    retryDelay,
    clock,
    isInvalidationEvent,
  }: {
    eventBatchInterval?: number
    retry?: number | false
    retryDelay?: RetryDelay
    clock?: TestClock
    isInvalidationEvent?: (event: RealtimeEventContext) => boolean
  } = {},
) {
  const feathers = mockFeathers({ notes: { data } }, { queryAwareFind: true })
  const figbird = new Figbird({
    schema,
    ...(clock ? { clock } : {}),
    adapter: new FeathersAdapter(feathers, {
      ...(isInvalidationEvent ? { isInvalidationEvent } : {}),
    }),
    eventBatchInterval,
    reconcileCooldown: 0,
    reconnectJitter: 0,
    ...(retry !== undefined ? { retry } : {}),
    ...(retryDelay !== undefined ? { retryDelay } : {}),
  })
  return { figbird, notes: feathers.service('notes') }
}

test('failed fetches retry with backoff before exposing an error', async t => {
  const clock = new TestClock()
  const delays: Array<{ attempt: number; message: string }> = []
  const { figbird, notes } = createApp(
    { 1: { id: 1, content: 'one', rank: 1 } },
    {
      clock,
      retryDelay: (attempt, error) => {
        delays.push({ attempt, message: error.message })
        return attempt * 10
      },
    },
  )
  const find = notes.find.bind(notes)
  let failuresRemaining = 2
  notes.find = async params => {
    if (failuresRemaining-- > 0) {
      notes.counts.find++
      throw new Error('network down')
    }
    return find(params)
  }

  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  const observedStatuses: string[] = []
  const unsub = ref.subscribe(state => observedStatuses.push(state.status))

  await clock.advance(9)
  t.is(notes.counts.find, 1)
  await clock.advance(1)
  t.is(notes.counts.find, 2)
  await clock.advance(19)
  t.is(notes.counts.find, 2)
  await clock.advance(1)
  t.is(ref.getSnapshot()?.status, 'success')

  t.is(notes.counts.find, 3, 'the initial request plus two retries ran')
  t.deepEqual(delays, [
    { attempt: 1, message: 'network down' },
    { attempt: 2, message: 'network down' },
  ])
  t.false(observedStatuses.includes('error'), 'retryable failures stay internal')
  const stats = figbird.queryStore.getQueryStats(ref.hash())
  t.is(stats?.fetchCount, 3)
  t.is(stats?.errorCount, 2)
  unsub()
})

test('retry policy handles server errors, client errors, and per-query opt-out', async t => {
  const { figbird, notes } = createApp({}, { retry: 2, retryDelay: 0 })
  notes.find = async () => {
    notes.counts.find++
    throw Object.assign(new Error('server unavailable'), { code: 503 })
  }

  const retried = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  const unsubRetried = retried.subscribe(() => {})
  await waitFor(() => retried.getSnapshot()?.status === 'error', 'retry exhaustion')
  t.is(notes.counts.find, 3)
  t.is(retried.getSnapshot()?.error?.message, 'server unavailable')
  unsubRetried()

  notes.counts.find = 0
  notes.find = async () => {
    notes.counts.find++
    throw Object.assign(new Error('bad request'), { code: 400 })
  }
  const clientError = figbird.queryDesc({
    serviceName: 'notes',
    method: 'find',
    params: { query: { invalid: true } },
  })
  const unsubClientError = clientError.subscribe(() => {})
  await waitFor(() => clientError.getSnapshot()?.status === 'error', 'client error')
  t.is(notes.counts.find, 1)
  t.is(clientError.getSnapshot()?.error?.message, 'bad request')
  unsubClientError()

  notes.counts.find = 0
  notes.find = async () => {
    notes.counts.find++
    throw new Error('offline')
  }
  const noRetry = figbird.queryDesc(
    { serviceName: 'notes', method: 'find', params: { query: { disabled: true } } },
    { retry: false },
  )
  const unsubNoRetry = noRetry.subscribe(() => {})
  await waitFor(() => noRetry.getSnapshot()?.status === 'error', 'the opted-out failure')
  t.is(notes.counts.find, 1)
  unsubNoRetry()
})

test('a pending retry stops when the query loses its last subscriber', async t => {
  const clock = new TestClock()
  const { figbird, notes } = createApp({}, { clock, retry: 3, retryDelay: 20 })
  notes.find = async () => {
    notes.counts.find++
    throw new Error('offline')
  }

  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  const unsub = ref.subscribe(() => {})
  await flushTasks()
  unsub()
  await clock.advance(40)

  t.is(notes.counts.find, 1)
  t.is(ref.getSnapshot()?.status, 'error')
})

function ids(data: unknown): number[] {
  return (data as Note[]).map(note => note.id)
}

function processedEvent(itemId: number): ProcessedCacheEvent {
  return {
    mode: 'server',
    source: 'realtime',
    serviceName: 'notes',
    type: 'patched',
    item: { id: itemId },
    previousItem: null,
    itemId: String(itemId),
  }
}

test('lane projections keep the realtime batch atomic', async t => {
  const { figbird, notes } = createApp(
    {
      1: { id: 1, content: 'one', rank: 1, updatedAt: 1 },
      2: { id: 2, content: 'two', rank: 2, updatedAt: 1 },
    },
    { eventBatchInterval: 30 },
  )
  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  const snapshots: string[][] = []
  const unsub = ref.subscribe(state => {
    if (state.status === 'success') {
      snapshots.push((state.data as Note[]).map(note => note.content))
    }
  })
  await waitFor(() => ref.getSnapshot()?.status === 'success', 'the initial find')

  let resolvePatch!: (item: TestItem) => void
  const patchGate = new Promise<TestItem>(resolve => {
    resolvePatch = resolve
  })
  notes.patch = () => patchGate
  const pending = figbird.mutateDesc({
    serviceName: 'notes',
    method: 'patch',
    id: 1,
    data: { content: 'optimistic' },
    optimistic: true,
  })
  snapshots.length = 0

  notes.emit('patched', { id: 1, content: 'server lane', rank: 1, updatedAt: 2 })
  notes.emit('patched', { id: 2, content: 'server peer', rank: 2, updatedAt: 2 })
  t.is(snapshots.length, 0, 'neither half of the batch is observable early')

  await waitFor(() => snapshots.length > 0, 'the realtime batch')
  t.deepEqual(snapshots, [['optimistic', 'server peer']])

  resolvePatch({ id: 1, content: 'server ack', rank: 1, updatedAt: 3 })
  await pending
  unsub()
})

test('journal overflow invalidates only cursors that exceed the event limit', t => {
  const journal = new FetchEventJournal(3)
  const olderFetch = journal.begin('notes')
  journal.record([processedEvent(1), processedEvent(2)])
  const newerFetch = journal.begin('notes')

  journal.record([processedEvent(3), processedEvent(4)])

  t.true(journal.read(olderFetch).overflowed)
  const newerSnapshot = journal.read(newerFetch)
  t.false(newerSnapshot.overflowed)
  t.deepEqual(
    newerSnapshot.events.map(event => event.itemId),
    ['3', '4'],
  )
  journal.end(olderFetch)
  journal.record([processedEvent(5)])
  t.deepEqual(
    journal.read(newerFetch).events.map(event => event.itemId),
    ['3', '4', '5'],
  )
  journal.record([processedEvent(6)])
  t.true(journal.read(newerFetch).overflowed, 'overflow begins only after the capacity boundary')
  journal.end(newerFetch)
  const nextFetch = journal.begin('notes')
  t.deepEqual(journal.read(nextFetch), { events: [], overflowed: false })
  t.true(journal.read(newerFetch).overflowed, 'released cursors cannot read a new journal')
  journal.record([processedEvent(7)])
  t.deepEqual(
    journal.read(nextFetch).events.map(event => event.itemId),
    ['7'],
  )
  journal.clear()
  t.true(journal.read(nextFetch).overflowed)
})

test('a created event that lands during a find survives the stale response', async t => {
  const { figbird, notes } = createApp({ 1: { id: 1, content: 'one', rank: 1 } })
  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  const unsub = ref.subscribe(() => {})
  await waitFor(() => ref.getSnapshot()?.status === 'success', 'the initial find')

  notes.setDelay(40)
  ref.refetch()
  await waitFor(() => notes.counts.find === 2, 'the delayed refetch to start')
  const created = { id: 2, content: 'two', rank: 2 }
  notes.data = { ...notes.data, 2: created }
  notes.emit('created', created)

  await waitFor(
    () => ref.getSnapshot()?.status === 'success' && !ref.getSnapshot()?.isFetching,
    'the trailing reconciliation',
  )
  t.deepEqual(ids(ref.getSnapshot()!.data), [1, 2])
  unsub()
})

test('a removed event that lands during a find is not resurrected', async t => {
  const { figbird, notes } = createApp({ 1: { id: 1, content: 'one', rank: 1 } })
  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  const unsub = ref.subscribe(() => {})
  await waitFor(() => ref.getSnapshot()?.status === 'success', 'the initial find')

  notes.setDelay(40)
  ref.refetch()
  await waitFor(() => notes.counts.find === 2, 'the delayed refetch to start')
  const removed = notes.data[1]!
  notes.data = {}
  notes.emit('removed', removed)

  await waitFor(
    () => ref.getSnapshot()?.status === 'success' && !ref.getSnapshot()?.isFetching,
    'the trailing reconciliation',
  )
  t.deepEqual(ids(ref.getSnapshot()!.data), [])
  unsub()
})

test('a complete-set refetch does not delete a row created during the fetch', async t => {
  const { figbird, notes } = createApp({ 1: { id: 1, content: 'one', rank: 1 } })
  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' }, { allPages: true })
  const processed: ProcessedCacheEvent[] = []
  const unsubProcessed = figbird.queryStore.subscribeToProcessedEvents(event => {
    processed.push(event)
  })
  const unsub = ref.subscribe(() => {})
  await waitFor(() => ref.getSnapshot()?.status === 'success', 'the initial complete fetch')

  notes.setDelay(40)
  ref.refetch()
  await waitFor(() => notes.counts.find === 2, 'the delayed complete refetch to start')
  const created = { id: 2, content: 'two', rank: 2 }
  notes.data = { ...notes.data, 2: created }
  notes.emit('created', created)

  await waitFor(
    () => ref.getSnapshot()?.status === 'success' && !ref.getSnapshot()?.isFetching,
    'the complete-set trailing reconciliation',
  )
  t.true(figbird.getState().get('notes')!.entities.has('2'))
  t.true(ids(ref.getSnapshot()!.data).includes(2))
  t.false(processed.some(event => event.type === 'removed' && event.itemId === '2'))
  unsub()
  unsubProcessed()
})

test('a provable window merge survives an older reconcile response', async t => {
  const { figbird, notes } = createApp({
    1: { id: 1, content: 'one', rank: 1 },
    2: { id: 2, content: 'two', rank: 2 },
    3: { id: 3, content: 'three', rank: 3 },
  })
  const ref = figbird.queryDesc({
    serviceName: 'notes',
    method: 'find',
    params: { query: { $sort: { rank: 1 }, $limit: 2 } },
  })
  const unsub = ref.subscribe(() => {})
  await waitFor(() => ref.getSnapshot()?.status === 'success', 'the initial window')

  notes.setDelay(40)
  const moved = { id: 1, content: 'one moved', rank: 4, updatedAt: 2 }
  notes.data = { ...notes.data, 1: moved }
  notes.emit('patched', moved)
  await waitFor(() => notes.counts.find === 2, 'the reconcile fetch to start')

  const created = { id: 5, content: 'between', rank: 1.5, updatedAt: 3 }
  notes.data = { ...notes.data, 5: created }
  notes.emit('created', created)

  await waitFor(
    () => ref.getSnapshot()?.status === 'success' && !ref.getSnapshot()?.isFetching,
    'the final window reconciliation',
  )
  t.deepEqual(ids(ref.getSnapshot()!.data), [5, 2])
  unsub()
})

test('a mutation acknowledgement survives an in-flight complete-set fetch', async t => {
  const { figbird, notes } = createApp({ 1: { id: 1, content: 'one', rank: 1 } })
  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' }, { allPages: true })
  const unsub = ref.subscribe(() => {})
  await waitFor(() => ref.getSnapshot()?.status === 'success', 'the initial complete fetch')

  notes.setDelay(40)
  ref.refetch()
  await waitFor(() => notes.counts.find === 2, 'the delayed complete refetch to start')
  await figbird.mutateDesc({
    serviceName: 'notes',
    method: 'create',
    data: { id: 2, content: 'mutation', rank: 2 },
  })

  await waitFor(
    () => ref.getSnapshot()?.status === 'success' && !ref.getSnapshot()?.isFetching,
    'the mutation trailing reconciliation',
  )
  t.true(figbird.getState().get('notes')!.entities.has('2'))
  t.true(ids(ref.getSnapshot()!.data).includes(2))
  unsub()
})

test('snapshot and fetch-owned queries retain their own fetched rows', async t => {
  const original = { id: 1, content: 'original', rank: 1, updatedAt: 1 }
  const { figbird, notes } = createApp({ 1: original })
  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' }, { realtime: 'disabled' })
  const unsub = ref.subscribe(() => {})
  await waitFor(() => ref.getSnapshot()?.status === 'success', 'the initial snapshot')

  notes.setDelay(40)
  ref.refetch()
  await waitFor(() => notes.counts.find === 2, 'the delayed snapshot fetch to start')
  const patched = { ...original, content: 'patched', updatedAt: 2 }
  notes.data = { 1: patched }
  notes.emit('patched', patched)

  await waitFor(() => !ref.getSnapshot()?.isFetching, 'the snapshot fetch to settle')
  t.is((ref.getSnapshot()!.data as Note[])[0]!.content, 'original')
  t.is((figbird.getState().get('notes')!.entities.get('1') as Note).content, 'patched')
  t.is(notes.counts.find, 2)
  unsub()

  for (const strategy of ['explicit-refetch', 'server-authoritative'] as const) {
    for (const event of ['created', 'patched', 'removed']) {
      const { figbird, notes } = createApp({})
      const pending: Array<(rows: Note[]) => void> = []
      notes.find = () =>
        new Promise(resolve => {
          pending.push(rows => resolve({ data: rows, total: rows.length, limit: 100, skip: 0 }))
        })
      const ref =
        strategy === 'explicit-refetch'
          ? figbird.queryDesc(
              { serviceName: 'notes', method: 'find' },
              { realtime: 'refetch', allPages: true },
            )
          : figbird.query(figbird.q.notes.all().server())
      const visibleRows: unknown[] = []
      const unsub = ref.subscribe(state => {
        if (state.status === 'success') visibleRows.push(...state.data)
      })
      t.teardown(unsub)
      await flushTasks()
      pending.shift()!([])
      await flushTasks()

      // The first notification starts a fetch; the next races its complete response.
      notes.emit('created', { id: 1 })
      await flushTasks()
      notes.emit(event, { id: 1 })
      pending.shift()!([original])
      await flushTasks()
      t.deepEqual(
        ref.getSnapshot()!.data,
        [original],
        `${strategy}: ${event} must not replace fetched rows`,
      )

      const finalRows = event === 'removed' ? [] : [original]
      t.is(pending.length, 1, `${strategy}: the race schedules a trailing reconciliation`)
      pending.shift()!(finalRows)
      await flushTasks()
      t.deepEqual(ref.getSnapshot()!.data, finalRows)
      for (const row of visibleRows) t.deepEqual(row, original)
      unsub()
    }
  }

  const serverOwned = { ...original, computed: 'server-only' }
  const { figbird: ownedFigbird, notes: ownedNotes } = createApp({ 1: original })
  const find = ownedNotes.find.bind(ownedNotes)
  ownedNotes.find = async params => {
    const result = await find(params)
    return { ...result, data: result.data.map(item => ({ ...item, computed: 'server-only' })) }
  }
  const authoritative = ownedFigbird.query(ownedFigbird.q.notes.where({ id: 1 }).server())
  const unsubscribeAuthoritative = authoritative.subscribe(() => {})
  await waitFor(() => authoritative.getSnapshot().status === 'success', 'server-owned find')
  t.deepEqual(authoritative.getSnapshot().data, [serverOwned])

  const sibling = ownedFigbird.queryDesc(
    { serviceName: 'notes', method: 'get', resourceId: 1 },
    { fetchPolicy: 'network-only' },
  )
  const unsubscribeSibling = sibling.subscribe(() => {})
  await waitFor(() => sibling.getSnapshot()?.status === 'success', 'sibling get')
  t.deepEqual(
    authoritative.getSnapshot().data,
    [serverOwned],
    'a sibling fetch must not replace values owned by a server-authoritative query',
  )

  ownedNotes.data = {}
  const complete = ownedFigbird.queryDesc(
    { serviceName: 'notes', method: 'find' },
    { allPages: true, fetchPolicy: 'network-only' },
  )
  const unsubscribeComplete = complete.subscribe(() => {})
  await waitFor(() => complete.getSnapshot()?.status === 'success', 'complete-set removal')
  t.deepEqual(
    authoritative.getSnapshot().data,
    [],
    'an exhaustive fetch may still remove a server-authoritative row',
  )
  unsubscribeComplete()
  unsubscribeSibling()
  unsubscribeAuthoritative()
  ownedFigbird.dispose()
})

test('realtime invalidations preserve canonical entities and reconcile ordinary queries', async t => {
  const original = { id: 1, content: 'original', rank: 1, updatedAt: 1 }
  const revised = { ...original, content: 'revised', updatedAt: 2 }

  for (const source of ['id-only', 'adapter-classified'] as const) {
    const { figbird, notes } = createApp(
      { 1: original },
      source === 'adapter-classified'
        ? {
            isInvalidationEvent: ({ item }) =>
              typeof item === 'object' && item !== null && 'refresh' in item,
          }
        : {},
    )
    const getRef = figbird.queryDesc({
      serviceName: 'notes',
      method: 'get',
      resourceId: 1,
    })
    const findRef = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
    const visibleItems: unknown[] = []
    const unsubGet = getRef.subscribe(state => {
      if (state.status === 'success') visibleItems.push(state.data)
    })
    const unsubFind = findRef.subscribe(state => {
      if (state.status === 'success') visibleItems.push(...state.data)
    })
    await waitFor(
      () =>
        getRef.getSnapshot()?.status === 'success' && findRef.getSnapshot()?.status === 'success',
      `${source} initial queries`,
    )

    notes.data = { 1: revised }
    notes.emit('patched', source === 'id-only' ? { id: 1 } : { id: 1, refresh: true })

    t.deepEqual(figbird.getState().get('notes')!.entities.get('1'), original)
    t.deepEqual(getRef.getSnapshot()!.data, original)
    t.deepEqual(findRef.getSnapshot()!.data, [original])

    await waitFor(
      () =>
        !getRef.getSnapshot()?.isFetching &&
        !findRef.getSnapshot()?.isFetching &&
        notes.counts.get >= 2 &&
        notes.counts.find >= 2,
      `${source} reconciliation`,
    )
    t.true(notes.counts.get >= 2)
    t.true(notes.counts.find >= 2)
    t.deepEqual(getRef.getSnapshot()!.data, revised)
    t.deepEqual(findRef.getSnapshot()!.data, [revised])
    for (const item of visibleItems) {
      t.true(
        typeof item === 'object' && item !== null && 'content' in item,
        `${source} never publishes an incomplete entity`,
      )
    }

    unsubGet()
    unsubFind()
  }
})

test('ordinary fetches do not add rows to unrelated or materialized queries', async t => {
  for (const initialCache of ['empty', 'populated'] as const) {
    const template = { id: 1, content: 'workflow', rank: 0 }
    const { figbird, notes } = createApp({ 1: template })
    const find = notes.find.bind(notes)
    notes.find = params => {
      const query = params?.query ?? {}
      return find({
        ...params,
        query: Object.prototype.hasOwnProperty.call(query, 'rank') ? query : { ...query, rank: 1 },
      })
    }

    const templates = figbird.queryDesc({
      serviceName: 'notes',
      method: 'find',
      params: { query: { content: 'workflow', rank: 0 } },
    })
    let unsubscribeTemplates: (() => void) | undefined
    if (initialCache === 'populated') {
      unsubscribeTemplates = templates.subscribe(() => {})
      await waitFor(() => templates.getSnapshot()?.status === 'success', 'template preload')
    }

    const materializedRoot = figbird.queryDesc(
      { serviceName: 'notes', method: 'find' },
      { allPages: true },
    )
    const unsubscribeRoot = materializedRoot.subscribe(() => {})
    await waitFor(() => materializedRoot.getSnapshot()?.status === 'success', 'materialized root')
    const materializedWorkflows = figbird.queryDesc({
      serviceName: 'notes',
      method: 'find',
      params: { query: { content: 'workflow', $sort: { id: 1 } } },
    })
    const unsubscribeMaterialized = materializedWorkflows.subscribe(() => {})
    await waitFor(
      () => materializedWorkflows.getSnapshot()?.status === 'success',
      'materialized workflows',
    )
    t.deepEqual(materializedWorkflows.getSnapshot()!.data, [])

    const companyWorkflows = figbird.queryDesc({
      serviceName: 'notes',
      method: 'find',
      params: { query: { content: 'workflow' } },
    })
    const unsubscribeCompany = companyWorkflows.subscribe(() => {})
    await waitFor(() => companyWorkflows.getSnapshot()?.status === 'success', 'company workflows')
    t.deepEqual(companyWorkflows.getSnapshot()!.data, [])

    if (initialCache === 'empty') {
      unsubscribeTemplates = templates.subscribe(() => {})
      await waitFor(() => templates.getSnapshot()?.status === 'success', 'template fetch')
    } else {
      notes.data = { 1: { ...template, content: 'workflow updated' } }
      const previousFindCount = notes.counts.find
      templates.refetch()
      await waitFor(
        () => notes.counts.find > previousFindCount && !templates.getSnapshot()?.isFetching,
        'template refetch',
      )
    }

    t.deepEqual(
      companyWorkflows.getSnapshot()!.data,
      [],
      `${initialCache} cache must not turn fetch discovery into query membership`,
    )
    t.deepEqual(
      materializedWorkflows.getSnapshot()!.data,
      [],
      `${initialCache} cache must not bypass materialized-root membership`,
    )
    unsubscribeTemplates?.()
    unsubscribeCompany()
    unsubscribeMaterialized()
    unsubscribeRoot()
    figbird.dispose()
  }
})

test('an overrun fetch response is discarded and reconciled', async t => {
  const original = { id: 1, content: 'original', rank: 1, updatedAt: 1 }
  const { figbird, notes } = createApp({ 1: original }, { eventBatchInterval: 10 })
  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  const unsub = ref.subscribe(() => {})
  await waitFor(() => ref.getSnapshot()?.status === 'success', 'the initial find')

  notes.setDelay(80)
  ref.refetch()
  await waitFor(() => notes.counts.find === 2, 'the delayed refetch to start')

  let latest = original
  for (let index = 0; index <= MAX_FETCH_JOURNAL_EVENTS; index++) {
    latest = {
      ...original,
      content: `patched ${index}`,
      updatedAt: index + 2,
    }
    notes.emit('patched', latest)
  }
  notes.data = { 1: latest }
  notes.setDelay(0)

  await waitFor(
    () =>
      notes.counts.find === 3 &&
      ref.getSnapshot()?.status === 'success' &&
      !ref.getSnapshot()?.isFetching,
    'the overflow reconciliation',
  )
  t.is((ref.getSnapshot()!.data as Note[])[0]!.content, latest.content)
  t.is(notes.counts.find, 3)
  unsub()
})
