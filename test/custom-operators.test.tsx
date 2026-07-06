/**
 * Custom operator registry — teaching the client to evaluate app-specific query
 * operators (e.g. `$asOf` on effective-dated services) so queries using them stay
 * realtime-mergeable instead of classifying server-authoritative.
 */
import test from 'ava'
import { createSchema, service } from '../lib/index.js'
import { createTestApp, dom } from './helpers.js'

interface Person {
  id: number
  name: string
}

interface JobRole {
  id: number
  personId: number
  title: string
  effectiveDate: string
  endDate: string | null
}

const schema = createSchema({
  services: {
    people: service<{ item: Person }>(),
    jobRoles: service<{ item: JobRole }>(),
  },
  relationships: {
    people: ({ one }) => ({
      currentRole: one({ sourceField: 'id', destService: 'jobRoles', destField: 'personId' }),
    }),
  },
})

// The client-side meaning of `$asOf`: the item's effective window contains the date.
const isEffectiveOn = (item: unknown, asOf: unknown) => {
  const role = item as JobRole
  const date = String(asOf)
  return role.effectiveDate <= date && (role.endDate === null || role.endDate >= date)
}

const operators = {
  $asOf: (asOf: unknown) => (item: unknown) => isEffectiveOn(item, asOf),
}

const services = () => ({
  people: {
    data: { 1: { id: 1, name: 'Ada' } },
  },
  jobRoles: {
    data: {
      1: { id: 1, personId: 1, title: 'Engineer', effectiveDate: '2020-01-01', endDate: null },
    },
  },
})

test('classification: a registered operator keeps the query realtime-mergeable', t => {
  const withOps = createTestApp(schema, services(), { operators, queryAwareFind: true })
  const withoutOps = createTestApp(schema, services())

  const query = withOps.figbird.q.jobRoles.where({ $asOf: '2026-07-06' })

  const local = withOps.figbird.explain(query).nodes[0]!
  t.is(local.class, 'local-exact')
  t.is(local.realtime, 'merge')

  const remote = withoutOps.figbird.explain(
    withoutOps.figbird.q.jobRoles.where({ $asOf: '2026-07-06' }),
  ).nodes[0]!
  t.is(remote.class, 'server-authoritative')
  t.is(remote.realtime, 'refetch')
  t.deepEqual(remote.reasons, [{ code: 'server-only-operator', detail: '$asOf' }])
})

test('realtime events merge through the operator predicate without refetching', async t => {
  const { App, figbird, feathers } = createTestApp(schema, services(), {
    operators,
    queryAwareFind: true,
  })
  const { render, flush, unmount } = dom()
  render(<App />)

  const ref = figbird.query(figbird.q.jobRoles.where({ $asOf: '2026-07-06' }))
  const unsub = ref.subscribe(() => {})
  await ref.suspensePromise()
  await flush()

  const roles = feathers.service('jobRoles')
  const findsAfterLoad = roles.counts.find

  t.deepEqual(
    (ref.getSnapshot().data as JobRole[]).map(r => r.id),
    [1],
  )

  // A currently-effective role merges in; an already-ended one does not.
  await flush(() => {
    roles.emit('created', {
      id: 2,
      personId: 1,
      title: 'Lead',
      effectiveDate: '2026-01-01',
      endDate: null,
    })
    roles.emit('created', {
      id: 3,
      personId: 1,
      title: 'Intern',
      effectiveDate: '2018-01-01',
      endDate: '2019-01-01',
    })
  })
  t.deepEqual((ref.getSnapshot().data as JobRole[]).map(r => r.id).sort(), [1, 2])

  // Ending a role drops it from the result — again purely locally.
  await flush(() => {
    roles.emit('patched', {
      id: 1,
      personId: 1,
      title: 'Engineer',
      effectiveDate: '2020-01-01',
      endDate: '2026-01-31',
    })
  })
  t.deepEqual(
    (ref.getSnapshot().data as JobRole[]).map(r => r.id),
    [2],
  )

  t.is(roles.counts.find, findsAfterLoad, 'no refetches — everything merged locally')

  unsub()
  unmount()
})

test('a relation refined with a registered operator merges realtime events', async t => {
  const { App, figbird, feathers } = createTestApp(schema, services(), {
    operators,
    queryAwareFind: true,
  })
  const { render, flush, unmount } = dom()
  render(<App />)

  const ref = figbird.query(
    figbird.q.people.related('currentRole', r => r.where({ $asOf: '2026-07-06' })),
  )
  const unsub = ref.subscribe(() => {})
  await ref.suspensePromise()
  await flush()

  const roles = feathers.service('jobRoles')
  const findsAfterLoad = roles.counts.find

  type PersonWithRole = Person & { currentRole: JobRole | null }
  const before = (ref.getSnapshot().data as PersonWithRole[])[0]!
  t.is(before.currentRole?.title, 'Engineer')

  // The person changes role: old one ends, new one begins — both via realtime events.
  await flush(() => {
    roles.emit('patched', {
      id: 1,
      personId: 1,
      title: 'Engineer',
      effectiveDate: '2020-01-01',
      endDate: '2026-06-30',
    })
    roles.emit('created', {
      id: 2,
      personId: 1,
      title: 'Staff Engineer',
      effectiveDate: '2026-07-01',
      endDate: null,
    })
  })

  const after = (ref.getSnapshot().data as PersonWithRole[])[0]!
  t.is(after.currentRole?.title, 'Staff Engineer')
  t.is(roles.counts.find, findsAfterLoad, 'the relation merged both events locally')

  unsub()
  unmount()
})
