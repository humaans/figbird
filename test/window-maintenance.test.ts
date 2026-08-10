import test from 'ava'
import { FeathersAdapter } from '../lib/adapters/feathers'
import { Figbird } from '../lib/core/figbird'
import { createSchema, service } from '../lib/core/schema'
import { mockFeathers } from './helpers'

/**
 * Window maintenance: server-window finds merge realtime events locally when the
 * event's effect on the window is provable, and fall back to a refetch for the
 * rest. See mergeEventIntoWindow in lib/core/windowMaintenance.ts for the
 * soundness argument these tests exercise branch by branch.
 */

// A type alias (not an interface) so the implicit index signature satisfies the
// mock client's TestItem.
type Note = {
  id: number
  text: string
  rank: number
  tag: string
  updatedAt: number
}

const schema = createSchema({
  services: {
    notes: service<{ item: Note }>(),
  },
})

const seed = (): Record<number, Note> => ({
  1: { id: 1, text: 'a', rank: 1, tag: 'x', updatedAt: 1 },
  2: { id: 2, text: 'b', rank: 2, tag: 'x', updatedAt: 1 },
  3: { id: 3, text: 'c', rank: 3, tag: 'x', updatedAt: 1 },
  4: { id: 4, text: 'd', rank: 4, tag: 'x', updatedAt: 1 },
})

function createApp({ defaultSort }: { defaultSort?: Record<string, 1 | -1> } = {}) {
  const feathers = mockFeathers({ notes: { data: seed() } }, { queryAwareFind: true })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({
    schema,
    adapter,
    eventBatchInterval: 0,
    reconcileCooldown: 0,
    ...(defaultSort ? { defaultSort } : {}),
  })
  const notes = feathers.service('notes')
  return { figbird, notes }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 10))

/** Subscribe to a find on notes and await the initial fetch. */
async function watch(
  figbird: ReturnType<typeof createApp>['figbird'],
  query: Record<string, unknown>,
) {
  const ref = figbird.queryDesc(
    { serviceName: 'notes', method: 'find', params: { query } },
    { realtime: 'merge' },
  )
  const unsub = ref.subscribe(() => {})
  await settle()
  const snapshot = () => {
    const state = ref.getSnapshot()
    if (state?.status !== 'success') throw new Error(`expected success, got ${state?.status}`)
    return state
  }
  return {
    unsub,
    texts: () => (snapshot().data as Note[]).map(note => note.text),
    total: () => (snapshot().meta as { total: number }).total,
  }
}

// Server-side mutation emulation: update the mock's row set (so refetches see the
// change) and emit the corresponding realtime event.
function serverCreate(notes: ReturnType<typeof createApp>['notes'], item: Note) {
  notes.data[item.id] = item
  notes.emit('created', item)
}

function serverPatch(notes: ReturnType<typeof createApp>['notes'], item: Note) {
  notes.data[item.id] = item
  notes.emit('patched', item)
}

function serverRemove(notes: ReturnType<typeof createApp>['notes'], id: number) {
  const item = notes.data[id]
  delete notes.data[id]
  notes.emit('removed', item)
}

test('in-place patch of a visible row merges without a refetch', async t => {
  const { figbird, notes } = createApp()
  const { texts, total, unsub } = await watch(figbird, { $sort: { rank: 1 }, $limit: 3 })
  t.deepEqual(texts(), ['a', 'b', 'c'])
  const finds = notes.counts.find

  serverPatch(notes, { id: 2, text: 'b2', rank: 2, tag: 'x', updatedAt: 2 })
  await settle()

  t.is(notes.counts.find, finds)
  t.deepEqual(texts(), ['a', 'b2', 'c'])
  t.is(total(), 4)
  unsub()
})

test('patch moving a visible row within the window re-places it locally', async t => {
  const { figbird, notes } = createApp()
  const { texts, unsub } = await watch(figbird, { $sort: { rank: 1 }, $limit: 3 })
  const finds = notes.counts.find

  serverPatch(notes, { id: 1, text: 'a2', rank: 2.5, tag: 'x', updatedAt: 2 })
  await settle()

  t.is(notes.counts.find, finds)
  t.deepEqual(texts(), ['b', 'a2', 'c'])
  unsub()
})

test('patch moving a visible row past a full window refetches', async t => {
  const { figbird, notes } = createApp()
  const { texts, unsub } = await watch(figbird, { $sort: { rank: 1 }, $limit: 3 })
  const finds = notes.counts.find

  serverPatch(notes, { id: 1, text: 'a2', rank: 99, tag: 'x', updatedAt: 2 })
  await settle()

  t.is(notes.counts.find, finds + 1)
  t.deepEqual(texts(), ['b', 'c', 'd'])
  unsub()
})

test('underfilled window: creates insert at their sorted position', async t => {
  const { figbird, notes } = createApp()
  const { texts, total, unsub } = await watch(figbird, { $sort: { rank: 1 }, $limit: 10 })
  const finds = notes.counts.find

  serverCreate(notes, { id: 5, text: 'n', rank: 2.5, tag: 'x', updatedAt: 1 })
  await settle()

  t.is(notes.counts.find, finds)
  t.deepEqual(texts(), ['a', 'b', 'n', 'c', 'd'])
  t.is(total(), 5)
  unsub()
})

test('underfilled window: removes merge locally', async t => {
  const { figbird, notes } = createApp()
  const { texts, total, unsub } = await watch(figbird, { $sort: { rank: 1 }, $limit: 10 })
  const finds = notes.counts.find

  serverRemove(notes, 3)
  await settle()

  t.is(notes.counts.find, finds)
  t.deepEqual(texts(), ['a', 'b', 'd'])
  t.is(total(), 3)
  unsub()
})

test('underfilled window: a patch that stops matching removes the row locally', async t => {
  const { figbird, notes } = createApp()
  const { texts, total, unsub } = await watch(figbird, {
    tag: 'x',
    $sort: { rank: 1 },
    $limit: 10,
  })
  const finds = notes.counts.find

  serverPatch(notes, { id: 2, text: 'b', rank: 2, tag: 'y', updatedAt: 2 })
  await settle()

  t.is(notes.counts.find, finds)
  t.deepEqual(texts(), ['a', 'c', 'd'])
  t.is(total(), 3)
  unsub()
})

test('a patched row entering the result set inserts locally', async t => {
  const { figbird, notes } = createApp()
  const { texts, total, unsub } = await watch(figbird, {
    tag: 'x',
    $sort: { rank: 1 },
    $limit: 10,
  })
  const finds = notes.counts.find

  // First event caches the entity without matching; the second flips it into the
  // result set — a provable enter with a known previous.
  serverPatch(notes, { id: 9, text: 'n', rank: 0, tag: 'y', updatedAt: 1 })
  await settle()
  t.deepEqual(texts(), ['a', 'b', 'c', 'd'])

  serverPatch(notes, { id: 9, text: 'n', rank: 0, tag: 'x', updatedAt: 2 })
  await settle()

  t.is(notes.counts.find, finds)
  t.deepEqual(texts(), ['n', 'a', 'b', 'c', 'd'])
  t.is(total(), 5)
  unsub()
})

test('create sorting into a full window inserts and evicts the overflow row', async t => {
  const { figbird, notes } = createApp()
  const { texts, total, unsub } = await watch(figbird, { $sort: { rank: 1 }, $limit: 3 })
  const finds = notes.counts.find

  serverCreate(notes, { id: 5, text: 'top', rank: 0, tag: 'x', updatedAt: 1 })
  await settle()

  t.is(notes.counts.find, finds)
  t.deepEqual(texts(), ['top', 'a', 'b'])
  t.is(total(), 5)
  unsub()
})

test('create sorting past a full window adjusts total only', async t => {
  const { figbird, notes } = createApp()
  const { texts, total, unsub } = await watch(figbird, { $sort: { rank: 1 }, $limit: 3 })
  const finds = notes.counts.find

  serverCreate(notes, { id: 5, text: 'z', rank: 99, tag: 'x', updatedAt: 1 })
  await settle()

  t.is(notes.counts.find, finds)
  t.deepEqual(texts(), ['a', 'b', 'c'])
  t.is(total(), 5)
  unsub()
})

test('removal of a visible row from a full window refetches', async t => {
  const { figbird, notes } = createApp()
  const { texts, total, unsub } = await watch(figbird, { $sort: { rank: 1 }, $limit: 3 })
  const finds = notes.counts.find

  serverRemove(notes, 2)
  await settle()

  t.is(notes.counts.find, finds + 1)
  t.deepEqual(texts(), ['a', 'c', 'd'])
  t.is(total(), 3)
  unsub()
})

test('removal of an invisible matching row adjusts total only', async t => {
  const { figbird, notes } = createApp()
  const { texts, total, unsub } = await watch(figbird, { $sort: { rank: 1 }, $limit: 3 })
  const finds = notes.counts.find

  // Row 4 lives beyond the window and was never cached — the removed event
  // carries the full record, which proves it matched and sorted past the window.
  serverRemove(notes, 4)
  await settle()

  t.is(notes.counts.find, finds)
  t.deepEqual(texts(), ['a', 'b', 'c'])
  t.is(total(), 3)
  unsub()
})

test('defaultSort places creates into windows without $sort', async t => {
  const { figbird, notes } = createApp({ defaultSort: { rank: 1 } })
  const underfilled = await watch(figbird, { $limit: 10 })
  const full = await watch(figbird, { $limit: 3 })
  const finds = notes.counts.find

  serverCreate(notes, { id: 5, text: 'n', rank: 2.5, tag: 'x', updatedAt: 1 })
  await settle()

  t.is(notes.counts.find, finds)
  t.deepEqual(underfilled.texts(), ['a', 'b', 'n', 'c', 'd'])
  t.deepEqual(full.texts(), ['a', 'b', 'n'])
  underfilled.unsub()
  full.unsub()
})

test('without order knowledge, underfilled first pages append and full windows refetch', async t => {
  const { figbird, notes } = createApp()
  const underfilled = await watch(figbird, { $limit: 10 })
  const full = await watch(figbird, { $limit: 3 })
  const finds = notes.counts.find

  serverCreate(notes, { id: 5, text: 'n', rank: 2.5, tag: 'x', updatedAt: 1 })
  await settle()

  // Membership is certain for the underfilled window (it is the complete result
  // set) — the item appends; the full window cannot be placed and refetches.
  t.deepEqual(underfilled.texts(), ['a', 'b', 'c', 'd', 'n'])
  t.is(underfilled.total(), 5)
  t.is(notes.counts.find, finds + 1)
  underfilled.unsub()
  full.unsub()
})

test('$skip windows: in-place patches merge, page-start shifts refetch', async t => {
  const { figbird, notes } = createApp()
  const { texts, unsub } = await watch(figbird, { $sort: { rank: 1 }, $limit: 2, $skip: 2 })
  t.deepEqual(texts(), ['c', 'd'])
  const finds = notes.counts.find

  serverPatch(notes, { id: 3, text: 'c2', rank: 3, tag: 'x', updatedAt: 2 })
  await settle()
  t.is(notes.counts.find, finds)
  t.deepEqual(texts(), ['c2', 'd'])

  // A create sorting before the page shifts everything — must refetch.
  serverCreate(notes, { id: 5, text: 'top', rank: 0, tag: 'x', updatedAt: 1 })
  await settle()
  t.is(notes.counts.find, finds + 1)
  t.deepEqual(texts(), ['b', 'c2'])
  unsub()
})

test('$sort-only queries are maintained fully locally', async t => {
  const { figbird, notes } = createApp()
  const { texts, unsub } = await watch(figbird, { $sort: { rank: 1 } })
  const finds = notes.counts.find

  serverCreate(notes, { id: 5, text: 'n', rank: 2.5, tag: 'x', updatedAt: 1 })
  await settle()
  serverRemove(notes, 4)
  await settle()

  t.is(notes.counts.find, finds)
  t.deepEqual(texts(), ['a', 'b', 'n', 'c'])
  unsub()
})

test('a create tied with the boundary row of a full window refetches', async t => {
  const { figbird, notes } = createApp()
  const { texts, unsub } = await watch(figbird, { $sort: { rank: 1 }, $limit: 3 })
  const finds = notes.counts.find

  // Ties with the last visible row: the server's tiebreak decides membership.
  serverCreate(notes, { id: 5, text: 'tie', rank: 3, tag: 'x', updatedAt: 1 })
  await settle()

  t.is(notes.counts.find, finds + 1)
  t.is(texts().length, 3)
  unsub()
})
