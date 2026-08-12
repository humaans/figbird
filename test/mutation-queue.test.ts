import test from 'ava'
import type { FigbirdEvent, QueryState } from '../lib'
import { isMutationSupersededError } from '../lib'
import { createTestApp } from './helpers'
import { deferred, schema, services, type MockItem, type Note } from './mutation-test-helpers'

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
  const mutationEvents: FigbirdEvent[] = []
  const unsubscribeMutationEvents = figbird.events.subscribe(event => mutationEvents.push(event))
  const unsubscribeEvents = figbird.queryStore.subscribeToProcessedEvents(event => {
    if (event.origin === 'projection' && event.itemId === 1) projectionEvents += 1
  })
  const unsubscribeSettlements = figbird.queryStore.subscribeToProjectionSettlements(event => {
    if (event.itemId === 1) projectionSettlements += 1
  })
  const first = queue.m.notes.patch(1, { content: 'e' })
  const second = queue.m.notes.patch(1, { content: 'edited' })
  await Promise.resolve()

  t.is(first, second, 'coalesced callers share the outgoing request')
  t.is(latest?.data?.find(note => note.id === 1)?.content, 'edited')
  t.is(calls.length, 0)
  t.is(projectionEvents, 2)
  t.is(projectionSettlements, 0)
  t.deepEqual(queue.getSnapshot(), { status: 'scheduled', pending: 1, error: null })
  const coalesced = mutationEvents.find(event => event.kind === 'mutate:update')
  t.deepEqual(coalesced && 'args' in coalesced ? coalesced.args : undefined, [
    1,
    { content: 'edited' },
  ])

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
  unsubscribeMutationEvents()
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

test('mutation queue: an immediate write expedites every debounced lane predecessor', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const gates = [deferred<MockItem>(), deferred<MockItem>(), deferred<MockItem>()]
  const calls: string[] = []
  feathers.service('notes').patch = ((_id: number, data: Partial<Note>) => {
    const gate = gates[calls.length]!
    calls.push(data.content!)
    return gate.promise
  }) as never

  const running = figbird.m.notes.patch(1, { content: 'running' })
  const queue = figbird.createMutationQueue({ schedule: () => ({ wait: 10_000 }) })
  const queued = queue.m.notes.patch(1, { content: 'debounced predecessor' })
  const immediate = figbird.m.notes.patch(1, { content: 'immediate follower' })

  gates[0]!.resolve({ id: 1, content: 'running' })
  await running
  t.deepEqual(calls, ['running', 'debounced predecessor'])
  gates[1]!.resolve({ id: 1, content: 'debounced predecessor' })
  await queued
  t.deepEqual(calls, ['running', 'debounced predecessor', 'immediate follower'])
  gates[2]!.resolve({ id: 1, content: 'immediate follower' })
  await immediate
})

test('mutation queue: flushing a second queue expedites debounced same-record predecessors', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const gates = [deferred<MockItem>(), deferred<MockItem>()]
  const calls: string[] = []
  feathers.service('notes').patch = ((_id: number, data: Partial<Note>) => {
    const gate = gates[calls.length]!
    calls.push(data.content!)
    return gate.promise
  }) as never

  const firstQueue = figbird.createMutationQueue({ schedule: () => ({ wait: 10_000 }) })
  const secondQueue = figbird.createMutationQueue({ schedule: () => ({ wait: 10_000 }) })
  const first = firstQueue.m.notes.patch(1, { content: 'first queue' })
  const second = secondQueue.m.notes.patch(1, { content: 'second queue' })
  secondQueue.flush()

  t.deepEqual(calls, ['first queue'])
  gates[0]!.resolve({ id: 1, content: 'first queue' })
  await first
  t.deepEqual(calls, ['first queue', 'second queue'])
  gates[1]!.resolve({ id: 1, content: 'second queue' })
  await second
})

test('mutation queue: structurally equal params still coalesce patches', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const gate = deferred<MockItem>()
  const calls: Array<[Partial<Note>, unknown]> = []
  feathers.service('notes').patch = ((_id: number, data: Partial<Note>, params: unknown) => {
    calls.push([data, params])
    return gate.promise
  }) as never
  const queue = figbird.createMutationQueue({ schedule: () => ({ wait: 10_000 }) })

  const first = queue.m.notes.patch(
    1,
    { content: 'a' },
    { params: { query: { $select: ['content'] } } },
  )
  const second = queue.m.notes.patch(
    1,
    { content: 'ab' },
    { params: { query: { $select: ['content'] } } },
  )
  t.is(first, second)
  queue.flush()
  t.is(calls.length, 1)
  t.deepEqual(calls[0]?.[0], { content: 'ab' })
  gate.resolve({ id: 1, content: 'ab' })
  await second
})

test('mutation queue: cancelled non-head items cannot shorten the head deadline', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const removeGate = deferred<MockItem>()
  const patchGate = deferred<MockItem>()
  const calls: string[] = []
  feathers.service('notes').remove = (() => removeGate.promise) as never
  feathers.service('notes').patch = ((_id: number, data: Partial<Note>) => {
    calls.push(data.content!)
    return patchGate.promise
  }) as never

  const removing = figbird.m.notes.remove(1)
  const queue = figbird.createMutationQueue({
    schedule: operation => ({ wait: operation.id === 2 ? 500 : 40 }),
  })
  const head = queue.m.notes.patch(2, { content: 'slow head' })
  const cancelled = queue.m.notes.patch(1, { content: 'cancelled follower' })
  const cancelledError = t.throwsAsync(() => cancelled)

  removeGate.resolve({ id: 1, content: 'hello' })
  await removing
  t.true(isMutationSupersededError(await cancelledError))
  await new Promise(resolve => setTimeout(resolve, 80))
  t.deepEqual(calls, [])

  queue.flush()
  t.deepEqual(calls, ['slow head'])
  patchGate.resolve({ id: 2, content: 'slow head' })
  await head
})

test('mutation queue: throwing subscribers cannot fail transport', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const queue = figbird.createMutationQueue()
  queue.subscribe(() => {
    throw new Error('subscriber failed')
  })

  const result = await queue.m.notes.patch(1, { content: 'saved' })
  t.is(result.content, 'saved')
  t.is(feathers.service('notes').counts.patch, 1)
  t.is(queue.status, 'idle')
})

test('mutation queue: a throwing retryDelay cannot replace the transport failure', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  let calls = 0
  feathers.service('notes').patch = ((_id: number, data: Partial<Note>) => {
    calls += 1
    return calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve({ id: 1, ...data })
  }) as never
  const queue = figbird.createMutationQueue({
    retry: 1,
    retryDelay: () => {
      throw new Error('bad timing hook')
    },
  })

  const result = await queue.m.notes.patch(1, { content: 'retried' })
  t.is(result.content, 'retried')
  t.is(calls, 2)
})

test('mutation queue: a throwing retry predicate preserves the terminal failure', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  feathers.service('notes').patch = (() => Promise.reject(new Error('offline'))) as never
  const queue = figbird.createMutationQueue({
    retry: () => {
      throw new Error('bad retry policy')
    },
  })

  const pending = queue.m.notes.patch(1, { content: 'unsaved' })
  await new Promise(resolve => setTimeout(resolve, 0))

  t.is(queue.status, 'failed')
  t.is(queue.error?.message, 'offline')
  queue.discard()
  await t.throwsAsync(() => pending, { message: 'offline' })
})

test('mutation queue: each item keeps the retry policy captured at registration', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const firstAttempt = deferred<MockItem>()
  let calls = 0
  feathers.service('notes').patch = ((_id: number, data: Partial<Note>) => {
    calls += 1
    if (calls === 1) return firstAttempt.promise
    if (calls === 2) return Promise.reject(new Error('offline again'))
    return Promise.resolve({ id: 1, ...data })
  }) as never

  const queue = figbird.createMutationQueue({ retry: false })
  const first = queue.m.notes.patch(1, { content: 'do not retry' })
  const firstRejected = t.throwsAsync(() => first, { message: 'offline' })
  queue.setConfig({ retry: 1 })
  firstAttempt.reject(new Error('offline'))
  await new Promise(resolve => setTimeout(resolve, 0))

  t.is(queue.status, 'failed')
  t.is(calls, 1)
  queue.discard()
  await firstRejected

  const second = await queue.m.notes.patch(1, { content: 'retry this one' })
  t.is(second.content, 'retry this one')
  t.is(calls, 3)
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
