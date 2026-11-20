import test from 'ava'
import { FeathersAdapter } from '../lib/adapters/feathers'
import { matcher } from '../lib/adapters/matcher'
import { Figbird } from '../lib/core/figbird'
import { hashObject } from '../lib/core/hash'
import { explainQueryNode } from '../lib/core/queryClassification'
import { createSchema, service } from '../lib/core/schema'
import { buildComparator, compareValues } from '../lib/core/sort'
import { withoutUndefined } from '../lib/core/wireDates'
import { flushTasks } from './clock'
import { createTestApp, mockFeathers } from './helpers'

/**
 * A query value of `undefined` never reaches the server (JSON and query strings
 * drop the key) and is not part of the cache key, so `{ tag: undefined }` and `{}`
 * are one query. These tests pin local matching and classification to that same
 * reading, whichever of the two spellings creates the cache entry.
 */

type Note = {
  id: number
  text: string
  rank: number | null
  tag: string | null
  updatedAt: number
}

const schema = createSchema({
  services: {
    notes: service<{ item: Note }>(),
  },
})

const note = (id: number, text: string, fields: Partial<Note> = {}): Note => ({
  id,
  text,
  rank: id,
  tag: 'x',
  updatedAt: 1,
  ...fields,
})

const seed = (): Record<number, Note> => ({
  1: note(1, 'a'),
  2: note(2, 'b'),
  3: note(3, 'c', { rank: null, tag: null }),
})

function createApp() {
  const feathers = mockFeathers({ notes: { data: seed() } }, { queryAwareFind: true })
  const figbird = new Figbird({
    schema,
    adapter: new FeathersAdapter(feathers),
    eventBatchInterval: 0,
    reconcileCooldown: 0,
  })
  return { figbird, notes: feathers.service('notes') }
}

type App = ReturnType<typeof createApp>

const settle = () => new Promise(resolve => setTimeout(resolve, 10))

/** Subscribe to a legacy `useFind`-style descriptor (`params.query`) and await the fetch. */
async function watch(figbird: App['figbird'], query: Record<string, unknown>) {
  const ref = figbird.queryDesc(
    { serviceName: 'notes', method: 'find', params: { query } },
    { realtime: 'merge' },
  )
  const unsub = ref.subscribe(() => {})
  await settle()
  return {
    unsub,
    texts: () => ((ref.getSnapshot()?.data ?? []) as Note[]).map(item => item.text),
  }
}

function serverCreate(notes: App['notes'], item: Note) {
  notes.data[item.id] = item
  notes.emit('created', item)
}

function serverPatch(notes: App['notes'], item: Note) {
  notes.data[item.id] = item
  notes.emit('patched', item)
}

const classOf = (query: unknown) => explainQueryNode(query).class

// This repo compiles with exactOptionalPropertyTypes, which rejects an explicit
// undefined in a where clause. Most apps compile without it, and there
// `where({ teamId: me?.teamId })` type-checks.
const loose = (clause: Record<string, unknown>) => clause as never

// ---------------------------------------------------------------------------
// Realtime maintenance through the descriptor (`useFind`) path
// ---------------------------------------------------------------------------

test('an undefined query value keeps patched rows and merges created ones', async t => {
  const { figbird, notes } = createApp()
  const { texts, unsub } = await watch(figbird, { tag: undefined })
  t.deepEqual(texts(), ['a', 'b', 'c'])
  const finds = notes.counts.find

  serverPatch(notes, note(1, 'a2', { updatedAt: 2 }))
  serverCreate(notes, note(4, 'd'))
  await settle()

  t.deepEqual(texts(), ['a2', 'b', 'c', 'd'])
  t.is(notes.counts.find, finds)
  unsub()
})

for (const order of ['{} first', '{ tag: undefined } first'] as const) {
  test(`{} and { tag: undefined } behave identically (${order})`, async t => {
    const { figbird, notes } = createApp()
    const queries = order === '{} first' ? [{}, { tag: undefined }] : [{ tag: undefined }, {}]
    const first = await watch(figbird, queries[0]!)
    const second = await watch(figbird, queries[1]!)
    // One cache entry: the second spelling does not fetch again.
    t.is(notes.counts.find, 1)

    serverPatch(notes, note(2, 'b2', { updatedAt: 2 }))
    serverCreate(notes, note(4, 'd'))
    await settle()

    t.deepEqual(first.texts(), ['a', 'b2', 'c', 'd'])
    t.deepEqual(second.texts(), ['a', 'b2', 'c', 'd'])
    t.is(notes.counts.find, 1)
    first.unsub()
    second.unsub()
  })
}

test('an undefined operand next to a defined one leaves only the defined one', async t => {
  const { figbird, notes } = createApp()
  const { texts, unsub } = await watch(figbird, { tag: 'x', text: undefined })
  t.deepEqual(texts(), ['a', 'b'])

  serverPatch(notes, note(1, 'a2', { updatedAt: 2 }))
  serverCreate(notes, note(4, 'd'))
  serverCreate(notes, note(5, 'e', { tag: 'y' }))
  await settle()

  t.deepEqual(texts(), ['a2', 'b', 'd'])
  unsub()
})

test('an explicit null still matches only rows where the field is null', async t => {
  const { figbird, notes } = createApp()
  const { texts, unsub } = await watch(figbird, { tag: null })
  t.deepEqual(texts(), ['c'])

  serverCreate(notes, note(4, 'd'))
  serverCreate(notes, note(5, 'e', { tag: null }))
  serverPatch(notes, note(3, 'c2', { rank: null, tag: null, updatedAt: 2 }))
  await settle()

  t.deepEqual(texts(), ['c2', 'e'])
  unsub()
})

test('an empty $or or $and does not throw and filters nothing', async t => {
  const { figbird, notes } = createApp()
  const or = await watch(figbird, { $or: [] })
  const and = await watch(figbird, { tag: 'x', $and: [] })
  t.deepEqual(or.texts(), ['a', 'b', 'c'])
  t.deepEqual(and.texts(), ['a', 'b'])

  serverCreate(notes, note(4, 'd'))
  await settle()

  t.deepEqual(or.texts(), ['a', 'b', 'c', 'd'])
  t.deepEqual(and.texts(), ['a', 'b', 'd'])
  or.unsub()
  and.unsub()
})

// ---------------------------------------------------------------------------
// Query builder
// ---------------------------------------------------------------------------

test('.where() drops undefined values, so the AST is the one without them', t => {
  const { figbird } = createTestApp(schema, { notes: { data: seed() } })
  const q = figbird.q.notes

  t.deepEqual(q.where(loose({ tag: undefined })).toAST(), q.toAST())
  t.deepEqual(
    q.where(loose({ rank: { $gt: 1, $lt: undefined } })).toAST(),
    q.where({ rank: { $gt: 1 } }).toAST(),
  )
  t.deepEqual(
    q.where(loose({ $or: [{ tag: 'x', rank: undefined }, { rank: 2 }] })).toAST(),
    q.where({ $or: [{ tag: 'x' }, { rank: 2 }] }).toAST(),
  )
  // A later undefined does not conflict with (or clear) an earlier condition.
  t.deepEqual(
    q
      .where({ tag: 'x' })
      .where(loose({ tag: undefined }))
      .toAST(),
    q.where({ tag: 'x' }).toAST(),
  )
  t.deepEqual(q.where({ tag: null }).toAST().query, { tag: null })
})

test('a builder query with an undefined value merges matching creates', async t => {
  const { figbird, feathers } = createTestApp(schema, { notes: { data: seed() } })
  const filtered = figbird.q.notes.where(loose({ tag: undefined }))
  t.is(hashObject(filtered.toAST()), hashObject(figbird.q.notes.toAST()))

  const ref = figbird.query(filtered)
  const unsub = ref.subscribe(() => {})
  await flushTasks()
  const ids = () => (ref.getSnapshot().data as Note[]).map(item => item.id)
  t.deepEqual(ids(), [1, 2, 3])

  await feathers.service('notes').create(note(4, 'd'))
  await flushTasks()

  t.deepEqual(ids(), [1, 2, 3, 4])
  unsub()
})

// ---------------------------------------------------------------------------
// Matcher
// ---------------------------------------------------------------------------

test('matcher: undefined values are dropped at every depth', t => {
  const rows = Object.values(seed())
  const texts = (query: Record<string, unknown>) =>
    rows.filter(row => matcher(query as never)(row)).map(row => row.text)

  t.deepEqual(texts({ tag: undefined }), ['a', 'b', 'c'])
  t.deepEqual(texts({ tag: null }), ['c'])
  t.deepEqual(texts({ rank: { $gt: undefined, $lt: 2 } }), ['a'])
  t.deepEqual(texts({ $or: [{ rank: 1, tag: undefined }, { rank: 2 }] }), ['a', 'b'])
  t.deepEqual(texts({ $and: [{ rank: { $gte: 2 } }, { tag: undefined }] }), ['b'])
})

test('matcher: undefined inside an array is null, as JSON and the cache key have it', t => {
  const rows = Object.values(seed())
  const texts = (query: Record<string, unknown>) =>
    rows.filter(row => matcher(query as never)(row)).map(row => row.text)

  t.is(hashObject({ rank: { $in: [1, undefined] } }), hashObject({ rank: { $in: [1, null] } }))
  t.deepEqual(texts({ rank: { $in: [1, undefined] } }), texts({ rank: { $in: [1, null] } }))
  t.deepEqual(texts({ rank: { $in: [1, undefined] } }), ['a', 'c'])
})

test('matcher: an empty $or or $and is no condition', t => {
  const rows = Object.values(seed())
  const texts = (query: Record<string, unknown>) =>
    rows.filter(row => matcher(query as never)(row)).map(row => row.text)

  t.deepEqual(texts({ $or: [] }), ['a', 'b', 'c'])
  t.deepEqual(texts({ $and: [] }), ['a', 'b', 'c'])
  t.deepEqual(texts({ tag: 'x', $or: [] }), ['a', 'b'])
})

test('matcher: a custom operator with an undefined operand is not applied', t => {
  let calls = 0
  const adapter = new FeathersAdapter(mockFeathers({ notes: { data: seed() } }), {
    operators: {
      $never: () => {
        calls++
        return () => false
      },
    },
  })

  t.true(adapter.matcher({ $never: undefined } as never)(seed()[1]))
  t.is(calls, 0)
  t.false(adapter.matcher({ $never: true } as never)(seed()[1]))
})

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test('classification ignores keys whose value is undefined', t => {
  t.is(classOf({ tag: undefined }), 'local-exact')
  t.is(classOf({ $limit: undefined, $sort: undefined }), 'local-exact')
  t.is(classOf({ $select: undefined }), 'local-exact')
  t.is(classOf({ $search: undefined }), 'local-exact')
  t.is(classOf({ name: { $regex: undefined } }), classOf({ name: {} }))
  t.is(classOf({ $or: [] }), 'local-exact')
})

test('a condition left empty has no agreed wire form, so the server decides', t => {
  // `{ rank: { $gt: undefined } }` is `{ rank: {} }` on the wire and in the cache
  // key; both spellings must classify alike.
  const reasons = [{ code: 'empty-condition', detail: 'rank' }]
  t.deepEqual(explainQueryNode({ rank: { $gt: undefined } }), {
    class: 'server-authoritative',
    reasons,
  })
  t.deepEqual(explainQueryNode({ rank: {} }), { class: 'server-authoritative', reasons })
  t.deepEqual(explainQueryNode({ $or: [{ tag: undefined }, { rank: 1 }] }), {
    class: 'server-authoritative',
    reasons: [{ code: 'empty-condition', detail: '$or' }],
  })
  // The root itself may be empty: that is simply an unfiltered query.
  t.is(classOf({}), 'local-exact')
  t.is(classOf({ rank: { $gt: 1, $lt: undefined } }), 'local-exact')
})

test('a query with an emptied condition refetches on events instead of matching', async t => {
  const { figbird, notes } = createApp()
  const { unsub } = await watch(figbird, { rank: { $gt: undefined } })
  const inspected = figbird.inspect().find(query => query.serviceName === 'notes')!
  t.is(inspected.classification, 'server-authoritative')
  const finds = notes.counts.find

  serverCreate(notes, note(4, 'd'))
  await settle()

  t.is(notes.counts.find, finds + 1)
  unsub()
})

test('classification handles nested empty $or/$and and does not flag $in array objects', t => {
  t.deepEqual(explainQueryNode({ $or: [{ $and: [] }, { rank: 1 }] }), {
    class: 'server-authoritative',
    reasons: [{ code: 'empty-condition', detail: '$or' }],
  })
  t.is(classOf({ meta: { $in: [{}] } }), 'local-exact')
})

test('$sort with an undefined direction does not sort by that field locally', t => {
  const compare = buildComparator({ rank: undefined as unknown as number }, compareValues)
  const rows = [note(1, 'b', { rank: 2 }), note(2, 'a', { rank: 1 })]
  t.is(compare(rows[0], rows[1]), 0)
  t.is(compare(rows[1], rows[0]), 0)
})

test('withoutUndefined preserves identity when no undefined values are present', t => {
  const input = { tag: 'x', rank: { $in: [1, 2] }, nested: [{ a: 1 }] }
  t.is(withoutUndefined(input), input)
})
