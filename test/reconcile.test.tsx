/**
 * The reconciliation gate: burst safety (cooldown with a guaranteed trailing
 * edge) and hidden-tab deferral for event-driven refetches.
 *
 * These tests run at the store level with a `realtime: 'refetch'` query — any
 * service event routes it through the same `#requestReconcile` gate that
 * server-window and server-authoritative builder queries use.
 */

import EventEmitter from 'events'
import test from 'ava'
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
  visibility,
}: {
  reconcileCooldown?: number
  visibility?: VisibilitySource
} = {}) {
  const feathers = mockFeathers({
    notes: { data: { 1: { id: 1, content: 'hello' }, 2: { id: 2, content: 'world' } } },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({
    schema,
    adapter,
    eventBatchProcessingInterval: 0,
    ...(reconcileCooldown !== undefined ? { reconcileCooldown } : {}),
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
  const ref = figbird.query(
    { serviceName: 'notes', method: 'find' },
    { realtime: 'refetch' as const },
  )
  const unsub = ref.subscribe(() => {})
  return { ref, unsub }
}

test('cooldown: a burst costs one leading and one trailing refetch, and lands on the final data', async t => {
  const { figbird, feathers } = createApp({ reconcileCooldown: 80 })
  const notes = feathers.service('notes')
  const { ref, unsub } = subscribeRefetchQuery(figbird)

  await sleep(20)
  t.is(notes.counts.find, 1, 'initial fetch')

  // A burst of events well inside one cooldown window.
  for (let i = 10; i < 15; i++) {
    serverCreate(notes, { id: i, content: `note ${i}` })
    await sleep(5)
  }
  t.is(notes.counts.find, 2, 'leading edge fired once for the whole burst')

  // The trailing edge is the correctness guarantee: one refetch after the window.
  await sleep(120)
  t.is(notes.counts.find, 3, 'exactly one trailing refetch')
  const data = (ref.getSnapshot()?.data ?? []) as Note[]
  t.true(
    data.some(n => n.id === 14),
    'trailing refetch landed on the final state',
  )

  // Quiet period over — an isolated event reconciles immediately again.
  serverCreate(notes, { id: 99, content: 'isolated' })
  await sleep(20)
  t.is(notes.counts.find, 4, 'isolated events keep leading-edge latency')

  unsub()
})

test('cooldown: sustained events cost roughly one refetch per window', async t => {
  const { figbird, feathers } = createApp({ reconcileCooldown: 60 })
  const notes = feathers.service('notes')
  const { unsub } = subscribeRefetchQuery(figbird)
  await sleep(20)
  const baseline = notes.counts.find

  // ~150ms of continuous events across ~2.5 windows.
  for (let i = 0; i < 15; i++) {
    notes.emit('patched', { id: 1, content: `tick ${i}` })
    await sleep(10)
  }
  await sleep(100) // let the last trailing land

  const refetches = notes.counts.find - baseline
  t.true(
    refetches >= 2 && refetches <= 5,
    `sustained burst throttled to ~1/window (got ${refetches})`,
  )

  unsub()
})

test('cooldown: manual refetch() bypasses the gate', async t => {
  const { figbird, feathers } = createApp({ reconcileCooldown: 5000 })
  const notes = feathers.service('notes')
  const { ref, unsub } = subscribeRefetchQuery(figbird)
  await sleep(20)

  // Enter a cooldown window via an event...
  notes.emit('created', { id: 10, content: 'x' })
  await sleep(20)
  const afterLeading = notes.counts.find

  // ...manual refetches are user intent and fire immediately regardless.
  ref.refetch()
  await sleep(20)
  t.is(notes.counts.find, afterLeading + 1)

  unsub()
})

test('cooldown: a trailing refetch is skipped when the last subscriber left', async t => {
  const { figbird, feathers } = createApp({ reconcileCooldown: 60 })
  const notes = feathers.service('notes')
  const { unsub } = subscribeRefetchQuery(figbird)
  await sleep(20)

  notes.emit('created', { id: 10, content: 'x' })
  await sleep(10)
  notes.emit('created', { id: 11, content: 'y' }) // schedules the trailing edge
  await sleep(10)
  const beforeTrailing = notes.counts.find
  unsub()

  await sleep(120)
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
  const mergeRef = figbird.query({ serviceName: 'notes', method: 'find' })
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
    eventBatchProcessingInterval: 0,
    reconcileCooldown: 0,
    visibility: visibility.source,
  })
  const notes = feathers.service('notes')

  const ref = figbird.query({ serviceName: 'notes', method: 'find' })
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
