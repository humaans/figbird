import test from 'ava'
import React, { useState } from 'react'
import type { FigbirdEvent, QueryState } from '../lib'
import { createHooks, createSchema, isMutationSupersededError, service, useAction } from '../lib'
import { createTestApp, dom } from './helpers'

interface Note {
  id: number
  content: string
  parentId?: number
  updatedAt?: number
}

/** The mock service's methods return the helpers' loose TestItem shape. */
type MockItem = Note & { [key: string]: unknown }

interface ArchiveResult {
  id: number
  archived: boolean
  reason: string
}

interface NoteService {
  item: Note
  methods: {
    archive: (id: number, reason: string) => Promise<ArchiveResult>
  }
}

const schema = createSchema({
  services: {
    notes: service<NoteService>(),
    people: service<{ item: { id: number; name: string } }>({ path: 'api/people' }),
  },
})

// The mock feathers client keys services by transport path, not schema key.
const services = () => ({
  notes: { data: { 1: { id: 1, content: 'hello' }, 2: { id: 2, content: 'world' } } },
  'api/people': { data: { 1: { id: 1, name: 'Ada' } } },
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function collectEvents(
  figbird: { events: { subscribe: (fn: (e: FigbirdEvent) => void) => () => void } },
  prefix: string,
) {
  const events: FigbirdEvent[] = []
  figbird.events.subscribe(event => {
    if (event.kind.startsWith(prefix)) events.push(event)
  })
  return events
}

// ----- the m proxy -----

test('m: writes are optimistic by default; confirmed opts out per handle or inline', async t => {
  const { figbird } = createTestApp(schema, services())
  const { m } = figbird
  const events = collectEvents(figbird, 'mutate:')

  const notes = m.notes

  const patched = await notes.patch(1, { content: 'updated' })
  t.is(patched.content, 'updated')

  await m.notes.confirmed.patch(1, { content: 'again' })

  const policies = m.notes.confirmed // named surface handle
  await policies.patch(1, { content: 'third' })

  await Promise.resolve()
  const starts = events.filter(e => e.kind === 'mutate:start')
  t.deepEqual(
    starts.map(e => e.optimistic),
    [true, false, false],
  )
})

test('m: handles are interned and the confirmed variant is stable', t => {
  const { figbird } = createTestApp(schema, services())
  const { m } = figbird

  t.is(m.notes, m.notes)
  t.is(m.notes.confirmed, m.notes.confirmed)
  // The callable (dynamic-name) form resolves to the same interned handle.
  t.is(m('notes'), m.notes)
  t.is(figbird.m('notes'), m.notes)
})

test('m: optimisticItem supplies the synthesized cache item without flipping policy', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const { m } = figbird

  // Observe the cache through a subscribed query.
  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  let latest: QueryState<Note[], Record<string, unknown>> | undefined
  ref.subscribe(state => {
    latest = state as QueryState<Note[], Record<string, unknown>>
  })
  await new Promise(r => setTimeout(r, 10))
  t.is(latest?.data?.length, 2)

  const gate = deferred<MockItem>()
  feathers.service('notes').patch = () => gate.promise

  const pending = m.notes.patch(
    1,
    { content: 'raw' },
    { optimisticItem: { id: 1, content: 'synthesized!' } },
  )
  // The synthesized item (not the raw patch data) is what the cache shows.
  t.is(latest?.data?.find(n => n.id === 1)?.content, 'synthesized!')

  // A fetch that begins after the optimistic event still replays the active
  // overlay instead of replacing it with the server's old value.
  ref.refetch()
  await new Promise(r => setTimeout(r, 10))
  t.is(latest?.data?.find(n => n.id === 1)?.content, 'synthesized!')

  gate.resolve({ id: 1, content: 'server' })
  await pending
  t.is(latest?.data?.find(n => n.id === 1)?.content, 'server')

  const failedGate = deferred<MockItem>()
  const rebasedGate = deferred<MockItem>()
  let queuedPatchCall = 0
  feathers.service('notes').patch = (() =>
    queuedPatchCall++ === 0 ? failedGate.promise : rebasedGate.promise) as never

  const failed = m.notes.patch(1, { content: 'will fail' })
  const rebased = m.notes.patch(1, { content: 'survives' })
  t.is(latest?.data?.find(n => n.id === 1)?.content, 'survives')

  failedGate.reject(new Error('first patch failed'))
  await t.throwsAsync(() => failed, { message: 'first patch failed' })
  t.is(queuedPatchCall, 2, 'the next patch starts after the failed head settles')
  t.is(latest?.data?.find(n => n.id === 1)?.content, 'survives')

  rebasedGate.resolve({ id: 1, content: 'survives' })
  await rebased
  t.is(latest?.data?.find(n => n.id === 1)?.content, 'survives')
})

test('m: failed optimistic mutation reveals authoritative data fetched while pending', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const { m } = createHooks(figbird)
  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  let latest: QueryState<Note[], Record<string, unknown>> | undefined
  ref.subscribe(state => {
    latest = state as QueryState<Note[], Record<string, unknown>>
  })
  await new Promise(resolve => setTimeout(resolve, 10))

  const gate = deferred<MockItem>()
  const notes = feathers.service('notes')
  notes.patch = () => gate.promise
  const pending = m.notes.patch(1, { content: 'optimistic' })
  t.is(latest?.data?.find(note => note.id === 1)?.content, 'optimistic')

  notes.data = {
    ...notes.data,
    1: { id: 1, content: 'fetched while pending', updatedAt: Date.now() },
  }
  ref.refetch()
  await new Promise(resolve => setTimeout(resolve, 10))
  t.is(latest?.data?.find(note => note.id === 1)?.content, 'optimistic')

  gate.reject(new Error('patch failed'))
  await t.throwsAsync(() => pending, { message: 'patch failed' })
  t.is(latest?.data?.find(note => note.id === 1)?.content, 'fetched while pending')
})

test('mutation queue: buffered patches coalesce while every call projects immediately', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  let latest: QueryState<Note[], Record<string, unknown>> | undefined
  ref.subscribe(state => {
    latest = state as QueryState<Note[], Record<string, unknown>>
  })
  await new Promise(resolve => setTimeout(resolve, 10))

  const gate = deferred<MockItem>()
  const calls: Array<[number, Partial<Note>]> = []
  feathers.service('notes').patch = ((id: number, data: Partial<Note>) => {
    calls.push([id, data])
    return gate.promise
  }) as never

  const queue = figbird.createMutationQueue({
    schedule: () => ({ wait: 10_000, maxWait: 20_000 }),
  })
  let projectionEvents = 0
  let projectionSettlements = 0
  const unsubscribeEvents = figbird.queryStore.subscribeToProcessedEvents(event => {
    if (event.origin === 'projection' && event.itemId === 1) projectionEvents += 1
  })
  const unsubscribeSettlements = figbird.queryStore.subscribeToProjectionSettlements(event => {
    if (event.itemId === 1) projectionSettlements += 1
  })
  const first = queue.m.notes.patch(1, { content: 'e' })
  const second = queue.m.notes.patch(1, { content: 'edited' })

  t.is(first, second, 'coalesced callers share the outgoing request')
  t.is(latest?.data?.find(note => note.id === 1)?.content, 'edited')
  t.is(calls.length, 0)
  t.is(projectionEvents, 2)
  t.is(projectionSettlements, 0)
  t.deepEqual(queue.getSnapshot(), { status: 'scheduled', pending: 1, error: null })

  queue.flush()
  t.deepEqual(calls, [[1, { content: 'edited' }]])

  gate.resolve({ id: 1, content: 'edited' })
  await second
  t.is(
    projectionEvents,
    3,
    'two local projections and the server acknowledgement are each emitted once',
  )
  t.is(projectionSettlements, 1)
  t.deepEqual(queue.getSnapshot(), { status: 'idle', pending: 0, error: null })
  unsubscribeEvents()
  unsubscribeSettlements()
})

test('mutation queue: ordinary writes preserve their interleaved record order', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const queue = figbird.createMutationQueue({ schedule: () => ({ wait: 10_000 }) })
  const gates = [deferred<MockItem>(), deferred<MockItem>(), deferred<MockItem>()]
  const calls: string[] = []
  feathers.service('notes').patch = ((_id: number, data: Partial<Note>) => {
    calls.push(data.content!)
    return gates[calls.length - 1]!.promise
  }) as never

  const first = queue.m.notes.patch(1, { content: 'workflow one' })
  const second = queue.m.notes.patch(1, { content: 'workflow two' })
  const ordinary = figbird.m.notes.patch(1, { content: 'ordinary' })
  const fourth = queue.m.notes.patch(1, { content: 'workflow four' })
  queue.flush()

  t.is(first, second)
  t.deepEqual(calls, ['workflow two'])

  gates[0]!.resolve({ id: 1, content: 'workflow two' })
  await second
  t.deepEqual(calls, ['workflow two', 'ordinary'])

  gates[1]!.resolve({ id: 1, content: 'ordinary' })
  await ordinary
  t.deepEqual(calls, ['workflow two', 'ordinary', 'workflow four'])

  gates[2]!.resolve({ id: 1, content: 'workflow four' })
  await fourth
})

test('mutation queue: ordinary same-record writes prevent backward coalescing', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const queue = figbird.createMutationQueue({ schedule: () => ({ wait: 10_000 }) })
  const gates = [
    deferred<MockItem>(),
    deferred<MockItem>(),
    deferred<MockItem>(),
    deferred<MockItem>(),
  ]
  const calls: Array<[number, string]> = []
  feathers.service('notes').patch = ((id: number, data: Partial<Note>) => {
    const gate = gates[calls.length]!
    calls.push([id, data.content!])
    return gate.promise
  }) as never

  const blocker = queue.m.notes.patch(2, { content: 'other record' })
  const first = queue.m.notes.patch(1, { content: 'queued one' })
  const ordinary = figbird.m.notes.patch(1, { content: 'ordinary' })
  const last = queue.m.notes.patch(1, { content: 'queued three' })
  queue.flush()

  t.not(first, last, 'the ordinary lane entry is a coalescing boundary')
  t.deepEqual(calls, [[2, 'other record']])

  gates[0]!.resolve({ id: 2, content: 'other record' })
  await blocker
  t.deepEqual(calls, [
    [2, 'other record'],
    [1, 'queued one'],
  ])

  gates[1]!.resolve({ id: 1, content: 'queued one' })
  await first
  t.deepEqual(calls, [
    [2, 'other record'],
    [1, 'queued one'],
    [1, 'ordinary'],
  ])

  gates[2]!.resolve({ id: 1, content: 'ordinary' })
  await ordinary
  t.deepEqual(calls, [
    [2, 'other record'],
    [1, 'queued one'],
    [1, 'ordinary'],
    [1, 'queued three'],
  ])

  gates[3]!.resolve({ id: 1, content: 'queued three' })
  await last
})

test('mutation queue: a successful remove cancels a later patch in the old lifetime', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const queue = figbird.createMutationQueue({ schedule: () => ({ wait: 10_000 }) })
  const patchGate = deferred<MockItem>()
  const removeGate = deferred<MockItem>()
  const patchCalls: string[] = []
  feathers.service('notes').patch = ((_id: number, data: Partial<Note>) => {
    patchCalls.push(data.content!)
    return patchGate.promise
  }) as never
  feathers.service('notes').remove = (() => removeGate.promise) as never

  const before = queue.m.notes.patch(1, { content: 'before remove' })
  const removed = figbird.m.notes.remove(1)
  const after = queue.m.notes.patch(1, { content: 'after remove' })
  const cancelled = t.throwsAsync(() => after)
  queue.flush()

  t.deepEqual(patchCalls, ['before remove'])
  patchGate.resolve({ id: 1, content: 'before remove' })
  await before

  removeGate.resolve({ id: 1, content: 'before remove' })
  await removed
  const error = await cancelled
  t.true(isMutationSupersededError(error))
  t.deepEqual(patchCalls, ['before remove'])
})

test('mutation queue: a failed remove cancels the dependent recreated lifetime', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const queue = figbird.createMutationQueue()
  const removeGate = deferred<MockItem>()
  let createCalls = 0
  feathers.service('notes').remove = (() => removeGate.promise) as never
  feathers.service('notes').create = (() => {
    createCalls += 1
    return Promise.resolve({ id: 1, content: 'recreated' })
  }) as never

  const removed = figbird.m.notes.remove(1)
  const removeRejected = t.throwsAsync(() => removed, { message: 'remove failed' })
  const recreated = queue.m.notes.create({ id: 1, content: 'recreated' })
  const patched = queue.m.notes.patch(1, { content: 'new lifetime patch' })
  const recreateRejected = t.throwsAsync(() => recreated)
  const patchRejected = t.throwsAsync(() => patched)

  removeGate.reject(new Error('remove failed'))
  await removeRejected
  const [recreateError, patchError] = await Promise.all([recreateRejected, patchRejected])

  t.true(isMutationSupersededError(recreateError))
  t.true(isMutationSupersededError(patchError))
  t.is(createCalls, 0)
  t.deepEqual(queue.getSnapshot(), { status: 'idle', pending: 0, error: null })
})

test('mutation queue: a terminal failure pauses with optimism intact until retry', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  let latest: QueryState<Note[], Record<string, unknown>> | undefined
  ref.subscribe(state => {
    latest = state as QueryState<Note[], Record<string, unknown>>
  })
  await new Promise(resolve => setTimeout(resolve, 10))

  let calls = 0
  feathers.service('notes').patch = ((_id: number, data: Partial<Note>) => {
    calls += 1
    return calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve({ id: 1, ...data })
  }) as never

  const queue = figbird.createMutationQueue()
  const pending = queue.m.notes.patch(1, { content: 'survives retry' })
  await new Promise(resolve => setTimeout(resolve, 0))

  t.is(queue.getSnapshot().status, 'failed')
  t.is(latest?.data?.find(note => note.id === 1)?.content, 'survives retry')
  t.is(calls, 1)

  queue.retry()
  await pending
  t.is(calls, 2)
  t.is(queue.getSnapshot().status, 'idle')
})

test('mutation queue: related creates are transported serially in call order', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const firstGate = deferred<MockItem>()
  const secondGate = deferred<MockItem>()
  const calls: Partial<Note>[] = []
  feathers.service('notes').create = ((data: Partial<Note>) => {
    calls.push(data)
    return calls.length === 1 ? firstGate.promise : secondGate.promise
  }) as never

  const queue = figbird.createMutationQueue()
  const parent = queue.m.notes.create({ id: 10, content: 'parent' })
  const child = queue.m.notes.create({ id: 11, content: 'child', parentId: 10 })

  t.deepEqual(calls, [{ id: 10, content: 'parent' }])
  firstGate.resolve({ id: 10, content: 'parent' })
  await parent
  t.deepEqual(calls, [
    { id: 10, content: 'parent' },
    { id: 11, content: 'child', parentId: 10 },
  ])

  secondGate.resolve({ id: 11, content: 'child', parentId: 10 })
  await child
})

test('mutation queue: discard rolls back the failed and pending optimistic work', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  let latest: QueryState<Note[], Record<string, unknown>> | undefined
  ref.subscribe(state => {
    latest = state as QueryState<Note[], Record<string, unknown>>
  })
  await new Promise(resolve => setTimeout(resolve, 10))

  feathers.service('notes').patch = (() => Promise.reject(new Error('offline'))) as never
  const queue = figbird.createMutationQueue()
  const first = queue.m.notes.patch(1, { content: 'pending one' })
  const second = queue.m.notes.patch(2, { content: 'pending two' })
  const firstRejected = t.throwsAsync(() => first, { message: 'offline' })
  const secondRejected = t.throwsAsync(() => second, { message: /discarded/ })
  await new Promise(resolve => setTimeout(resolve, 0))

  t.is(queue.getSnapshot().status, 'failed')
  t.deepEqual(
    latest?.data?.map(note => note.content),
    ['pending one', 'pending two'],
  )

  queue.discard()
  await Promise.all([firstRejected, secondRejected])
  await Promise.resolve()
  t.deepEqual(
    latest?.data?.map(note => note.content),
    ['hello', 'world'],
  )
  t.is(queue.getSnapshot().status, 'idle')
})

test('m: optimisticPatch separates the projected record from the wire payload', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  let latest: QueryState<Note[], Record<string, unknown>> | undefined
  ref.subscribe(state => {
    latest = state as QueryState<Note[], Record<string, unknown>>
  })
  await new Promise(resolve => setTimeout(resolve, 10))

  const gate = deferred<MockItem>()
  let wire: unknown
  feathers.service('notes').patch = ((_id: number, data: unknown) => {
    wire = data
    return gate.promise
  }) as never

  const pending = figbird.m.notes.patch(
    1,
    { content: 'wire value' },
    { optimisticPatch: { content: 'projected value' } },
  )
  t.deepEqual(wire, { content: 'wire value' })
  t.is(latest?.data?.find(note => note.id === 1)?.content, 'projected value')

  gate.resolve({ id: 1, content: 'wire value' })
  await pending
})

test('m: custom schema methods dispatch through the adapter with events and tracking', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const { m } = figbird
  const events = collectEvents(figbird, 'mutate:')

  const archiveCalls: unknown[][] = []
  const gate = deferred<ArchiveResult>()
  feathers.service('notes').archive = (...args: unknown[]) => {
    archiveCalls.push(args)
    return gate.promise
  }

  const pending = m.notes.archive(1, 'done with it')

  // Tracked synchronously, before the adapter settles.
  const inFlight = figbird.mutating.getSnapshot()
  t.is(inFlight.length, 1)
  t.like(inFlight[0], { serviceName: 'notes', method: 'archive' })

  gate.resolve({ id: 1, archived: true, reason: 'done with it' })
  const result = await pending
  t.deepEqual(result, { id: 1, archived: true, reason: 'done with it' })
  t.deepEqual(archiveCalls, [[1, 'done with it']])
  t.is(figbird.mutating.getSnapshot().length, 0)

  await Promise.resolve()
  const kinds = events.map(e => `${e.kind}:${'method' in e ? e.method : ''}`)
  t.deepEqual(kinds, ['mutate:start:archive', 'mutate:end:archive'])
})

test('m: call() is the untyped escape hatch and errors flow through mutate:error', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const { m } = figbird
  const events = collectEvents(figbird, 'mutate:')

  feathers.service('notes').explode = () => Promise.reject(new Error('boom'))

  await t.throwsAsync(() => m.notes.call('explode', 1, 2), { message: 'boom' })
  t.is(figbird.mutating.getSnapshot().length, 0)

  await Promise.resolve()
  t.deepEqual(
    events.map(e => e.kind),
    ['mutate:start', 'mutate:error'],
  )
})

test('m: handles are not thenable and ignore protocol probes instead of firing phantom calls', async t => {
  const { figbird } = createTestApp(schema, services())
  const { m } = figbird
  const events = collectEvents(figbird, 'mutate:')

  const handle = m.notes as unknown as Record<string, unknown>
  // A callable `then` would make `await` on a handle hang forever, unsettled.
  t.is(handle.then, undefined)
  // A callable `toJSON` would turn JSON.stringify into a phantom network write.
  t.is(handle.toJSON, undefined)
  t.notThrows(() => JSON.stringify(m.notes))
  t.notThrows(() => JSON.stringify(m.notes.confirmed))

  await Promise.resolve()
  t.is(events.length, 0, 'no phantom mutations from introspection')
})

test('m: resolves service path aliases', async t => {
  const { figbird } = createTestApp(schema, services())
  const { m } = figbird

  // Schema key `people` routes to the transport path `api/people`.
  const patched = await m.people.patch(1, { name: 'Grace' })
  t.is(patched.name, 'Grace')
})

test('mutate events carry a correlating mutationId', async t => {
  const { figbird } = createTestApp(schema, services())
  const { m } = figbird
  const events = collectEvents(figbird, 'mutate:')

  await m.notes.patch(1, { content: 'a' })
  await m.notes.patch(2, { content: 'b' })
  await Promise.resolve()

  const ids = (events as Array<{ mutationId: number }>).map(e => e.mutationId)
  t.is(ids.length, 4)
  t.is(ids[0], ids[1], 'first start/end pair correlates')
  t.is(ids[2], ids[3], 'second start/end pair correlates')
  t.not(ids[0], ids[2], 'distinct mutations get distinct ids')
})

// ----- the optimistic-create id contract -----

test('id contract: optimistic creates without a client id throw synchronously', t => {
  const { figbird } = createTestApp(schema, services())
  const { m } = figbird

  const error = t.throws(() => m.notes.create({ content: 'no identity' }))
  t.regex(error!.message, /client-generated id/)
  t.regex(error!.message, /confirmed create/)
  // Nothing was tracked and nothing hit the wire.
  t.is(figbird.mutating.getSnapshot().length, 0)

  // Batch creates enforce the contract per item.
  t.throws(() => m.notes.create([{ id: 7, content: 'ok' }, { content: 'no id' }]))
})

test('id contract: keyed optimistic mutations serialize and rebase over each acknowledgement', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const { m } = figbird

  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  let latest: QueryState<Note[], Record<string, unknown>> | undefined
  ref.subscribe(state => {
    latest = state as QueryState<Note[], Record<string, unknown>>
  })
  await new Promise(r => setTimeout(r, 10))
  t.is(latest?.data?.length, 2)

  const windowRef = figbird.queryDesc({
    serviceName: 'notes',
    method: 'find',
    params: { query: { $limit: 1 } },
  })
  windowRef.subscribe(() => {})
  await new Promise(r => setTimeout(r, 10))
  const initialFindCount = feathers.service('notes').counts.find

  const createGate = deferred<MockItem>()
  const firstPatchGate = deferred<MockItem>()
  const secondPatchGate = deferred<MockItem>()
  const removeGate = deferred<MockItem>()
  const calls: string[] = []
  feathers.service('notes').create = (() => {
    calls.push('create')
    return createGate.promise
  }) as never
  let patchCall = 0
  feathers.service('notes').patch = ((_id: number, data: Partial<Note>) => {
    calls.push(`patch:${data.content}`)
    return patchCall++ === 0 ? firstPatchGate.promise : secondPatchGate.promise
  }) as never
  feathers.service('notes').remove = (() => {
    calls.push('remove')
    return removeGate.promise
  }) as never

  const created = m.notes.create({ id: 99, content: 'draft' })
  const firstPatch = m.notes.patch(99, { content: 'edited once' })
  const secondPatch = m.notes.patch(99, { content: 'edited twice' })
  const removed = m.notes.remove(99)

  // All intents apply immediately, but only the lane head reaches the adapter.
  t.deepEqual(calls, ['create'])
  t.false(latest?.data?.some(n => n.id === 99))
  t.is(
    feathers.service('notes').counts.find,
    initialFindCount,
    'server-window reconciliation waits for the speculative lane',
  )

  createGate.resolve({ id: 99, content: 'created by server' })
  await created
  t.deepEqual(calls, ['create', 'patch:edited once'])
  t.false(
    latest?.data?.some(n => n.id === 99),
    'remaining remove keeps the row hidden',
  )

  firstPatchGate.resolve({ id: 99, content: 'first server patch' })
  await firstPatch
  t.deepEqual(calls, ['create', 'patch:edited once', 'patch:edited twice'])
  t.false(latest?.data?.some(n => n.id === 99))

  secondPatchGate.resolve({ id: 99, content: 'second server patch' })
  await secondPatch
  t.deepEqual(calls, ['create', 'patch:edited once', 'patch:edited twice', 'remove'])
  t.false(latest?.data?.some(n => n.id === 99))

  removeGate.resolve({ id: 99, content: 'second server patch' })
  await removed
  t.false(latest?.data?.some(n => n.id === 99))
  t.is(
    feathers.service('notes').counts.find,
    initialFindCount + 1,
    'the server window reconciles once after the lane drains',
  )
})

test('id contract: confirmed creates need no id — await the create for the server-assigned identity', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const { m } = figbird

  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  let latest: QueryState<Note[], Record<string, unknown>> | undefined
  ref.subscribe(state => {
    latest = state as QueryState<Note[], Record<string, unknown>>
  })
  await new Promise(r => setTimeout(r, 10))

  // A server that assigns ids.
  feathers.service('notes').create = ((data: Partial<Note>) =>
    Promise.resolve({ id: 500, ...data })) as never

  const created = await m.notes.confirmed.create({ content: 'server-owned' })
  t.is(created.id, 500)
  // The cache shows it only after (and because of) the ack.
  t.is(latest?.data?.find(n => n.content === 'server-owned')?.id, 500)
})

test('id contract: a failed optimistic create rolls the item back out of the cache', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const { m } = figbird

  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  let latest: QueryState<Note[], Record<string, unknown>> | undefined
  ref.subscribe(state => {
    latest = state as QueryState<Note[], Record<string, unknown>>
  })
  await new Promise(r => setTimeout(r, 10))

  let patchCalls = 0
  feathers.service('notes').create = (() => Promise.reject(new Error('rejected'))) as never
  feathers.service('notes').patch = (() => {
    patchCalls += 1
    return Promise.resolve({ id: 77, content: 'should not run' })
  }) as never

  const create = m.notes.create({ id: 77, content: 'doomed' })
  const dependentPatch = m.notes.patch(
    77,
    { content: 'still doomed' },
    { optimisticItem: { id: 77, content: 'explicitly doomed' } },
  )
  t.is(latest?.data?.find(note => note.id === 77)?.content, 'explicitly doomed')
  await t.throwsAsync(() => create, { message: 'rejected' })
  await t.throwsAsync(() => dependentPatch, { message: /cancelled queued mutations/ })
  t.false(latest?.data?.some(note => note.id === 77))
  t.is(latest?.data?.length, 2)
  t.is(patchCalls, 0)
})

test('create-id tracking: optimistic creates with client ids are visible to useMutating by id', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const { m } = figbird

  const gate = deferred<MockItem>()
  feathers.service('notes').create = (() => gate.promise) as never

  const pending = m.notes.create({ id: 42, content: 'tracked' })

  const inFlight = figbird.mutating.getSnapshot()
  t.is(inFlight.length, 1)
  t.like(inFlight[0], { serviceName: 'notes', method: 'create', id: 42 })

  gate.resolve({ id: 42, content: 'tracked' })
  await pending
  t.is(figbird.mutating.getSnapshot().length, 0)
})

// ----- useAction -----

interface ActionHarness<TArgs extends unknown[], TResult> {
  fn: (...args: TArgs) => Promise<TResult>
}

function renderAction<TArgs extends unknown[], TResult>(harness: ActionHarness<TArgs, TResult>) {
  const d = dom()
  let run!: (...args: TArgs) => Promise<void>
  let reset!: () => void

  function Probe() {
    const action = useAction(harness.fn)
    run = action.run
    reset = action.reset
    return (
      <div>
        <div className='pending'>{String(action.pending)}</div>
        <div className='error'>{action.error ? action.error.message : 'none'}</div>
        <div className='data'>{action.data === null ? 'null' : JSON.stringify(action.data)}</div>
      </div>
    )
  }

  d.render(<Probe />)
  const read = () => ({
    pending: d.$('.pending')!.textContent,
    error: d.$('.error')!.textContent,
    data: d.$('.data')!.textContent,
  })
  return { d, read, run: (...args: TArgs) => run(...args), reset: () => reset() }
}

test('useAction: pending is a counter across overlapping runs; data and args flow through', async t => {
  const gates: Array<ReturnType<typeof deferred<string>>> = []
  const harness: ActionHarness<[string], string> = {
    fn: async (input: string) => {
      const gate = deferred<string>()
      gates.push(gate)
      const value = await gate.promise
      return `${input}:${value}`
    },
  }
  const { d, read, run } = renderAction(harness)

  t.is(read().pending, 'false')

  let first!: Promise<void>
  let second!: Promise<void>
  await d.flush(() => {
    first = run('a')
    second = run('b')
  })
  t.is(read().pending, 'true')

  await d.flush(async () => {
    gates[0]!.resolve('one')
    await first
  })
  // One of two overlapping runs settled — still pending.
  t.is(read().pending, 'true')
  t.is(read().data, '"a:one"')

  await d.flush(async () => {
    gates[1]!.resolve('two')
    await second
  })
  t.is(read().pending, 'false')
  t.is(read().data, '"b:two"')
})

test('useAction: run never rejects; error is a slot cleared when a new run starts; reset clears it', async t => {
  const gates: Array<ReturnType<typeof deferred<string>>> = []
  const harness: ActionHarness<[], string> = {
    fn: () => {
      const gate = deferred<string>()
      gates.push(gate)
      return gate.promise
    },
  }
  const { d, read, run, reset } = renderAction(harness)

  let first!: Promise<void>
  await d.flush(() => {
    first = run()
  })
  await d.flush(async () => {
    gates[0]!.reject(new Error('first failure'))
    // run() captures the failure instead of rejecting.
    await t.notThrowsAsync(first)
  })
  t.is(read().error, 'first failure')
  t.is(read().pending, 'false')

  // Starting a new run clears the stale error immediately.
  let second!: Promise<void>
  await d.flush(() => {
    second = run()
  })
  t.is(read().error, 'none')
  t.is(read().pending, 'true')

  await d.flush(async () => {
    gates[1]!.reject(new Error('second failure'))
    await second
  })
  t.is(read().error, 'second failure')

  await d.flush(() => reset())
  t.is(read().error, 'none')
  t.is(read().data, 'null')
})

test('useAction: the action body sees the current render closure without a deps array', async t => {
  const d = dom()
  const results: string[] = []
  let run!: () => Promise<void>
  let bump!: () => void

  function Probe() {
    const [label, setLabel] = useState('initial')
    const action = useAction(async () => {
      results.push(label)
    })
    run = action.run
    bump = () => setLabel('updated')
    return <div className='pending'>{String(action.pending)}</div>
  }

  d.render(<Probe />)
  await d.flush(() => run())
  await d.flush(() => bump())
  await d.flush(() => run())
  t.deepEqual(results, ['initial', 'updated'])
})

test('useAction: settling after unmount does not update state', async t => {
  const gate = deferred<string>()
  const harness: ActionHarness<[], string> = { fn: () => gate.promise }
  const { d, run } = renderAction(harness)

  let pending!: Promise<void>
  await d.flush(() => {
    pending = run()
  })
  d.unmount()
  gate.resolve('late')
  await t.notThrowsAsync(pending)
})

test('useAction (kit): named actions report action:start/end/error through the bound instance', async t => {
  const { App, figbird } = createTestApp(schema, services())
  const { useAction: useKitAction } = createHooks(schema)
  t.is(useKitAction, useAction)
  const events = collectEvents(figbird, 'action:')

  const d = dom()
  let succeed!: () => Promise<void>
  let fail!: () => Promise<void>

  function Probe() {
    const ok = useKitAction('boost', async () => 'done')
    const bad = useKitAction('explode', async () => {
      throw new Error('kaboom')
    })
    succeed = ok.run
    fail = bad.run
    return <div className='pending'>{String(ok.pending || bad.pending)}</div>
  }

  d.render(
    <App>
      <Probe />
    </App>,
  )

  await d.flush(async () => {
    await succeed()
    await fail()
  })
  await d.flush()

  const summary = events.map(e => `${e.kind}:${'name' in e ? e.name : ''}`)
  t.deepEqual(summary, [
    'action:start:boost',
    'action:end:boost',
    'action:start:explode',
    'action:error:explode',
  ])
  const [start, end] = events as Array<{ actionId: number }>
  t.is(start!.actionId, end!.actionId, 'start/end correlate per invocation')
  const errorEvent = events.find(e => e.kind === 'action:error')
  t.is((errorEvent as { error: Error }).error.message, 'kaboom')
})

// ----- form action interop -----

test('useAction: run works as a React 19 <form action>', async t => {
  const d = dom()
  // React builds `new FormData(form)` via the global constructor; Node's
  // built-in (undici) FormData can't read a jsdom form — use jsdom's.
  const g = globalThis as { FormData?: unknown; window?: Window }
  const prevFormData = g.FormData
  g.FormData = (g.window as unknown as { FormData: unknown }).FormData
  t.teardown(() => {
    g.FormData = prevFormData
  })

  const received: Array<string | null> = []
  let pendingText = ''

  function Probe() {
    const submit = useAction(async (formData: FormData) => {
      received.push(formData.get('title') as string | null)
    })
    pendingText = String(submit.pending)
    return (
      <form action={submit.run}>
        <input name='title' defaultValue='hello form' />
        <button type='submit'>Go</button>
      </form>
    )
  }

  d.render(<Probe />)
  await d.flush(async () => {
    const form = d.$('form') as HTMLFormElement
    form.requestSubmit()
    // React dispatches form actions on a transition lane — give it a beat.
    await new Promise(r => setTimeout(r, 20))
  })

  t.deepEqual(received, ['hello form'])
  t.is(pendingText, 'false')
})

// ----- useMutating -----

function renderMutating(
  App: React.ComponentType<{ children?: React.ReactNode }>,
  hook: () => boolean,
) {
  const d = dom()
  function Probe() {
    return <div className='busy'>{String(hook())}</div>
  }
  d.render(
    <App>
      <Probe />
    </App>,
  )
  return { d, read: () => d.$('.busy')!.textContent }
}

test('useMutating: reflects in-flight mutations by service and id, including custom methods', async t => {
  const { App, figbird, feathers } = createTestApp(schema, services())
  const { useMutating } = createHooks(schema)
  const { m } = figbird

  const gate = deferred<MockItem>()
  feathers.service('notes').patch = () => gate.promise

  const anyMutation = renderMutating(App, () => useMutating())
  const noteOne = renderMutating(App, () => useMutating({ service: 'notes', id: 1 }))
  const noteTwo = renderMutating(App, () => useMutating({ service: 'notes', id: 2 }))
  const byMethod = renderMutating(App, () => useMutating({ service: 'notes', method: 'patch' }))

  t.is(anyMutation.read(), 'false')

  let pending!: Promise<Note>
  await anyMutation.d.act(() => {
    pending = m.notes.patch(1, { content: 'busy' })
  })

  t.is(anyMutation.read(), 'true')
  t.is(noteOne.read(), 'true')
  t.is(noteTwo.read(), 'false')
  t.is(byMethod.read(), 'true')

  await anyMutation.d.flush(async () => {
    gate.resolve({ id: 1, content: 'busy' })
    await pending
  })

  t.is(anyMutation.read(), 'false')
  t.is(noteOne.read(), 'false')
  t.is(byMethod.read(), 'false')
})

test('useMutating: a component that mounts while a mutation is already in flight reports true', async t => {
  const { App, figbird, feathers } = createTestApp(schema, services())
  const { useMutating } = createHooks(schema)
  const { m } = figbird

  const gate = deferred<MockItem>()
  feathers.service('notes').patch = () => gate.promise

  // Start the mutation BEFORE any subscriber exists — an events-based
  // implementation would miss the start and report false here.
  const pending = m.notes.patch(1, { content: 'early' })

  const probe = renderMutating(App, () => useMutating({ service: 'notes' }))
  t.is(probe.read(), 'true')

  await probe.d.flush(async () => {
    gate.resolve({ id: 1, content: 'early' })
    await pending
  })
  t.is(probe.read(), 'false')
})

test('useMutating: service filter resolves schema aliases to transport paths', async t => {
  const { App, figbird, feathers } = createTestApp(schema, services())
  const { useMutating } = createHooks(schema)
  const { m } = figbird

  const gate = deferred<{ id: number; name: string }>()
  feathers.service('api/people').patch = () => gate.promise

  // Filter by schema key; the tracker records the resolved 'api/people' path.
  const probe = renderMutating(App, () => useMutating({ service: 'people' }))
  t.is(probe.read(), 'false')

  let pending!: Promise<{ id: number; name: string }>
  await probe.d.act(() => {
    pending = m.people.patch(1, { name: 'Grace' })
  })
  t.is(probe.read(), 'true')

  await probe.d.flush(async () => {
    gate.resolve({ id: 1, name: 'Grace' })
    await pending
  })
  t.is(probe.read(), 'false')
})
