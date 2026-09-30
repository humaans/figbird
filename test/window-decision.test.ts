import test from 'ava'
import { buildComparator, compareValues } from '../lib/core/sort.js'
import {
  maintainWindow,
  type WindowChange,
  type WindowContext,
  type WindowDecision,
  type WindowState,
} from '../lib/core/windowDecision.js'

const one = Object.freeze({ id: 1, rank: 1, active: true })
const two = Object.freeze({ id: 2, rank: 2, active: true })
const three = Object.freeze({ id: 3, rank: 3, active: true })
const four = Object.freeze({ id: 4, rank: 4, active: true })
const patched = Object.freeze({ ...one, text: 'changed' })
const tied = Object.freeze({ ...three, rank: 2 })
const moved = Object.freeze({ ...three, rank: 1 })
const later = Object.freeze({ ...four, rank: 5 })
const unknown = Object.freeze({ ...one, active: 'unknown' })

const firstPage: WindowState = { rows: Object.freeze([one, two]), skip: 0, limit: 2 }
const offsetPage: WindowState = { rows: Object.freeze([three, four]), skip: 2, limit: 2 }
const context: WindowContext = {
  compare: buildComparator({ rank: 1 }, compareValues),
  matches: item => {
    const active =
      typeof item === 'object' && item !== null && 'active' in item ? item.active : undefined
    return active === 'unknown' ? 'unknown' : active === true
  },
  keyOf: item => {
    const id = typeof item === 'object' && item !== null && 'id' in item ? item.id : undefined
    return typeof id === 'number' ? String(id) : undefined
  },
}

const cases: {
  name: string
  state: WindowState
  change: WindowChange
  context?: WindowContext
  expected: WindowDecision
}[] = [
  {
    name: 'patches a visible row in place when sort keys stay unchanged',
    state: firstPage,
    change: { type: 'patched', item: patched, previousItem: one, itemId: '1', hasItem: true },
    expected: { type: 'update', data: [patched, two], metaOp: null },
  },
  {
    name: 'inserts into an underfilled window in sort order',
    state: { ...firstPage, rows: Object.freeze([one, three]), limit: 3 },
    change: { type: 'created', item: two, previousItem: null, itemId: '2', hasItem: false },
    expected: { type: 'update', data: [one, two, three], metaOp: 'added' },
  },
  {
    name: 'refetches an insert tied with a full window boundary',
    state: firstPage,
    change: { type: 'created', item: tied, previousItem: null, itemId: '3', hasItem: false },
    expected: { type: 'refetch' },
  },
  {
    name: 'refetches a removal from a full window for the unseen replacement',
    state: firstPage,
    change: { type: 'removed', item: one, previousItem: one, itemId: '1', hasItem: true },
    expected: { type: 'refetch' },
  },
  {
    name: 'removes a visible row from an underfilled final page',
    state: { ...firstPage, limit: 3 },
    change: { type: 'removed', item: one, previousItem: one, itemId: '1', hasItem: true },
    expected: { type: 'update', data: [two], metaOp: 'removed' },
  },
  {
    name: 'refetches an insert before an offset window',
    state: offsetPage,
    change: { type: 'created', item: one, previousItem: null, itemId: '1', hasItem: false },
    expected: { type: 'refetch' },
  },
  {
    name: 'refetches a removal before an offset window',
    state: offsetPage,
    change: { type: 'removed', item: one, previousItem: one, itemId: '1', hasItem: false },
    expected: { type: 'refetch' },
  },
  {
    name: 'refetches a visible row moving before an offset window',
    state: offsetPage,
    change: { type: 'patched', item: moved, previousItem: three, itemId: '3', hasItem: true },
    expected: { type: 'refetch' },
  },
  {
    name: 'ignores a known member moving strictly beyond a full window',
    state: firstPage,
    change: { type: 'patched', item: later, previousItem: four, itemId: '4', hasItem: false },
    expected: { type: 'noop' },
  },
  {
    name: 'updates only the total for an insert strictly beyond a full window',
    state: firstPage,
    change: { type: 'created', item: three, previousItem: null, itemId: '3', hasItem: false },
    expected: { type: 'update', data: firstPage.rows, metaOp: 'added' },
  },
  {
    name: 'refetches unknown membership while allowing the visible value to update',
    state: firstPage,
    change: { type: 'patched', item: unknown, previousItem: one, itemId: '1', hasItem: true },
    expected: { type: 'refetch', replaceVisible: true },
  },
  {
    name: 'appends to an underfilled first page without an ordering comparator',
    state: { ...firstPage, limit: 3 },
    change: { type: 'created', item: three, previousItem: null, itemId: '3', hasItem: false },
    context: { ...context, compare: undefined },
    expected: { type: 'update', data: [one, two, three], metaOp: 'added' },
  },
]

for (const fixture of cases) {
  test(`maintainWindow ${fixture.name}`, t => {
    const decision = maintainWindow(fixture.state, fixture.change, fixture.context ?? context)
    t.deepEqual(decision, fixture.expected)
    if (fixture.expected.type === 'update' && fixture.expected.data === fixture.state.rows) {
      t.is(decision.type === 'update' && decision.data, fixture.state.rows)
    }
  })
}
