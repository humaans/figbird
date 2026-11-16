import test from 'ava'
import { QueryRetention } from '../lib/core/queryRetention.js'
import { TestClock } from './clock'

test('retention: a postponed entry is looked at again later without re-entering the sweep', async t => {
  for (const duration of [0, 1000]) {
    const clock = new TestClock()
    const sweeps: string[] = []
    let inUse = true
    const retention = new QueryRetention(
      duration,
      id => {
        sweeps.push(id)
        if (sweeps.length > 50) throw new Error('retention sweep did not terminate')
        return inUse ? 5000 : undefined
      },
      clock,
    )
    retention.retain('a')
    await clock.advance(duration)
    t.deepEqual(sweeps, ['a'], `gcTime ${duration}: one look per sweep`)
    t.is(clock.pendingTimers, 1, `gcTime ${duration}: one timer`)

    await clock.advance(4999)
    t.deepEqual(sweeps, ['a'])
    inUse = false
    await clock.advance(1)
    t.deepEqual(sweeps, ['a', 'a'])
    t.is(clock.pendingTimers, 0, `gcTime ${duration}: nothing left scheduled`)

    retention.retain('b')
    retention.dispose()
    t.is(clock.pendingTimers, 0, `gcTime ${duration}: dispose cancels the sweep`)
  }
})

test('retention: retaining during a sweep leaves one timer set for the earliest deadline', async t => {
  const clock = new TestClock()
  const expired: string[] = []
  const retention: QueryRetention = new QueryRetention(
    1000,
    id => {
      expired.push(id)
      if (id === 'a') retention.retain('c')
    },
    clock,
  )
  retention.retain('a')
  await clock.advance(400)
  retention.retain('b')
  await clock.advance(600)
  t.deepEqual(expired, ['a'])
  t.is(clock.pendingTimers, 1)
  await clock.advance(400)
  t.deepEqual(expired, ['a', 'b'], 'the earlier entry is not delayed by the later one')
  await clock.advance(600)
  t.deepEqual(expired, ['a', 'b', 'c'])
  t.is(clock.pendingTimers, 0)
})

test('retention: an entry retained behind a postponed one still expires on its own deadline', async t => {
  const clock = new TestClock()
  const expired: string[] = []
  const retention = new QueryRetention(
    1000,
    id => {
      if (id === 'held') return 60_000
      expired.push(id)
      return undefined
    },
    clock,
  )
  retention.retain('held')
  await clock.advance(1000)
  // The only pending timer is now a minute away, for the postponed entry.
  retention.retain('idle')
  await clock.advance(1000)
  t.deepEqual(expired, ['idle'])
  t.is(clock.pendingTimers, 1)
  retention.dispose()
  t.is(clock.pendingTimers, 0)
})
