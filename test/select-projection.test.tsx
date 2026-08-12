/**
 * `$select` projections and the entity cache: projected rows are the correct result
 * for their own query, but must never enter the entity cache, which only ever holds
 * complete rows (the materialized local-answer paths depend on it).
 */
import test from 'ava'
import { createSchema, FeathersAdapter, Figbird, service } from '../lib'
import type { MockFeathers, TestItem } from '../lib/testing.js'
import { mockFeathers } from './helpers'

interface Note {
  id: number
  title: string
  body: string
  updatedAt?: number
}

const schema = createSchema({
  services: {
    notes: service<{ item: Note }>(),
  },
})

const updatedAt = new Date('2024-02-02').getTime()

const noteRows = (): Record<string, TestItem> => ({
  1: { id: 1, title: 'First', body: 'First body', updatedAt },
  2: { id: 2, title: 'Second', body: 'Second body', updatedAt },
})

function project(item: TestItem, select: unknown): TestItem {
  if (!Array.isArray(select)) return item
  const projected: TestItem = {}
  for (const field of select as string[]) {
    if (field in item) projected[field] = item[field]
  }
  return projected
}

/** The shared mock service ignores `$select`, so wrap `find`/`get` to project. */
function createApp() {
  const feathers: MockFeathers = mockFeathers({ notes: { data: noteRows() } })
  const notes = feathers.service('notes')

  const baseFind = notes.find.bind(notes)
  const baseGet = notes.get.bind(notes)
  const selectFinds: unknown[] = []

  notes.find = async (params: { query?: Record<string, unknown> } = {}) => {
    const select = params.query?.$select
    if (select) selectFinds.push(select)
    const result = await baseFind(params)
    return { ...result, data: result.data.map(item => project(item, select)) }
  }

  notes.get = async (id: string | number, params: { query?: Record<string, unknown> } = {}) => {
    const item = await baseGet(id, params)
    return project(item, params.query?.$select)
  }

  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({
    schema,
    adapter,
    eventBatchInterval: 0,
    reconcileCooldown: 0,
    retry: false,
    defaultSort: { id: 1 },
  })

  return { figbird, feathers, notes, selectFinds }
}

const settle = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))

test('$select find does not downgrade cached entities on a materialized service', async t => {
  const { figbird, notes } = createApp()

  const allRef = figbird.query(figbird.q.notes.all())
  const unsubAll = allRef.subscribe(() => {})
  await settle()
  const getsAfterAll = notes.counts.get

  // Same rows, projected — the poisoning payload.
  const selectRef = figbird.query(figbird.q.notes.where({ $select: ['id', 'title', 'updatedAt'] }))
  const unsubSelect = selectRef.subscribe(() => {})
  await settle()

  const selected = selectRef.getSnapshot().data as Note[]
  t.deepEqual(
    selected.map(row => Object.keys(row).sort()),
    [
      ['id', 'title', 'updatedAt'],
      ['id', 'title', 'updatedAt'],
    ],
    "the $select query's own data is projected",
  )

  // The get is still answered locally (no roundtrip) — and with the full row.
  const getRef = figbird.query(figbird.q.notes.get(1))
  const unsubGet = getRef.subscribe(() => {})
  await settle()
  t.is(notes.counts.get, getsAfterAll, 'still answered locally from the materialized cache')
  t.deepEqual(getRef.getSnapshot().data, { id: 1, title: 'First', body: 'First body', updatedAt })

  unsubGet()
  unsubSelect()
  unsubAll()
})

test('$select find never seeds partial rows into a fresh service cache', async t => {
  const { figbird, notes } = createApp()

  const selectRef = figbird.query(figbird.q.notes.where({ $select: ['id', 'title'] }))
  const unsubSelect = selectRef.subscribe(() => {})
  await settle()
  t.is(notes.counts.get, 0)

  // Nothing full was cached for id 1, so the get must go out to the network.
  const getRef = figbird.query(figbird.q.notes.get(1))
  const unsubGet = getRef.subscribe(() => {})
  await settle()
  t.is(notes.counts.get, 1, 'get goes to the network')
  t.deepEqual(getRef.getSnapshot().data, { id: 1, title: 'First', body: 'First body', updatedAt })

  // Materialize *after* the projection and read a row the get above never
  // touched — a seeded partial row would surface here.
  const allRef = figbird.query(figbird.q.notes.all())
  const unsubAll = allRef.subscribe(() => {})
  await settle()
  const getsAfterAll = notes.counts.get

  const localRef = figbird.query(figbird.q.notes.get(2))
  const unsubLocal = localRef.subscribe(() => {})
  await settle()
  t.is(notes.counts.get, getsAfterAll, 'answered locally from the materialized cache')
  t.deepEqual(localRef.getSnapshot().data, {
    id: 2,
    title: 'Second',
    body: 'Second body',
    updatedAt,
  })

  unsubLocal()
  unsubAll()
  unsubGet()
  unsubSelect()
})

test('a $select refetch triggered by realtime does not re-poison the cache', async t => {
  const { figbird, notes, selectFinds } = createApp()

  const allRef = figbird.query(figbird.q.notes.all())
  const unsubAll = allRef.subscribe(() => {})
  await settle()

  const selectRef = figbird.query(figbird.q.notes.where({ $select: ['id', 'title', 'updatedAt'] }))
  const unsubSelect = selectRef.subscribe(() => {})
  await settle()
  const selectFetchesBefore = selectFinds.length
  const getsAfterAll = notes.counts.get

  // A patch makes the server-authoritative $select query refetch — the write
  // path that used to overwrite the full entity with a projection.
  await notes.patch(1, { title: 'Renamed' })
  await settle(20)

  t.true(selectFinds.length > selectFetchesBefore, 'the $select query refetched')

  const getRef = figbird.query(figbird.q.notes.get(1))
  const unsubGet = getRef.subscribe(() => {})
  await settle()
  t.is(notes.counts.get, getsAfterAll, 'still answered locally')
  t.deepEqual(getRef.getSnapshot().data as Note, {
    id: 1,
    title: 'Renamed',
    body: 'First body',
    updatedAt: notes.data[1]!.updatedAt as number,
  })

  unsubGet()
  unsubSelect()
  unsubAll()
})

test('a $select-only allPages find does not materialize the service', async t => {
  const { figbird, notes } = createApp()

  const allRef = figbird.query(figbird.q.notes.where({ $select: ['id', 'title'] }).all())
  const unsubAll = allRef.subscribe(() => {})
  await settle()
  t.is((allRef.getSnapshot().data as Note[]).length, 2)

  const getRef = figbird.query(figbird.q.notes.get(2))
  const unsubGet = getRef.subscribe(() => {})
  await settle()
  t.is(notes.counts.get, 1, 'service is not materialized, so the get hits the network')
  t.deepEqual(getRef.getSnapshot().data, {
    id: 2,
    title: 'Second',
    body: 'Second body',
    updatedAt,
  })

  unsubGet()
  unsubAll()
})

test('$select on a get returns a projection without overwriting the cached entity', async t => {
  const { figbird, notes } = createApp()

  // Seed the full row into the cache (and materialize, so the later get is local).
  const allRef = figbird.query(figbird.q.notes.all())
  const unsubAll = allRef.subscribe(() => {})
  await settle()
  const getsAfterAll = notes.counts.get

  const selectGetRef = figbird.query(figbird.q.notes.get(1).where({ $select: ['id', 'title'] }))
  const unsubSelectGet = selectGetRef.subscribe(() => {})
  await settle()
  t.is(notes.counts.get, getsAfterAll + 1, 'a $select get is never answered locally')
  t.deepEqual(selectGetRef.getSnapshot().data, { id: 1, title: 'First' }, "the get's own data")

  // The full row survived in the cache.
  const getRef = figbird.query(figbird.q.notes.get(1))
  const unsubGet = getRef.subscribe(() => {})
  await settle()
  t.is(notes.counts.get, getsAfterAll + 1, 'full get still answered locally')
  t.deepEqual(getRef.getSnapshot().data, { id: 1, title: 'First', body: 'First body', updatedAt })

  unsubGet()
  unsubSelectGet()
  unsubAll()
})
