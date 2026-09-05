import { TestClock, flushTasks } from './clock.js'
/**
 * The reconciliation gate: burst safety (cooldown with a guaranteed trailing
 * edge) and hidden-tab deferral for event-driven refetches.
 *
 * These tests run at the store level with a `realtime: 'refetch'` query — any
 * service event routes it through the same reconciliation scheduler that
 * server-window and server-authoritative builder queries use.
 */

import EventEmitter from 'events'
import test from 'ava'
const it = test.serial
import type { VisibilitySource } from '../lib'
import { createSchema, service, FeathersAdapter, Figbird } from '../lib'
import { mockFeathers } from './helpers'

interface Note {
  id: number
  content: string
}

const schema = createSchema({
  services: {
    notes: service<{ item: Note }>(),
  },
})

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function fakeVisibility(initiallyHidden = false) {
  let hidden = initiallyHidden
  const listeners = new Set<() => void>()
  const source: VisibilitySource = {
    isHidden: () => hidden,
    onChange: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    source,
    set(nextHidden: boolean) {
      hidden = nextHidden
      for (const listener of listeners) listener()
    },
  }
}

function createApp({
  reconcileCooldown,
  staleTime,
  visibility,
  clock,
}: {
  reconcileCooldown?: number
  staleTime?: number
  visibility?: VisibilitySource
  clock?: TestClock
} = {}) {
  const feathers = mockFeathers({
    notes: { data: { 1: { id: 1, content: 'hello' }, 2: { id: 2, content: 'world' } } },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({
    schema,
    adapter,
    ...(clock ? { clock } : {}),
    eventBatchInterval: 0,
    ...(reconcileCooldown !== undefined ? { reconcileCooldown } : {}),
    ...(staleTime !== undefined ? { staleTime } : {}),
    ...(visibility !== undefined ? { visibility } : {}),
  })
  return { figbird, feathers }
}

/** Add a row to the mock's data AND emit the realtime event, like a real server. */
function serverCreate(
  service: ReturnType<ReturnType<typeof createApp>['feathers']['service']>,
  item: Note,
) {
  service.data = { ...service.data, [item.id]: item }
  service.emit('created', item)
}

/** Subscribe a refetch-mode find so every service event requests a reconcile. */
function subscribeRefetchQuery(figbird: ReturnType<typeof createApp>['figbird']) {
  const ref = figbird.queryDesc(
    { serviceName: 'notes', method: 'find' },
    { realtime: 'refetch' as const },
  )
  const unsub = ref.subscribe(() => {})
  return { ref, unsub }
}

test('cooldown: a burst costs one leading and one trailing refetch, and lands on the final data', async t => {
  const clock = new TestClock()
  const { figbird, feathers } = createApp({ clock, reconcileCooldown: 80 })
  const notes = feathers.service('notes')
  const { ref, unsub } = subscribeRefetchQuery(figbird)

  await flushTasks()
  t.is(notes.counts.find, 1, 'initial fetch')

  // A burst of events well inside one cooldown window.
  for (let i = 10; i < 15; i++) {
    serverCreate(notes, { id: i, content: `note ${i}` })
    await clock.advance(5)
  }
  t.is(notes.counts.find, 2, 'leading edge fired once for the whole burst')

  // The trailing edge is the correctness guarantee: one refetch after the window.
  await clock.advance(54)
  t.is(notes.counts.find, 2, 'the trailing fetch waits until the deadline')
  await clock.advance(1)
  t.is(notes.counts.find, 3, 'exactly one trailing refetch')
  const data = (ref.getSnapshot()?.data ?? []) as Note[]
  t.true(
    data.some(n => n.id === 14),
    'trailing refetch landed on the final state',
  )

  // Quiet period over — an isolated event reconciles immediately again.
  await clock.advance(80)
  serverCreate(notes, { id: 99, content: 'isolated' })
  await clock.advance(20)
  t.is(notes.counts.find, 4, 'isolated events keep leading-edge latency')

  unsub()
})

test('cooldown: sustained events cost one refetch per window', async t => {
  const clock = new TestClock()
  const { figbird, feathers } = createApp({ clock, reconcileCooldown: 60 })
  const notes = feathers.service('notes')
  const { unsub } = subscribeRefetchQuery(figbird)
  await clock.advance(20)
  const baseline = notes.counts.find

  // ~150ms of continuous events across ~2.5 windows.
  for (let i = 0; i < 15; i++) {
    notes.emit('patched', { id: 1, content: `tick ${i}` })
    await clock.advance(10)
  }
  await clock.advance(100) // let the last trailing land

  const refetches = notes.counts.find - baseline
  t.is(refetches, 4, 'one leading fetch and trailing fetches at 60, 120, and 180 ms')

  unsub()
})

test('cooldown: manual refetch() bypasses the gate', async t => {
  const clock = new TestClock()
  const { figbird, feathers } = createApp({ clock, reconcileCooldown: 80 })
  const notes = feathers.service('notes')
  const { ref, unsub } = subscribeRefetchQuery(figbird)
  await clock.advance(20)

  // Enter a cooldown window via an event...
  notes.emit('created', { id: 10, content: 'x' })
  await clock.advance(20)
  const afterLeading = notes.counts.find

  notes.emit('created', { id: 11, content: 'y' })
  await clock.advance(5)

  // ...manual refetches are user intent and fire immediately regardless.
  ref.refetch()
  await clock.advance(20)
  t.is(notes.counts.find, afterLeading + 1)

  await clock.advance(100)
  t.is(
    notes.counts.find,
    afterLeading + 1,
    'manual fetch consumes the outstanding trailing request',
  )

  unsub()
})

test('cooldown: a trailing refetch is skipped when the last subscriber left', async t => {
  const clock = new TestClock()
  const { figbird, feathers } = createApp({ clock, reconcileCooldown: 60 })
  const notes = feathers.service('notes')
  const { unsub } = subscribeRefetchQuery(figbird)
  await clock.advance(20)

  notes.emit('created', { id: 10, content: 'x' })
  await clock.advance(10)
  notes.emit('created', { id: 11, content: 'y' }) // schedules the trailing edge
  await clock.advance(10)
  const beforeTrailing = notes.counts.find
  unsub()

  await clock.advance(120)
  t.is(notes.counts.find, beforeTrailing, 'no fetch for a query nobody watches')

  // The store state stayed coherent — the query is simply pending for the
  // next subscriber (the standard inactive-cached behavior).
  const state = figbird.getState().get('notes')
  const pending = Array.from(state!.queries.values()).some(q => q.pending)
  t.true(pending)
})

test('hidden tabs: event-driven reconciliation defers; local-exact merges keep flowing', async t => {
  const visibility = fakeVisibility(true) // starts hidden
  const { figbird, feathers } = createApp({ reconcileCooldown: 0, visibility: visibility.source })
  const notes = feathers.service('notes')

  // A refetch-mode query (network reconciliation — gated while hidden)...
  const { ref: refetchRef, unsub: unsubRefetch } = subscribeRefetchQuery(figbird)
  // ...and a default merge-mode query (local-exact — unaffected by visibility).
  const mergeRef = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  const unsubMerge = mergeRef.subscribe(() => {})
  await sleep(20)
  const baseline = notes.counts.find
  t.true(baseline >= 1, 'first fetches are not gated — only reconciliation is')

  serverCreate(notes, { id: 10, content: 'while hidden' })
  await sleep(30)

  t.is(notes.counts.find, baseline, 'no network reconciliation while hidden')
  const merged = (mergeRef.getSnapshot()?.data ?? []) as Note[]
  t.true(
    merged.some(n => n.id === 10),
    'local-exact queries still merge socket events while hidden',
  )

  // Becoming visible drains the deferred reconciliations — once.
  visibility.set(false)
  await sleep(30)
  t.is(notes.counts.find, baseline + 1, 'one refetch per deferred query on visible')
  const reconciled = (refetchRef.getSnapshot()?.data ?? []) as Note[]
  t.true(reconciled.some(n => n.id === 10))

  unsubRefetch()
  unsubMerge()
})

test('hidden tabs: a reconnect while hidden defers the refetch-all until visible', async t => {
  const visibility = fakeVisibility(false)
  const feathers = mockFeathers({
    notes: { data: { 1: { id: 1, content: 'hello' } } },
  })
  // Give the mock client a reconnect event source the adapter can find.
  const io = new EventEmitter()
  ;(feathers as unknown as { io: EventEmitter }).io = io
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({
    schema,
    adapter,
    eventBatchInterval: 0,
    reconcileCooldown: 0,
    reconnectJitter: 0,
    visibility: visibility.source,
  })
  const notes = feathers.service('notes')

  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  const unsub = ref.subscribe(() => {})
  await sleep(20)
  const baseline = notes.counts.find

  // Visible reconnect: refetches immediately (existing behavior).
  io.emit('reconnect')
  await sleep(20)
  t.is(notes.counts.find, baseline + 1)

  // Hidden reconnect: deferred...
  visibility.set(true)
  io.emit('reconnect')
  await sleep(20)
  t.is(notes.counts.find, baseline + 1, 'hidden tabs do not replay the reconnect storm')

  // ...and reconciled once on return.
  visibility.set(false)
  await sleep(20)
  t.is(notes.counts.find, baseline + 2)

  unsub()
})

test('visibility: returning after staleTime reconciles active queries once', async t => {
  const clock = new TestClock()
  const visibility = fakeVisibility(false)
  const { figbird, feathers } = createApp({
    clock,
    reconcileCooldown: 0,
    staleTime: 20,
    visibility: visibility.source,
  })
  const notes = feathers.service('notes')
  const reconcileCauses: string[][] = []
  const unsubscribeEvents = figbird.events.subscribe(event => {
    if (event.kind === 'fetch:start' && event.reason === 'reconcile') {
      reconcileCauses.push(event.causes?.map(cause => cause.kind) ?? [])
    }
  })
  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  const unsub = ref.subscribe(() => {})
  await flushTasks()
  const baseline = notes.counts.find

  visibility.set(true)
  await clock.advance(19)
  visibility.set(false)
  await flushTasks()
  t.is(notes.counts.find, baseline, 'a short background visit keeps the live result')

  visibility.set(true)
  await clock.advance(15)
  ref.refetch()
  await flushTasks()
  await clock.advance(5)
  visibility.set(false)
  await flushTasks()
  t.is(
    notes.counts.find,
    baseline + 1,
    'a query refreshed while hidden is not immediately fetched again',
  )

  visibility.set(true)
  await clock.advance(20)
  visibility.set(false)
  await flushTasks()
  t.is(notes.counts.find, baseline + 2, 'a meaningful sleep gets one safety refetch')
  t.deepEqual(reconcileCauses, [['visibility']])

  unsub()
  unsubscribeEvents()
})

test('reconnect: inactive cached queries become pending for their next subscriber', async t => {
  const feathers = mockFeathers({
    notes: { data: { 1: { id: 1, content: 'hello' } } },
  })
  const io = new EventEmitter()
  ;(feathers as unknown as { io: EventEmitter }).io = io
  const figbird = new Figbird({
    schema,
    adapter: new FeathersAdapter(feathers),
    eventBatchInterval: 0,
    reconcileCooldown: 0,
    reconnectJitter: [40, 40],
  })
  const notes = feathers.service('notes')
  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  const unsub = ref.subscribe(() => {})
  await sleep(20)
  const baseline = notes.counts.find
  unsub()

  io.emit('reconnect')
  t.is(notes.counts.find, baseline, 'reconnect does not fetch an inactive query')

  const resubscribe = ref.subscribe(() => {})
  await sleep(20)
  t.is(notes.counts.find, baseline + 1, 'pending overrides the five-minute default')

  await sleep(40)
  t.is(notes.counts.find, baseline + 1, 'the delayed sweep does not repeat that fetch')
  resubscribe()
})

test('reconnect jitter delays and coalesces a visible-tab sweep', async t => {
  const feathers = mockFeathers({
    notes: { data: { 1: { id: 1, content: 'hello' } } },
  })
  const io = new EventEmitter()
  ;(feathers as unknown as { io: EventEmitter }).io = io
  const figbird = new Figbird({
    schema,
    adapter: new FeathersAdapter(feathers),
    eventBatchInterval: 0,
    reconcileCooldown: 0,
    reconnectJitter: [40, 40],
  })
  const notes = feathers.service('notes')
  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  const unsub = ref.subscribe(() => {})
  await sleep(20)
  const baseline = notes.counts.find

  io.emit('reconnect')
  io.emit('reconnect')
  await sleep(25)
  t.is(notes.counts.find, baseline, 'the sweep stays inside the configured delay')

  await sleep(35)
  t.is(notes.counts.find, baseline + 1, 'two reconnects coalesce into one sweep')
  unsub()
})

test('reconcileCooldown: 0 preserves per-event refetching exactly', async t => {
  const { figbird, feathers } = createApp({ reconcileCooldown: 0 })
  const notes = feathers.service('notes')
  const { unsub } = subscribeRefetchQuery(figbird)
  await sleep(20)
  const baseline = notes.counts.find

  for (let i = 0; i < 3; i++) {
    notes.emit('created', { id: 20 + i, content: `n${i}` })
    await sleep(20)
  }
  t.is(notes.counts.find, baseline + 3, 'every event reconciles when the gate is disabled')

  unsub()
})

it('a throwing subscriber cannot block other listeners or reconcile follow-ups', async t => {
  const { figbird, feathers } = createApp({ reconcileCooldown: 0 })
  const notes = feathers.service('notes')
  const localRef = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  const windowRef = figbird.queryDesc({
    serviceName: 'notes',
    method: 'find',
    params: { query: { $sort: { id: 1 }, $limit: 1, $skip: 1 } },
  })
  let armed = false
  let safeNotifications = 0
  const originalConsoleError = console.error
  console.error = () => {}
  t.teardown(() => {
    console.error = originalConsoleError
  })

  const unsubThrowing = localRef.subscribe(() => {
    if (armed) throw new Error('subscriber failed')
  })
  const unsubSafe = localRef.subscribe(() => {
    if (armed) safeNotifications++
  })
  const unsubWindow = windowRef.subscribe(() => {})
  await sleep(20)
  const baseline = notes.counts.find
  armed = true

  serverCreate(notes, { id: 0, content: 'before the window' })
  await sleep(20)

  t.true(safeNotifications > 0, 'later listeners still run')
  t.is(notes.counts.find, baseline + 1, 'the server-window reconcile still runs')
  unsubThrowing()
  unsubSafe()
  unsubWindow()
})
