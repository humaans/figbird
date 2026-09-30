import test from 'ava'
import { FeathersAdapter } from '../lib/adapters/feathers.js'
import { Figbird } from '../lib/core/figbird.js'
import { createSchema, service } from '../lib/core/schema.js'
import { TestClock } from './clock.js'
import { mockFeathers } from './helpers.js'

function fixture() {
  const clock = new TestClock()
  const feathers = mockFeathers({ notes: { data: { 1: { id: 1, content: 'hello' } } } })
  const schema = createSchema({
    services: { notes: service<{ item: { id: number; content: string } }>() },
  })
  const figbird = new Figbird({ adapter: new FeathersAdapter(feathers), schema, clock })
  return { clock, feathers, figbird }
}

test('prefetch releases its graph at the expiry deadline', async t => {
  const { clock, figbird } = fixture()
  t.teardown(() => figbird.dispose())
  figbird.prefetch(figbird.q.notes, { staleTime: 100 })
  await figbird.query(figbird.q.notes).suspensePromise()
  await clock.advance(99)
  t.is(figbird.inspectRelational()[0]?.prefetchCount, 1)
  await clock.advance(1)
  t.is(figbird.inspectRelational().length, 0)
})

test('prefetch deduplicates fresh work and replaces expired leases', async t => {
  const { clock, feathers, figbird } = fixture()
  t.teardown(() => figbird.dispose())
  figbird.prefetch(figbird.q.notes, { staleTime: 100 })
  await figbird.query(figbird.q.notes).suspensePromise()
  await clock.advance(0)
  const timerCount = clock.pendingTimers
  await clock.advance(10)
  figbird.prefetch(figbird.q.notes, { staleTime: 100 })
  t.is(feathers.service('notes').counts.find, 1)
  figbird.prefetch(figbird.q.notes, { staleTime: 2 })
  await figbird.query(figbird.q.notes).suspensePromise()
  t.is(feathers.service('notes').counts.find, 2)
  t.is(figbird.inspectRelational()[0]?.prefetchCount, 1)
  await clock.advance(0)
  t.is(clock.pendingTimers, timerCount, 'replacement cancels the original expiry timer')
  await clock.advance(1)
  t.is(figbird.inspectRelational()[0]?.prefetchCount, 1)
  await clock.advance(1)
  t.is(figbird.inspectRelational().length, 0, 'the replacement owns the new deadline')
})

test('disposing an active prefetch cancels its timer and releases its graph', async t => {
  const { clock, figbird } = fixture()
  t.teardown(() => figbird.dispose())
  figbird.prefetch(figbird.q.notes, { staleTime: 100 })
  await figbird.query(figbird.q.notes).suspensePromise()
  await clock.advance(0)
  t.true(clock.pendingTimers > 0)
  figbird.dispose()
  t.is(clock.pendingTimers, 0)
  t.is(figbird.inspectRelational().length, 0)
  await clock.advance(200)
  t.is(figbird.getState().size, 0)
})

test('state subscribers receive the original maintenance shape without internal policy', async t => {
  const { figbird } = fixture()
  t.teardown(() => figbird.dispose())
  const maintenanceKeys: PropertyKey[][] = []
  const releaseState = figbird.subscribeToStateChanges(state => {
    for (const service of state.values()) {
      for (const query of service.queries.values()) {
        maintenanceKeys.push(Reflect.ownKeys(query.maintenance))
      }
    }
  })
  t.teardown(releaseState)
  const ref = figbird.query(figbird.q.notes)
  const releaseQuery = ref.subscribe(() => {})
  t.teardown(releaseQuery)
  await ref.suspensePromise()
  await figbird.m.notes.patch(1, { content: 'changed' })
  t.true(maintenanceKeys.length > 0)
  for (const keys of maintenanceKeys) {
    t.deepEqual(keys, [
      'classification',
      'matches',
      'matchesLocal',
      'compare',
      'limit',
      'skip',
      'isProjection',
    ])
  }
})
