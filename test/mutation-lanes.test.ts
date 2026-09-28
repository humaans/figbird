import test from 'ava'
import type { QueryState } from '../lib'
import { createTestApp } from './helpers'
import { deferred, schema, services, type MockItem, type Note } from './mutation-test-helpers'

test('mutation lanes: overlay-only fetch replay reconciles its server window after settlement', async t => {
  const initial = services()
  const seeded = {
    ...initial,
    notes: { data: { ...initial.notes.data, 3: { id: 3, content: 'third' } } },
  }
  const { figbird, feathers } = createTestApp(schema, seeded)
  const getRef = figbird.queryDesc({ serviceName: 'notes', method: 'get', resourceId: 1 })
  getRef.subscribe(() => {})
  await new Promise(resolve => setTimeout(resolve, 10))

  const removeGate = deferred<MockItem>()
  const notes = feathers.service('notes')
  notes.remove = (() => removeGate.promise) as never
  const removing = figbird.m.notes.remove(1)

  const windowRef = figbird.queryDesc({
    serviceName: 'notes',
    method: 'find',
    params: { query: { $sort: { id: 1 }, $limit: 2 } },
  })
  let latest: QueryState<Note[], Record<string, unknown>> | undefined
  windowRef.subscribe(state => {
    latest = state as QueryState<Note[], Record<string, unknown>>
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  t.deepEqual(
    latest?.data?.map(note => note.id),
    [2],
  )
  const findCount = notes.counts.find

  delete notes.data[1]
  removeGate.resolve({ id: 1, content: 'hello' })
  await removing
  await new Promise(resolve => setTimeout(resolve, 10))

  t.is(notes.counts.find, findCount + 1)
  t.deepEqual(
    latest?.data?.map(note => note.id),
    [2, 3],
  )
})

test('mutation lanes: a batched projection still settles and refetches after its lane releases', async t => {
  const { figbird, feathers } = createTestApp(schema, services(), { eventBatchInterval: 20 })
  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' }, { realtime: 'refetch' })
  let latest: QueryState<Note[], Record<string, unknown>> | undefined
  ref.subscribe(state => {
    latest = state as QueryState<Note[], Record<string, unknown>>
  })
  await new Promise(resolve => setTimeout(resolve, 30))
  const initialFindCount = feathers.service('notes').counts.find

  const patchGate = deferred<MockItem>()
  const notes = feathers.service('notes')
  notes.patch = (() => patchGate.promise) as never
  let settlements = 0
  figbird.queryStore.subscribeToProjectionSettlements(() => {
    settlements += 1
  })

  const pending = figbird.m.notes.confirmed.patch(1, { content: 'mine' })
  notes.data[1] = { id: 1, content: 'other client' }
  notes.emit('patched', notes.data[1])
  patchGate.reject(new Error('mine failed'))
  await t.throwsAsync(() => pending, { message: 'mine failed' })
  await new Promise(resolve => setTimeout(resolve, 40))

  t.is(settlements, 1)
  t.is(feathers.service('notes').counts.find, initialFindCount + 1)
  t.is(latest?.data?.find(note => note.id === 1)?.content, 'other client')
})

test('mutation lanes: realtime that overtakes an acknowledgement keeps the newer state', async t => {
  const { figbird, feathers } = createTestApp(schema, {
    ...services(),
    notes: {
      data: {
        1: { id: 1, content: 'hello', updatedAt: 1 },
        2: { id: 2, content: 'world', updatedAt: 1 },
      },
    },
  })
  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  let latest: QueryState<Note[], Record<string, unknown>> | undefined
  ref.subscribe(state => {
    latest = state as QueryState<Note[], Record<string, unknown>>
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  const notes = feathers.service('notes')

  const olderAck = deferred<MockItem>()
  notes.patch = (() => olderAck.promise) as never
  const patching = figbird.m.notes.patch(1, { content: 'mine' })
  notes.emit('patched', { id: 1, content: 'other client', updatedAt: 3 })
  await new Promise(resolve => setTimeout(resolve, 10))
  olderAck.resolve({ id: 1, content: 'mine', updatedAt: 2 })
  await patching
  await new Promise(resolve => setTimeout(resolve, 10))
  t.is(latest?.data?.find(note => note.id === 1)?.content, 'other client')

  const removedAfterPatch = deferred<MockItem>()
  notes.patch = (() => removedAfterPatch.promise) as never
  const patchingRemoved = figbird.m.notes.patch(2, { content: 'mine' })
  notes.emit('removed', { id: 2, content: 'world', updatedAt: 1 })
  await new Promise(resolve => setTimeout(resolve, 10))
  removedAfterPatch.resolve({ id: 2, content: 'mine', updatedAt: 2 })
  await patchingRemoved
  await new Promise(resolve => setTimeout(resolve, 10))
  t.deepEqual(
    latest?.data?.map(note => note.id),
    [1],
    'the acknowledgement does not resurrect a row removed after the patch',
  )
})

test('mutation lanes: the echo of our own remove does not swallow a re-create', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  let latest: QueryState<Note[], Record<string, unknown>> | undefined
  ref.subscribe(state => {
    latest = state as QueryState<Note[], Record<string, unknown>>
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  const notes = feathers.service('notes')

  const createGate = deferred<MockItem>()
  notes.remove = (() => Promise.resolve({ id: 1, content: 'hello' })) as never
  notes.create = (() => createGate.promise) as never
  const removing = figbird.m.notes.remove(1)
  const recreating = figbird.m.notes.create({ id: 1, content: 'again' })
  await removing
  // Feathers acknowledges before it publishes: the remove's echo lands mid-create.
  notes.emit('removed', { id: 1, content: 'hello' })
  await new Promise(resolve => setTimeout(resolve, 10))
  createGate.resolve({ id: 1, content: 'again' })
  await recreating
  await new Promise(resolve => setTimeout(resolve, 10))

  t.is(latest?.data?.find(note => note.id === 1)?.content, 'again')
})

test('mutation lanes: a re-create after a mid-flight removal outranks the older acknowledgement', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  let latest: QueryState<Note[], Record<string, unknown>> | undefined
  ref.subscribe(state => {
    latest = state as QueryState<Note[], Record<string, unknown>>
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  const notes = feathers.service('notes')

  // No updatedAt anywhere, so staleness can't decide; event order must.
  const ack = deferred<MockItem>()
  notes.patch = (() => ack.promise) as never
  const patching = figbird.m.notes.patch(2, { content: 'mine' })
  notes.emit('removed', { id: 2, content: 'world' })
  notes.emit('created', { id: 2, content: 'recreated elsewhere' })
  await new Promise(resolve => setTimeout(resolve, 10))
  ack.resolve({ id: 2, content: 'mine' })
  await patching
  await new Promise(resolve => setTimeout(resolve, 10))

  t.is(latest?.data?.find(note => note.id === 2)?.content, 'recreated elsewhere')
})

test('mutation lanes: batch create acknowledgements advance lanes opened by later patches', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  let latest: QueryState<Note[], Record<string, unknown>> | undefined
  ref.subscribe(state => {
    latest = state as QueryState<Note[], Record<string, unknown>>
  })
  await new Promise(resolve => setTimeout(resolve, 10))

  const createGate = deferred<MockItem[]>()
  const patchGate = deferred<MockItem>()
  feathers.service('notes').create = (() => createGate.promise) as never
  feathers.service('notes').patch = (() => patchGate.promise) as never

  const created = figbird.mutateDesc({
    serviceName: 'notes',
    method: 'create',
    data: [{ id: 10, content: 'optimistic create' }],
    optimistic: true,
  })
  const patched = figbird.m.notes.patch(10, { content: 'optimistic patch' })
  createGate.resolve([{ id: 10, content: 'server create' }])
  await created
  patchGate.reject(new Error('patch failed'))
  await t.throwsAsync(() => patched, { message: 'patch failed' })

  t.is(latest?.data?.find(note => note.id === 10)?.content, 'server create')
})

test('mutation lanes: route-string ids and numeric server ids share one lane and cache key', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  let latest: QueryState<Note[], Record<string, unknown>> | undefined
  ref.subscribe(state => {
    latest = state as QueryState<Note[], Record<string, unknown>>
  })
  await new Promise(resolve => setTimeout(resolve, 10))

  const patchGate = deferred<MockItem>()
  const notes = feathers.service('notes')
  notes.patch = (() => patchGate.promise) as never
  const pending = figbird.m.notes.patch('1', { content: 'optimistic' })
  notes.data[1] = { id: 1, content: 'numeric server event' }
  notes.emit('patched', notes.data[1])
  patchGate.reject(new Error('patch failed'))
  await t.throwsAsync(() => pending, { message: 'patch failed' })

  t.is(latest?.data?.find(note => note.id === 1)?.content, 'numeric server event')
  t.is(latest?.data?.filter(note => String(note.id) === '1').length, 1)
  t.is(figbird.getState().get('notes')?.entities.size, 2)
})

test('mutation lanes: removing an uncached row still invalidates refetch queries', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const ref = figbird.queryDesc(
    {
      serviceName: 'notes',
      method: 'find',
      params: { query: { $limit: 1 } },
    },
    { realtime: 'refetch' },
  )
  ref.subscribe(() => {})
  await new Promise(resolve => setTimeout(resolve, 10))
  const notes = feathers.service('notes')
  const initialFindCount = notes.counts.find
  notes.remove = (() => {
    const removed = notes.data[2]!
    delete notes.data[2]
    return Promise.resolve(removed)
  }) as never

  await figbird.m.notes.confirmed.remove(2)
  await new Promise(resolve => setTimeout(resolve, 0))
  t.is(notes.counts.find, initialFindCount + 1)
})

test('mutations: null-id bulk removes apply every returned row', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  let latest: QueryState<Note[], Record<string, unknown>> | undefined
  ref.subscribe(state => {
    latest = state as QueryState<Note[], Record<string, unknown>>
  })
  await new Promise(resolve => setTimeout(resolve, 10))

  const notes = feathers.service('notes')
  notes.remove = (() => {
    const removed = Object.values(notes.data)
    notes.data = {}
    return Promise.resolve(removed)
  }) as never
  await figbird.queryStore.mutate({
    serviceName: 'notes',
    method: 'remove',
    id: null as never,
    params: { query: { done: true } },
    optimistic: false,
  })

  t.deepEqual(latest?.data, [])
})

test('mutation lanes: explicit optimistic create ids serialize dependent patches', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const createGate = deferred<MockItem>()
  const patchGate = deferred<MockItem>()
  const calls: string[] = []
  feathers.service('notes').create = (() => {
    calls.push('create')
    return createGate.promise
  }) as never
  feathers.service('notes').patch = (() => {
    calls.push('patch')
    return patchGate.promise
  }) as never

  const created = figbird.m.notes.create(
    { content: 'wire create' },
    { optimisticItem: { id: 10, content: 'optimistic create' } },
  )
  const patched = figbird.m.notes.patch(10, { content: 'dependent patch' })
  t.deepEqual(calls, ['create'])

  createGate.resolve({ id: 10, content: 'server create' })
  await created
  t.deepEqual(calls, ['create', 'patch'])
  patchGate.resolve({ id: 10, content: 'dependent patch' })
  await patched
})

test('mutation lanes: raw confirmed creates with client ids serialize dependent patches', async t => {
  const { figbird, feathers } = createTestApp(schema, services())
  const createGate = deferred<MockItem>()
  const patchGate = deferred<MockItem>()
  const calls: string[] = []
  feathers.service('notes').create = (() => {
    calls.push('create')
    return createGate.promise
  }) as never
  feathers.service('notes').patch = (() => {
    calls.push('patch')
    return patchGate.promise
  }) as never

  const created = figbird.mutateDesc({
    serviceName: 'notes',
    method: 'create',
    data: { id: 10, content: 'wire create' },
  })
  const patched = figbird.m.notes.patch(10, { content: 'dependent patch' })
  t.deepEqual(calls, ['create'])

  createGate.resolve({ id: 10, content: 'server create' })
  await created
  t.deepEqual(calls, ['create', 'patch'])
  patchGate.resolve({ id: 10, content: 'dependent patch' })
  await patched
})
