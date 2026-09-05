import test from 'ava'
import {
  feathersTransactions,
  FeathersTransactionError,
  type FigbirdEvent,
  type QueryState,
} from '../lib'
import { createTestApp } from './helpers'
import {
  collectEvents,
  deferred,
  schema,
  services,
  type ArchiveResult,
  type MockItem,
  type Note,
} from './mutation-test-helpers'

// ----- the m proxy -----

test('m: write policies and ordered transactions share record lanes', async t => {
  const { figbird, adapter, feathers } = createTestApp(schema, {
    ...services(),
    'api/transactions': { data: {} },
  })
  const { m } = figbird
  const events = collectEvents(figbird, 'mutate:')

  const patched = await m.notes.patch(1, { content: 'updated' })
  t.is(patched.content, 'updated')

  await m.notes.confirmed.patch(1, { content: 'again' })

  const policies = m.notes.confirmed // named surface handle
  await policies.patch(1, { content: 'third' })

  let transactionOperations: readonly unknown[] = []
  let transactionCalls = 0
  const parent = { id: 10, content: 'parent' }
  const child = { id: 11, content: 'child', parentId: parent.id }
  let transactionPayload: unknown
  feathers.service('api/transactions').create = ((data: unknown) => {
    transactionPayload = data
    return Promise.resolve({
      id: 'transaction_1',
      data: [
        { status: 'fulfilled', value: { id: 1, content: 'transactional' } },
        { status: 'fulfilled', value: { id: 1, name: 'Grace' } },
        { status: 'fulfilled', value: parent },
        { status: 'fulfilled', value: child },
      ],
    })
  }) as never
  const transact = feathersTransactions()
  adapter.transaction = operations => {
    transactionCalls += 1
    transactionOperations = operations
    return transact(feathers, operations)
  }
  await figbird.transaction(tx => {
    tx.m.notes.patch(1, { content: 'transactional' })
    tx.m.people.confirmed.patch(1, { name: 'Grace' })
    tx.m.notes.create(parent)
    tx.m.notes.create(child)
  })
  t.deepEqual(transactionOperations, [
    { serviceName: 'notes', method: 'patch', args: [1, { content: 'transactional' }] },
    { serviceName: 'api/people', method: 'patch', args: [1, { name: 'Grace' }] },
    { serviceName: 'notes', method: 'create', args: [parent] },
    { serviceName: 'notes', method: 'create', args: [child] },
  ])
  t.deepEqual(transactionPayload, {
    serial: true,
    calls: [
      ['patch', 'notes', 1, { content: 'transactional' }],
      ['patch', 'api/people', 1, { name: 'Grace' }],
      ['create', 'notes', parent],
      ['create', 'notes', child],
    ],
  })

  await Promise.resolve()
  const starts = events.filter(e => e.kind === 'mutate:start')
  t.deepEqual(
    starts.map(e => e.optimistic),
    [true, false, false, true, false, true, true],
  )

  // If one lane invalidates a transaction before another lane reaches the
  // barrier, an aborted create must still cancel mutations queued behind it.
  const notePredecessorGate = deferred<MockItem>()
  const failingPersonCreateGate = deferred<{ id: number; name: string }>()
  feathers.service('notes').patch = (() => notePredecessorGate.promise) as never
  feathers.service('api/people').create = (() => failingPersonCreateGate.promise) as never

  const notePredecessor = m.notes.confirmed.patch(99, { content: 'predecessor' })
  const failingPersonCreate = m.people.create({ id: 77, name: 'draft' })
  const abortedTransaction = figbird.transaction(tx => {
    tx.m.notes.create({ id: 99, content: 'transaction create' })
    tx.m.people.patch(77, { name: 'transaction patch' })
  })
  const dependentNotePatch = m.notes.patch(99, { content: 'dependent' })

  const createError = t.throwsAsync(failingPersonCreate, { message: 'create failed' })
  const transactionError = t.throwsAsync(abortedTransaction, { message: /cancelled transaction/ })
  const dependentError = t.throwsAsync(dependentNotePatch, {
    message: /cancelled queued mutations/,
  })
  failingPersonCreateGate.reject(new Error('create failed'))
  await Promise.all([createError, transactionError, dependentError])
  t.is(transactionCalls, 1, 'the invalidated transaction never reaches the adapter')

  notePredecessorGate.resolve({ id: 99, content: 'predecessor' })
  await notePredecessor
})

test('transactions: validate stable, unique entity ids before reserving lanes', t => {
  const { figbird, adapter } = createTestApp(schema, services())
  let transactionCalls = 0
  adapter.transaction = () => {
    transactionCalls += 1
    return Promise.resolve([])
  }

  const error = t.throws(() =>
    figbird.transaction(tx => {
      tx.m.notes.patch(1, { content: 'numeric id' })
      tx.m.notes.patch('1', { content: 'string id' })
    }),
  )

  t.regex(error!.message, /can mutate "notes"\/1 only once/)
  t.throws(
    () =>
      figbird.transaction(tx =>
        tx.m.notes.create({ content: 'missing id' }, { optimisticItem: { id: 10, content: '' } }),
      ),
    { message: /requires a stable entity id/ },
  )
  t.throws(
    () =>
      figbird.transaction(tx =>
        tx.m.notes.create({ id: 10, content: '' }, { optimisticItem: { id: 11, content: '' } }),
      ),
    { message: /must preserve its payload id/ },
  )
  t.is(transactionCalls, 0)
  t.is(figbird.mutating.getSnapshot().length, 0)
})

test('transactions: commit, cascading cancellation and rollback publish grouped settlements', async t => {
  const { figbird, adapter, feathers } = createTestApp(schema, {
    ...services(),
    'api/batch': { data: {} },
  })
  const notesRef = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  const peopleRef = figbird.queryDesc({ serviceName: 'api/people', method: 'find' })
  const unsubscribeNotes = notesRef.subscribe(() => {})
  const unsubscribePeople = peopleRef.subscribe(() => {})
  await new Promise(resolve => setTimeout(resolve, 10))

  const transactionGate = deferred<readonly unknown[]>()
  let transactionCalls = 0
  adapter.transaction = () => {
    transactionCalls += 1
    return transactionGate.promise
  }

  const committing = figbird.transaction(tx => {
    tx.m.notes.remove(1)
    tx.m.people.patch(1, { name: 'optimistic name' })
  })
  const cancelled = figbird.transaction(tx => {
    tx.m.notes.patch(1, { content: 'old lifetime' })
    tx.m.notes.patch(2, { content: 'doomed sibling' })
  })

  const snapshots: Array<{
    hasRemovedNote: boolean
    siblingContent: string | undefined
    personName: string | undefined
  }> = []
  const unsubscribeState = figbird.subscribeToStateChanges(state => {
    const notes = state.get('notes')?.entities
    const people = state.get('api/people')?.entities
    snapshots.push({
      hasRemovedNote: notes?.has('1') ?? false,
      siblingContent: (notes?.get('2') as Note | undefined)?.content,
      personName: (people?.get('1') as { name: string } | undefined)?.name,
    })
  })

  const cancelledError = t.throwsAsync(cancelled, { message: /cancelled transaction/ })
  transactionGate.resolve([
    { id: 1, content: 'hello' },
    { id: 1, name: 'server name' },
  ])
  await Promise.all([committing, cancelledError])

  t.is(transactionCalls, 1, 'the cancelled transaction never reaches the adapter')
  t.deepEqual(snapshots, [
    {
      hasRemovedNote: false,
      siblingContent: 'world',
      personName: 'server name',
    },
  ])

  snapshots.length = 0
  feathers.service('api/batch').create = (() =>
    Promise.resolve({
      data: [
        { status: 'fulfilled', value: { id: 2, content: 'rolled back on server' } },
        { status: 'rejected', reason: 'Permission denied' },
      ],
    })) as never
  const transact = feathersTransactions({ serviceName: 'api/batch' })
  adapter.transaction = operations => transact(feathers, operations)
  await t.throwsAsync(
    figbird.transaction(tx => {
      tx.m.notes.patch(2, { content: 'optimistic note' })
      tx.m.people.patch(1, { name: 'optimistic person' })
    }),
    { instanceOf: FeathersTransactionError },
  )
  t.deepEqual(snapshots, [
    {
      hasRemovedNote: false,
      siblingContent: 'optimistic note',
      personName: 'optimistic person',
    },
    {
      hasRemovedNote: false,
      siblingContent: 'world',
      personName: 'server name',
    },
  ])

  unsubscribeState()
  unsubscribePeople()
  unsubscribeNotes()
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
  const { m } = figbird
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

test('mutate events carry correlating mutation and causal ids', async t => {
  const { figbird } = createTestApp(schema, services())
  const { m } = figbird
  const events = collectEvents(figbird, 'mutate:')
  const observed: FigbirdEvent[] = []
  figbird.events.subscribe(event => observed.push(event))

  await m.notes.patch(1, { content: 'a' })
  await m.notes.patch(2, { content: 'b' })
  await Promise.resolve()

  const ids = (events as Array<{ mutationId: number }>).map(e => e.mutationId)
  t.is(ids.length, 4)
  t.is(ids[0], ids[1], 'first start/end pair correlates')
  t.is(ids[2], ids[3], 'second start/end pair correlates')
  t.not(ids[0], ids[2], 'distinct mutations get distinct ids')

  const traces = events.map(event => ('traceId' in event ? event.traceId : undefined))
  t.is(traces[0], traces[1], 'first mutation lifecycle shares one causal trace')
  t.is(traces[2], traces[3], 'second mutation lifecycle shares one causal trace')
  t.not(traces[0], traces[2], 'distinct mutations get distinct causal traces')
  t.true(
    observed.some(event => event.kind === 'cache:updated' && event.traceId === traces[0]),
    'the mutation cache transition joins the mutation trace',
  )
  t.false(
    observed.some(event => event.kind === 'realtime'),
    'mutation acknowledgements are not reported as realtime traffic',
  )
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
