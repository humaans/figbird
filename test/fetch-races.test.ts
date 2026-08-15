import test from 'ava'
import { FeathersAdapter, Figbird, createSchema, service, type RetryDelay } from '../lib'
import { FetchEventJournal, MAX_FETCH_JOURNAL_EVENTS } from '../lib/core/fetchRebase'
import type { ProcessedRealtimeEvent } from '../lib/core/queryTypes'
import { mockFeathers, type TestItem } from './helpers'

interface Note extends TestItem {
  id: number
  content: string
  rank: number
  updatedAt?: number
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
  }: {
    eventBatchInterval?: number
    retry?: number | false
    retryDelay?: RetryDelay
  } = {},
) {
  const feathers = mockFeathers({ notes: { data } }, { queryAwareFind: true })
  const figbird = new Figbird({
    schema,
    adapter: new FeathersAdapter(feathers),
    eventBatchInterval,
    reconcileCooldown: 0,
    reconnectJitter: 0,
    ...(retry !== undefined ? { retry } : {}),
    ...(retryDelay !== undefined ? { retryDelay } : {}),
  })
  return { figbird, notes: feathers.service('notes') }
}

test('failed fetches retry with backoff before exposing an error', async t => {
  const delays: Array<{ attempt: number; message: string }> = []
  const { figbird, notes } = createApp(
    { 1: { id: 1, content: 'one', rank: 1 } },
    {
      retryDelay: (attempt, error) => {
        delays.push({ attempt, message: error.message })
        return 0
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

  await waitFor(() => ref.getSnapshot()?.status === 'success', 'the retried find')

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
  const { figbird, notes } = createApp({}, { retry: 3, retryDelay: 20 })
  notes.find = async () => {
    notes.counts.find++
    throw new Error('offline')
  }

  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  const unsub = ref.subscribe(() => {})
  await waitFor(() => notes.counts.find === 1, 'the first failed request')
  unsub()
  await sleep(40)

  t.is(notes.counts.find, 1)
  t.is(ref.getSnapshot()?.status, 'error')
})

function ids(data: unknown): number[] {
  return (data as Note[]).map(note => note.id)
}

function processedEvent(itemId: number): ProcessedRealtimeEvent {
  return {
    origin: 'authoritative',
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
  const processed: ProcessedRealtimeEvent[] = []
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

test('realtime-disabled queries retain the response snapshot from an in-flight fetch', async t => {
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
