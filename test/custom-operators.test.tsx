/**
 * Custom operator registry — teaching the client to evaluate app-specific query
 * operators (e.g. `$asOf` on effective-dated services) so queries using them stay
 * realtime-mergeable instead of classifying server-authoritative.
 */
import test from 'ava'
import {
  FeathersAdapter,
  Figbird,
  createSchema,
  service,
  useFind,
  useQueryResult,
  type Adapter,
  type CustomOperatorRegistration,
  type FeathersFindMeta,
  type FeathersParams,
} from '../lib/index.js'
import { createTestApp, dom, mockFeathers } from './helpers.js'

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

interface ScopedItem {
  id: number
  ownerId?: number
  roleState?: string
  compensationState?: string
}

const scopedSchema = createSchema({
  services: {
    people: service<{ item: ScopedItem }>().at('api/people'),
    jobRoles: service<{ item: ScopedItem }>().at('api/job-roles'),
    compensations: service<{ item: ScopedItem }>().at('api/compensations'),
  },
  relationships: {
    people: ({ many }) => ({
      roles: many({
        sourceField: 'id',
        destService: 'jobRoles',
        destField: 'ownerId',
      }),
    }),
  },
})

const scopedServices = (includePastRole = true) => ({
  'api/people': {
    data: { 1: { id: 1 } },
  },
  'api/job-roles': {
    data: {
      1: { id: 1, ownerId: 1, roleState: 'current' },
      ...(includePastRole ? { 2: { id: 2, ownerId: 1, roleState: 'past' } } : {}),
    },
  },
  'api/compensations': {
    data: {
      1: { id: 1, compensationState: 'effective' },
    },
  },
})

function serviceScopedOperators(
  contexts: string[] = [],
): Record<string, CustomOperatorRegistration> {
  return {
    // One-argument registrations remain assignable and global.
    $tenant: tenant => item => (item as { ownerId?: unknown }).ownerId === tenant,
    $asOf: {
      byService: {
        'api/job-roles': (state, context) => {
          contexts.push(context.serviceName)
          return item => (item as ScopedItem).roleState === state
        },
        'api/compensations': (state, context) => {
          contexts.push(context.serviceName)
          return item => (item as ScopedItem).compensationState === state
        },
      },
    },
  }
}

test('service-scoped registration classifies and matches only the current service', t => {
  const contexts: string[] = []
  const { adapter, figbird } = createTestApp(scopedSchema, scopedServices(), {
    operators: serviceScopedOperators(contexts),
  })

  t.deepEqual(adapter.customOperators, ['$tenant'])
  t.deepEqual([...adapter.customOperatorsFor('api/job-roles')].sort(), ['$asOf', '$tenant'])
  t.deepEqual(adapter.customOperatorsFor('api/people'), ['$tenant'])

  const roles = figbird.explain(figbird.q.jobRoles.where({ $asOf: 'current' })).nodes[0]!
  const compensations = figbird.explain(figbird.q.compensations.where({ $asOf: 'effective' }))
    .nodes[0]!
  const people = figbird.explain(figbird.q.people.where({ $asOf: 'current' })).nodes[0]!
  const global = figbird.explain(figbird.q.people.where({ $tenant: 1 })).nodes[0]!
  const globalOnRoles = figbird.explain(figbird.q.jobRoles.where({ $tenant: 1 })).nodes[0]!
  const globalOnCompensations = figbird.explain(figbird.q.compensations.where({ $tenant: 1 }))
    .nodes[0]!
  const nested = figbird.explain(figbird.q.jobRoles.where({ $or: [{ $asOf: 'current' }] }))
    .nodes[0]!

  t.is(roles.class, 'local-exact')
  t.is(compensations.class, 'local-exact')
  t.is(people.class, 'server-authoritative')
  t.is(global.class, 'local-exact')
  t.is(globalOnRoles.class, 'local-exact')
  t.is(globalOnCompensations.class, 'local-exact')
  t.is(nested.class, 'server-authoritative')

  t.true(adapter.matcher({ $tenant: 1 })({ ownerId: 1 }))
  const roleMatch = adapter.matcher({ $asOf: 'current' }, undefined, {
    serviceName: 'api/job-roles',
  })
  const compensationMatch = adapter.matcher({ $asOf: 'effective' }, undefined, {
    serviceName: 'api/compensations',
  })
  t.true(roleMatch({ roleState: 'current', compensationState: 'expired' }))
  t.false(roleMatch({ roleState: 'past', compensationState: 'effective' }))
  t.true(compensationMatch({ roleState: 'past', compensationState: 'effective' }))
  t.false(compensationMatch({ roleState: 'current', compensationState: 'expired' }))
  t.deepEqual(contexts, ['api/job-roles', 'api/compensations'])

  const error = t.throws(() => adapter.matcher({ $asOf: 'current' }))
  t.regex(error.message, /service-scoped.*without a serviceName context/)
})

test('legacy useFind and builder useQuery share scoped matching and classification', async t => {
  const { App, figbird, feathers } = createTestApp(scopedSchema, scopedServices(false), {
    operators: serviceScopedOperators(),
  })
  const { render, flush, unmount } = dom()
  let legacyIds: number[] = []
  let builderIds: number[] = []

  function Probe() {
    const legacy = useFind('api/job-roles', { query: { $asOf: 'current' } })
    const builder = useQueryResult(figbird.q.jobRoles.where({ $asOf: 'current' }), {
      suspense: false,
    })
    if (legacy.status === 'success') {
      legacyIds = (legacy.data as ScopedItem[]).map(item => item.id).sort()
    }
    if (builder.status === 'success') {
      builderIds = builder.data.map(item => item.id).sort()
    }
    return null
  }

  render(
    <App>
      <Probe />
    </App>,
  )
  await flush()

  // Both query forms resolve to the same canonical service and local class.
  const rows = figbird.inspect().filter(row => row.serviceName === 'api/job-roles')
  t.true(rows.length > 0)
  t.true(rows.every(row => row.classification === 'local-exact'))

  const roles = feathers.service('api/job-roles')
  await flush(() => {
    roles.emit('created', { id: 3, ownerId: 1, roleState: 'current' })
    roles.emit('created', { id: 4, ownerId: 1, roleState: 'past' })
  })
  t.deepEqual(legacyIds, [1, 3])
  t.deepEqual(builderIds, [1, 3])

  await flush(() => {
    roles.emit('patched', { id: 3, ownerId: 1, roleState: 'past' })
    roles.emit('removed', { id: 1, ownerId: 1, roleState: 'current' })
  })
  t.deepEqual(legacyIds, [])
  t.deepEqual(builderIds, [])

  unmount()
})

test('an unsupported service reconciles from the server instead of merging', async t => {
  const { App, figbird, feathers } = createTestApp(scopedSchema, scopedServices(false), {
    operators: {
      $asOf: {
        byService: {
          'api/job-roles': state => item => (item as ScopedItem).roleState === state,
        },
      },
    },
  })
  const { render, flush, unmount } = dom()
  render(<App />)

  const ref = figbird.query(figbird.q.compensations.where({ $asOf: 'effective' }))
  const unsub = ref.subscribe(() => {})
  await ref.suspensePromise()
  await flush()

  const compensations = feathers.service('api/compensations')
  const findsAfterLoad = compensations.counts.find
  compensations.emit('created', { id: 2, compensationState: 'effective' })
  await flush()

  t.is(
    figbird.inspect().find(row => row.serviceName === 'api/compensations')!.classification,
    'server-authoritative',
  )
  t.is(compensations.counts.find, findsAfterLoad + 1)
  t.deepEqual(
    (ref.getSnapshot().data as ScopedItem[]).map(item => item.id),
    [1],
  )

  unsub()
  unmount()
})

test('materialized services evaluate scoped operators with their canonical path', async t => {
  const contexts: string[] = []
  const { App, figbird, feathers } = createTestApp(scopedSchema, scopedServices(), {
    operators: serviceScopedOperators(contexts),
  })
  const { render, flush, unmount } = dom()
  render(<App />)

  const all = figbird.query(figbird.q.jobRoles.all())
  const unsubAll = all.subscribe(() => {})
  await all.suspensePromise()
  await flush()

  const roles = feathers.service('api/job-roles')
  const findsAfterMaterialize = roles.counts.find
  const current = figbird.query(figbird.q.jobRoles.where({ $asOf: 'current' }).orderBy('id'))
  const unsubCurrent = current.subscribe(() => {})
  await current.suspensePromise()
  await flush()

  t.is(roles.counts.find, findsAfterMaterialize)
  t.deepEqual(
    (current.getSnapshot().data as ScopedItem[]).map(item => item.id),
    [1],
  )
  t.true(contexts.length > 0)
  t.true(contexts.every(serviceName => serviceName === 'api/job-roles'))

  unsubCurrent()
  unsubAll()
  unmount()
})

test('relations use the destination service registration at runtime and in explain', async t => {
  const { App, figbird, feathers } = createTestApp(scopedSchema, scopedServices(false), {
    operators: serviceScopedOperators(),
    queryAwareFind: true,
  })
  const report = figbird.explain(
    figbird.q.people.related('roles', roles => roles.where({ $asOf: 'current' })),
  )
  t.is(report.nodes.find(node => node.path === 'roles')!.class, 'local-exact')

  const { render, flush, unmount } = dom()
  render(<App />)
  const ref = figbird.query(
    figbird.q.people.related('roles', roles => roles.where({ $asOf: 'current' })),
  )
  const unsub = ref.subscribe(() => {})
  await ref.suspensePromise()
  await flush()

  const rolesService = feathers.service('api/job-roles')
  const findsAfterLoad = rolesService.counts.find
  rolesService.emit('created', { id: 3, ownerId: 1, roleState: 'current' })
  await flush()

  const person = (ref.getSnapshot().data as Array<ScopedItem & { roles: ScopedItem[] }>)[0]!
  t.deepEqual(person.roles.map(role => role.id).sort(), [1, 3])
  t.is(rolesService.counts.find, findsAfterLoad)

  unsub()
  unmount()
})

test('explain classifies junction and destination services independently', t => {
  const junctionSchema = createSchema({
    services: {
      roles: service<{ item: ScopedItem }>().at('api/roles'),
      memberships: service<{ item: ScopedItem }>().at('api/memberships'),
      users: service<{ item: ScopedItem }>().at('api/users'),
    },
    relationships: {
      roles: ({ many }) => ({
        members: many(
          {
            sourceField: 'id',
            destService: 'memberships',
            destField: 'ownerId',
            query: { $asOf: 'current' },
          },
          {
            sourceField: 'ownerId',
            destService: 'users',
            destField: 'id',
          },
        ),
      }),
    },
  })
  const { figbird } = createTestApp(
    junctionSchema,
    {
      'api/roles': { data: {} },
      'api/memberships': { data: {} },
      'api/users': { data: {} },
    },
    {
      operators: {
        $asOf: {
          byService: {
            'api/memberships': () => () => true,
          },
        },
      },
    },
  )

  const nodes = figbird.explain(figbird.q.roles.related('members')).nodes
  const junction = nodes.find(node => node.role === 'junction')!
  const destination = nodes.find(node => node.path === 'members')!
  t.is(junction.service, 'memberships')
  t.is(junction.class, 'local-exact')
  t.is(destination.service, 'users')
  t.is(destination.class, 'local-exact')
})

test('adapters with only the legacy customOperators property remain compatible', t => {
  const feathers = mockFeathers(scopedServices())
  const base = new FeathersAdapter(feathers, {
    operators: {
      $legacy: operand => item => (item as { roleState?: unknown }).roleState === operand,
    },
  })
  const legacyAdapter: Adapter<FeathersParams, FeathersFindMeta> = {
    get: base.get.bind(base),
    find: base.find.bind(base),
    findAll: base.findAll.bind(base),
    mutate: base.mutate.bind(base),
    subscribe: base.subscribe.bind(base),
    subscribeToReconnect: base.subscribeToReconnect.bind(base),
    getId: base.getId.bind(base),
    isItemStale: base.isItemStale.bind(base),
    matcher: base.matcher.bind(base),
    customOperators: ['$legacy'],
    itemAdded: base.itemAdded.bind(base),
    itemRemoved: base.itemRemoved.bind(base),
    emptyMeta: base.emptyMeta.bind(base),
    findMeta: base.findMeta.bind(base),
  }
  const figbird = new Figbird({ schema: scopedSchema, adapter: legacyAdapter })

  t.is(
    figbird.explain(figbird.q.jobRoles.where({ $legacy: 'current' })).nodes[0]!.class,
    'local-exact',
  )
  t.is(
    figbird.explain(figbird.q.compensations.where({ $legacy: 'effective' })).nodes[0]!.class,
    'local-exact',
  )
})
