import test from 'ava'
import { compareValues } from '../lib/core/sort'

test('compareValues orders dates by time, consistently with ISO strings', t => {
  const saturday = new Date('2024-01-06T00:00:00.000Z')
  const monday = new Date('2024-01-08T00:00:00.000Z')

  t.true(compareValues(saturday, monday) < 0)
  t.true(compareValues(saturday, monday.toJSON()) < 0)
  t.is(compareValues(monday, monday.toJSON()), 0)
})
