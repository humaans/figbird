import EventEmitter from 'events'
import test from 'ava'
import React, { StrictMode } from 'react'
import {
  createSchema,
  createHooks,
  defineQuery,
  embed,
  FeathersAdapter,
  Figbird,
  service,
  one,
  many,
  useFind,
  useQuery,
  type QueryBuilder,
  type StandardSchemaV1,
} from '../lib'
import { createTestApp, dom, installQueryAwareFind, mockFeathers } from './helpers'

// Tagged-union variant of useQuery — the shape the deleted useRelationalQuery had.
function useStatusQuery<
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  B extends QueryBuilder<any, any, any, any, any, any>,
>(query: B, options: { skip?: boolean } = {}) {
  return useQuery(query, { ...options, suspense: false })
}

// Passthrough Standard Schema validator — used by `defineQuery` tests below to satisfy
// the `argsSchema` parameter without exercising actual validation logic.
function passthrough<T>(): StandardSchemaV1<T, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test-passthrough',
      validate: (input: unknown) => ({ value: input as T }),
    },
  }
}

// ============================================================================
// Test Types
// ============================================================================

interface Issue {
  id: number
  title: string
  status: string
  creatorId: number
}

interface IssueService {
  item: Issue
}

interface Comment {
  id: number
  issueId: number
  authorId: number
  body: string
}

interface CommentService {
  item: Comment
}

interface User {
  id: number
  name: string
  email: string
}

interface UserService {
  item: User
}

interface Reaction {
  id: number
  commentId: number
  userId: number
  emoji: string
}

interface ReactionService {
  item: Reaction
}

interface Company {
  id: number
  name: string
}

interface CompanyService {
  item: Company
}

interface Department {
  id: number
  companyId: number
  name: string
  archived: boolean
}

interface DepartmentService {
  item: Department
}

interface Employee {
  id: number
  companyId: number
  name: string
  status: 'active' | 'inactive'
  startDate?: string
}

interface EmployeeService {
  item: Employee
}

interface Employment {
  id: number
  personId: number
  effectiveAt: string
  title: string
}

interface EmploymentService {
  item: Employment
}

interface ProfilePerson {
  id: number
  name: string
  status: 'active' | 'inactive'
  managerId?: number
  startDate?: string
}

interface ProfilePersonService {
  item: ProfilePerson
}

interface ProfileEmployment {
  id: number
  personId: number
  effectiveAt: string
  title: string
}

interface ProfileEmploymentService {
  item: ProfileEmployment
}

interface TimeAwayPeriod {
  id: number
  personId: number
  balance: number
}

interface TimeAwayPeriodService {
  item: TimeAwayPeriod
}

interface Membership {
  id: number
  personId: number
  teamId: number
}

interface MembershipService {
  item: Membership
}

interface Team {
  id: number
  name: string
}

interface TeamService {
  item: Team
}

// ============================================================================
// Test Schema with Relationships
// ============================================================================

const schema = createSchema({
  services: {
    issues: service<IssueService>(),
    comments: service<CommentService>(),
    users: service<UserService>(),
    reactions: service<ReactionService>(),
  },
  relationships: ({ one: oneRel, many: manyRel }) => ({
    issues: {
      comments: manyRel({
        sourceField: ['id'],
        destService: 'comments',
        destField: ['issueId'],
      }),
      creator: oneRel({
        sourceField: ['creatorId'],
        destService: 'users',
        destField: ['id'],
      }),
    },
    comments: {
      author: oneRel({
        sourceField: ['authorId'],
        destService: 'users',
        destField: ['id'],
      }),
      reactions: manyRel({
        sourceField: ['id'],
        destService: 'reactions',
        destField: ['commentId'],
      }),
    },
  }),
})

// ============================================================================
// Mock Feathers with Multiple Services
// ============================================================================

function createApp() {
  return createTestApp(schema, {
    issues: {
      data: {
        1: { id: 1, title: 'First issue', status: 'open', creatorId: 1 },
        2: { id: 2, title: 'Second issue', status: 'closed', creatorId: 2 },
        3: { id: 3, title: 'Third issue', status: 'open', creatorId: 1 },
      },
    },
    comments: {
      data: {
        1: { id: 1, issueId: 1, authorId: 2, body: 'First comment on issue 1' },
        2: {
          id: 2,
          issueId: 1,
          authorId: 1,
          body: 'Second comment on issue 1',
        },
        3: { id: 3, issueId: 2, authorId: 1, body: 'Comment on issue 2' },
      },
    },
    users: {
      data: {
        1: { id: 1, name: 'Alice', email: 'alice@example.com' },
        2: { id: 2, name: 'Bob', email: 'bob@example.com' },
      },
    },
    reactions: {
      data: {
        1: { id: 1, commentId: 1, userId: 1, emoji: '👍' },
        2: { id: 2, commentId: 1, userId: 2, emoji: '❤️' },
        3: { id: 3, commentId: 2, userId: 2, emoji: '🎉' },
      },
    },
  })
}

const exactQuerySchema = createSchema({
  services: {
    companies: service<CompanyService>(),
    departments: service<DepartmentService>(),
    people: service<EmployeeService>(),
    employments: service<EmploymentService>(),
  },
  relationships: ({ many: manyRel, one: oneRel }) => ({
    companies: {
      departments: manyRel({
        sourceField: ['id'],
        destService: 'departments',
        destField: ['companyId'],
      }),
      people: manyRel({
        sourceField: ['id'],
        destService: 'people',
        destField: ['companyId'],
      }),
    },
    people: {
      currentEmployment: oneRel({
        sourceField: ['id'],
        destService: 'employments',
        destField: ['personId'],
      }),
    },
  }),
})

const profileQuerySchema = createSchema({
  services: {
    people: service<ProfilePersonService>(),
    employments: service<ProfileEmploymentService>(),
  },
  relationships: ({ one: oneRel, many: manyRel }) => ({
    people: {
      manager: oneRel({
        sourceField: ['managerId'],
        destService: 'people',
        destField: ['id'],
      }),
      directReports: manyRel({
        sourceField: ['id'],
        destService: 'people',
        destField: ['managerId'],
      }),
      currentEmployment: oneRel({
        sourceField: ['id'],
        destService: 'employments',
        destField: ['personId'],
      }),
    },
  }),
})

const serverProjectionQuerySchema = createSchema({
  services: {
    timeAwayPeriods: service<TimeAwayPeriodService>(),
  },
})

const membershipQuerySchema = createSchema({
  services: {
    people: service<ProfilePersonService>(),
    memberships: service<MembershipService>(),
    teams: service<TeamService>(),
  },
  relationships: ({ one: oneRel, many: manyRel }) => ({
    people: {
      memberships: manyRel({
        sourceField: ['id'],
        destService: 'memberships',
        destField: ['personId'],
      }),
    },
    memberships: {
      team: oneRel({
        sourceField: ['teamId'],
        destService: 'teams',
        destField: ['id'],
      }),
    },
  }),
})

function createExactQueryApp() {
  const services = {
    companies: {
      data: {
        1: { id: 1, name: 'Acme' },
      },
    },
    departments: {
      data: {
        1: { id: 1, companyId: 1, name: 'Engineering', archived: false },
        2: { id: 2, companyId: 1, name: 'Legacy', archived: true },
      },
    },
    people: {
      data: {
        1: { id: 1, companyId: 1, name: 'Alice', status: 'active' },
        2: { id: 2, companyId: 1, name: 'Bob', status: 'inactive' },
      },
    },
    employments: {
      data: {
        1: { id: 1, personId: 1, effectiveAt: '2024-01-01', title: 'Old role' },
        2: {
          id: 2,
          personId: 1,
          effectiveAt: '2025-04-23',
          title: 'Current role',
        },
        3: {
          id: 3,
          personId: 2,
          effectiveAt: '2025-04-23',
          title: 'Inactive role',
        },
      },
    },
  }
  return createTestApp(exactQuerySchema, services, { queryAwareFind: true })
}

function createWindowQueryApp() {
  const services = {
    companies: {
      data: {
        1: { id: 1, name: 'Acme' },
        2: { id: 2, name: 'Globex' },
      },
    },
    departments: {
      data: {},
    },
    people: {
      data: {
        1: {
          id: 1,
          companyId: 1,
          name: 'Alice',
          status: 'active',
          startDate: '2025-04-01',
        },
        2: {
          id: 2,
          companyId: 1,
          name: 'Bob',
          status: 'active',
          startDate: '2025-03-01',
        },
        3: {
          id: 3,
          companyId: 1,
          name: 'Cara',
          status: 'active',
          startDate: '2025-02-01',
        },
        4: {
          id: 4,
          companyId: 2,
          name: 'Eve',
          status: 'active',
          startDate: '2025-05-01',
        },
        5: {
          id: 5,
          companyId: 2,
          name: 'Finn',
          status: 'active',
          startDate: '2025-04-15',
        },
        6: {
          id: 6,
          companyId: 2,
          name: 'Gia',
          status: 'active',
          startDate: '2025-01-01',
        },
      },
    },
    employments: {
      data: {
        1: {
          id: 1,
          personId: 1,
          effectiveAt: '2025-04-23',
          title: 'Alice role',
        },
        2: { id: 2, personId: 2, effectiveAt: '2025-04-23', title: 'Bob role' },
        3: {
          id: 3,
          personId: 3,
          effectiveAt: '2025-04-23',
          title: 'Cara role',
        },
        4: { id: 4, personId: 4, effectiveAt: '2025-04-23', title: 'Eve role' },
        5: {
          id: 5,
          personId: 5,
          effectiveAt: '2025-04-23',
          title: 'Finn role',
        },
        6: { id: 6, personId: 6, effectiveAt: '2025-04-23', title: 'Gia role' },
      },
    },
  }
  return createTestApp(exactQuerySchema, services, { queryAwareFind: true })
}

function createProfileQueryApp() {
  const services = {
    people: {
      data: {
        1: {
          id: 1,
          name: 'Alice',
          status: 'active',
          managerId: 10,
          startDate: '2024-01-01',
        },
        2: {
          id: 2,
          name: 'Bob',
          status: 'active',
          managerId: 1,
          startDate: '2025-02-01',
        },
        3: {
          id: 3,
          name: 'Cara',
          status: 'active',
          managerId: 1,
          startDate: '2025-01-01',
        },
        4: {
          id: 4,
          name: 'Dan',
          status: 'inactive',
          managerId: 1,
          startDate: '2025-03-01',
        },
        10: {
          id: 10,
          name: 'Mira',
          status: 'active',
          managerId: 11,
          startDate: '2020-01-01',
        },
        11: {
          id: 11,
          name: 'Nia',
          status: 'active',
          startDate: '2021-01-01',
        },
      },
    },
    employments: {
      data: {
        1: {
          id: 1,
          personId: 1,
          effectiveAt: '2025-04-24',
          title: 'Head of Product',
        },
        2: { id: 2, personId: 2, effectiveAt: '2025-04-24', title: 'Engineer' },
        3: { id: 3, personId: 3, effectiveAt: '2025-04-24', title: 'Designer' },
        4: {
          id: 4,
          personId: 4,
          effectiveAt: '2025-04-24',
          title: 'Former Engineer',
        },
        10: { id: 10, personId: 10, effectiveAt: '2025-04-24', title: 'CEO' },
        11: { id: 11, personId: 11, effectiveAt: '2025-04-24', title: 'COO' },
      },
    },
  }
  return createTestApp(profileQuerySchema, services, { queryAwareFind: true })
}

function createServerProjectionQueryApp() {
  const services = {
    timeAwayPeriods: {
      data: {
        1: { id: 1, personId: 1, balance: 10 },
      },
    },
  }
  return createTestApp(serverProjectionQuerySchema, services, { queryAwareFind: true })
}

function createMembershipQueryApp() {
  const services = {
    people: {
      data: {
        1: { id: 1, name: 'Alice', status: 'active' },
      },
    },
    memberships: {
      data: {
        1: { id: 1, personId: 1, teamId: 1 },
      },
    },
    teams: {
      data: {
        1: { id: 1, name: 'Engineering' },
        2: { id: 2, name: 'Operations' },
      },
    },
  }
  return createTestApp(membershipQuerySchema, services, { queryAwareFind: true })
}

// ============================================================================
// Query Builder Tests
// ============================================================================

test('QueryBuilder: creates basic AST', t => {
  const { figbird } = createApp()
  const { q } = figbird

  const query = q.issues.where({ status: 'open' }).limit(10)
  const ast = query.toAST()

  t.deepEqual(ast, {
    service: 'issues',
    kind: 'find',
    query: { status: 'open', $limit: 10 },
    cardinality: 'many',
    related: {},
  })
})

test('QueryBuilder: hash is stable for same query', t => {
  const { figbird } = createApp()
  const { q } = figbird

  const query1 = q.issues.where({ status: 'open' }).limit(10)
  const query2 = q.issues.where({ status: 'open' }).limit(10)

  t.is(query1.hash(), query2.hash())
})

test('QueryBuilder: hash differs for different queries', t => {
  const { figbird } = createApp()
  const { q } = figbird

  const query1 = q.issues.where({ status: 'open' })
  const query2 = q.issues.where({ status: 'closed' })

  t.not(query1.hash(), query2.hash())
})

test('QueryBuilder: one() sets cardinality', t => {
  const { figbird } = createApp()
  const { q } = figbird

  const query = q.issues.where({ id: 1 }).one()
  const ast = query.toAST()

  t.is(ast.cardinality, 'one')
})

test('QueryBuilder: orderBy adds $sort', t => {
  const { figbird } = createApp()
  const { q } = figbird

  const query = q.issues.orderBy('createdAt', 'desc').orderBy('title', 'asc')
  const ast = query.toAST()

  t.deepEqual(ast.query.$sort, { createdAt: -1, title: 1 })
})

test('QueryBuilder: skip adds $skip', t => {
  const { figbird } = createApp()
  const { q } = figbird

  const query = q.issues.skip(20).limit(10)
  const ast = query.toAST()

  t.is(ast.query.$skip, 20)
  t.is(ast.query.$limit, 10)
})

test('QueryBuilder: where() merges queries', t => {
  const { figbird } = createApp()
  const { q } = figbird

  const query = q.issues.where({ status: 'open' }).where({ creatorId: 1 })
  const ast = query.toAST()

  t.deepEqual(ast.query, { status: 'open', creatorId: 1 })
})

test('QueryBuilder: related() adds relation to AST', t => {
  const { figbird } = createApp()
  const { q } = figbird

  const query = q.issues.related('comments')
  const ast = query.toAST()

  t.truthy(ast.related.comments)
  t.is(ast.related.comments!.service, 'comments')
  t.is(ast.related.comments!.cardinality, 'many')
})

test('QueryBuilder: related() with refinement callback', t => {
  const { figbird } = createApp()
  const { q } = figbird

  const query = q.issues.related('comments', c => c.orderBy('id', 'desc').limit(5))
  const ast = query.toAST()

  t.truthy(ast.related.comments)
  t.deepEqual(ast.related.comments!.query, { $sort: { id: -1 }, $limit: 5 })
})

test('QueryBuilder: nested relations', t => {
  const { figbird } = createApp()
  const { q } = figbird

  const query = q.issues
    .related('comments', c => c.related('reactions').related('author'))
    .related('creator')

  const ast = query.toAST()

  // Top level relations
  t.truthy(ast.related.comments)
  t.truthy(ast.related.creator)
  t.is(ast.related.creator!.cardinality, 'one')

  // Nested relations on comments
  t.truthy(ast.related.comments!.related.reactions)
  t.truthy(ast.related.comments!.related.author)
  t.is(ast.related.comments!.related.author!.cardinality, 'one')
})

test('QueryBuilder: server marks query as server-maintained in AST', t => {
  const { figbird } = createServerProjectionQueryApp()

  const ast = figbird.q.timeAwayPeriods.where({ personId: 1 }).server().toAST()

  t.true(ast.server)
})

// ============================================================================
// RelationalQueryRef (Imperative) Tests
// ============================================================================

test('figbird.relationalQuery: creates RelationalQueryRef', t => {
  const { figbird } = createApp()

  const qRef = figbird.relationalQuery(figbird.q.issues.where({ status: 'open' }))

  t.truthy(qRef)
  t.truthy(qRef.hash())
  t.truthy(qRef.details().queryId)
})

test('figbird.relationalQuery: hash is stable for same query', t => {
  const { figbird } = createApp()

  const qRef1 = figbird.relationalQuery(figbird.q.issues.where({ status: 'open' }))
  const qRef2 = figbird.relationalQuery(figbird.q.issues.where({ status: 'open' }))

  t.is(qRef1.hash(), qRef2.hash())
})

test('figbird.relationalQuery: subscribe triggers fetch', async t => {
  const { figbird } = createApp()

  const qRef = figbird.relationalQuery(figbird.q.issues)

  // Track state changes
  const states: string[] = []

  await new Promise<void>(resolve => {
    const unsub = qRef.subscribe(state => {
      states.push(state.status)
      if (state.status === 'success') {
        unsub()
        resolve()
      }
    })
  })

  // Note: The listener doesn't see 'loading' because QueryStore adds the listener
  // AFTER calling #queue (which triggers the loading notification synchronously).
  // This is consistent with how QueryRef.subscribe works.
  // For React hooks, useSyncExternalStore calls getSnapshot() to get initial state.
  t.true(states.includes('success'))
  t.is(states.filter(s => s === 'success').length, 1) // Only notified once
})

test('figbird.relationalQuery: getSnapshot returns current state', async t => {
  const { figbird } = createApp()

  const qRef = figbird.relationalQuery(figbird.q.issues)

  // Before subscribe, should return loading
  const beforeSnapshot = qRef.getSnapshot()
  t.is(beforeSnapshot.status, 'loading')

  // Subscribe and wait for success
  let unsub: () => void
  await new Promise<void>(resolve => {
    unsub = qRef.subscribe(state => {
      if (state.status === 'success') {
        resolve()
      }
    })
  })

  // After success, snapshot should have data (while still subscribed)
  const afterSnapshot = qRef.getSnapshot()
  t.is(afterSnapshot.status, 'success')
  t.truthy(afterSnapshot.data)

  // Clean up
  unsub!()
})

test('figbird.query: inactive server-maintained cache-first query refetches on next subscription', async t => {
  const { figbird, feathers } = createServerProjectionQueryApp()
  const periodsService = feathers.service('timeAwayPeriods')

  const queryRef = figbird.query(
    {
      serviceName: 'timeAwayPeriods',
      method: 'find',
      params: { query: { personId: 1 } },
    },
    {
      fetchPolicy: 'cache-first',
      realtime: 'merge',
      server: true,
    },
  )

  let unsubscribe: () => void = () => {}
  const initialData = await new Promise<TimeAwayPeriod[]>(resolve => {
    unsubscribe = queryRef.subscribe(state => {
      if (state.status === 'success' && !state.isFetching) {
        resolve(state.data)
      }
    })
  })
  unsubscribe()

  t.is(initialData[0]?.balance, 10)
  const initialFindCount = periodsService.counts.find

  await periodsService.patch(1, { balance: 12 })
  await new Promise(resolve => setTimeout(resolve, 10))

  t.is(periodsService.counts.find, initialFindCount)

  let refetchUnsubscribe: () => void = () => {}
  const refetchedData = await new Promise<TimeAwayPeriod[]>(resolve => {
    refetchUnsubscribe = queryRef.subscribe(state => {
      if (state.status === 'success' && !state.isFetching) {
        refetchUnsubscribe()
        resolve(state.data)
      }
    })
  })

  t.is(refetchedData[0]?.balance, 12)
  t.is(periodsService.counts.find, initialFindCount + 1)
})

test('figbird.query: unsupported query operators are auto server-maintained', async t => {
  const { figbird, feathers } = createWindowQueryApp()
  const peopleService = feathers.service('people')

  const queryRef = figbird.query(
    {
      serviceName: 'people',
      method: 'find',
      params: {
        query: {
          companyId: 1,
          $search: 'alice',
        },
      },
    },
    {
      fetchPolicy: 'swr',
      realtime: 'merge',
    },
  )

  let unsubscribe: () => void = () => {}
  const initialData = await new Promise<Employee[]>(resolve => {
    unsubscribe = queryRef.subscribe(state => {
      if (state.status === 'success' && !state.isFetching) {
        resolve(state.data)
      }
    })
  })

  t.deepEqual(
    initialData.map(person => person.name),
    ['Alice', 'Bob', 'Cara'],
  )
  const initialFindCount = peopleService.counts.find

  await peopleService.patch(1, { name: 'Alicia' })
  await new Promise(resolve => setTimeout(resolve, 10))

  t.is(peopleService.counts.find, initialFindCount + 1)
  unsubscribe()
})

test('figbird.query: inactive server-windowed cache-first query refetches on next subscription', async t => {
  const { figbird, feathers } = createWindowQueryApp()
  const peopleService = feathers.service('people')

  const queryRef = figbird.query(
    {
      serviceName: 'people',
      method: 'find',
      params: {
        query: {
          companyId: 1,
          status: 'active',
          $sort: { startDate: -1, id: 1 },
          $limit: 2,
        },
      },
    },
    {
      fetchPolicy: 'cache-first',
      realtime: 'merge',
    },
  )

  let unsubscribe: () => void = () => {}
  const initialData = await new Promise<Employee[]>(resolve => {
    unsubscribe = queryRef.subscribe(state => {
      if (state.status === 'success' && !state.isFetching) {
        resolve(state.data)
      }
    })
  })
  unsubscribe()

  t.deepEqual(
    initialData.map(person => person.name),
    ['Alice', 'Bob'],
  )
  const initialFindCount = peopleService.counts.find

  await peopleService.create({
    id: 4,
    companyId: 1,
    name: 'Dana',
    status: 'active',
    startDate: '2025-05-01',
  })
  await new Promise(resolve => setTimeout(resolve, 10))

  t.is(peopleService.counts.find, initialFindCount)

  let refetchUnsubscribe: () => void = () => {}
  const refetchedData = await new Promise<Employee[]>(resolve => {
    refetchUnsubscribe = queryRef.subscribe(state => {
      if (state.status === 'success' && !state.isFetching) {
        refetchUnsubscribe()
        resolve(state.data)
      }
    })
  })

  t.deepEqual(
    refetchedData.map(person => person.name),
    ['Dana', 'Alice'],
  )
  t.is(peopleService.counts.find, initialFindCount + 1)
})

test('figbird.query: reconnect refetches active queries after missed events', async t => {
  const feathers = mockFeathers({
    companies: {
      data: {
        1: { id: 1, name: 'Acme' },
      },
    },
    departments: {
      data: {},
    },
    people: {
      data: {
        1: { id: 1, companyId: 1, name: 'Alice', status: 'active' },
      },
    },
    employments: {
      data: {},
    },
  })
  const reconnectEvents = new EventEmitter()
  ;(feathers as ReturnType<typeof mockFeathers> & { io: EventEmitter }).io = reconnectEvents
  installQueryAwareFind(feathers, ['companies', 'departments', 'people', 'employments'])

  const figbird = new Figbird({
    schema: exactQuerySchema,
    adapter: new FeathersAdapter(feathers),
    eventBatchProcessingInterval: 0,
  })
  const peopleService = feathers.service('people')
  const queryRef = figbird.query({
    serviceName: 'people',
    method: 'find',
    params: { query: { companyId: 1 } },
  })

  let latestNames: string[] = []
  const unsubscribe = queryRef.subscribe(state => {
    if (state.status === 'success' && !state.isFetching) {
      latestNames = state.data.map(person => person.name)
    }
  })

  await new Promise(resolve => setTimeout(resolve, 10))

  t.deepEqual(latestNames, ['Alice'])
  const initialFindCount = peopleService.counts.find

  peopleService.data = {
    ...peopleService.data,
    1: { id: 1, companyId: 1, name: 'Alicia', status: 'active' },
  }
  reconnectEvents.emit('reconnect')
  await new Promise(resolve => setTimeout(resolve, 10))

  t.is(peopleService.counts.find, initialFindCount + 1)
  t.deepEqual(latestNames, ['Alicia'])

  unsubscribe()
})

// ============================================================================
// useRelationalQuery Hook Tests
// ============================================================================

test('useRelationalQuery: basic fetch', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird } = createApp()

  function IssueList() {
    const issues = useStatusQuery(figbird.q.issues)

    if (issues.status === 'loading') {
      return <div className='loading'>Loading...</div>
    }

    if (issues.status === 'error') {
      return <div className='error'>{issues.error.message}</div>
    }

    return (
      <div className='issues'>
        {(issues.data as unknown as Issue[]).map((issue: Issue) => (
          <div key={issue.id} className='issue'>
            {issue.title}
          </div>
        ))}
      </div>
    )
  }

  render(
    <App>
      <IssueList />
    </App>,
  )

  t.is($('.loading')!.innerHTML, 'Loading...')

  await flush()

  t.is($('.issues')!.querySelectorAll('.issue').length, 3)

  unmount()
})

test('useRelationalQuery: with relations', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird } = createApp()

  function IssueWithCreator() {
    const issue = useStatusQuery(figbird.q.issues.where({ id: 1 }).one().related('creator'))

    if (issue.status === 'loading') {
      return <div className='loading'>Loading...</div>
    }

    if (issue.status === 'error') {
      return <div className='error'>{issue.error.message}</div>
    }

    const data = issue.data as Issue & { creator: User | null }

    return (
      <div className='issue-detail'>
        <div className='title'>{data.title}</div>
        <div className='creator'>{data.creator?.name ?? 'Unknown'}</div>
      </div>
    )
  }

  render(
    <App>
      <IssueWithCreator />
    </App>,
  )

  t.is($('.loading')!.innerHTML, 'Loading...')

  await flush()

  t.truthy($('.issue-detail'))
  t.is($('.title')!.innerHTML, 'First issue')
  t.is($('.creator')!.innerHTML, 'Alice')

  unmount()
})

test('useRelationalQuery: with many relation', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird } = createApp()

  function IssueWithComments() {
    const issue = useStatusQuery(figbird.q.issues.where({ id: 1 }).one().related('comments'))

    if (issue.status === 'loading') {
      return <div className='loading'>Loading...</div>
    }

    if (issue.status === 'error') {
      return <div className='error'>{issue.error.message}</div>
    }

    const data = issue.data as Issue & { comments: Comment[] }

    return (
      <div className='issue-detail'>
        <div className='title'>{data.title}</div>
        <div className='comment-count'>{data.comments.length}</div>
      </div>
    )
  }

  render(
    <App>
      <IssueWithComments />
    </App>,
  )

  await flush()

  t.truthy($('.issue-detail'))
  t.is($('.comment-count')!.innerHTML, '2') // Issue 1 has 2 comments

  unmount()
})

test('useRelationalQuery: query changes trigger refetch', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird, feathers } = createApp()

  // Track fetch calls to verify refetch happens
  let fetchCount = 0
  const originalFind = feathers.service('issues').find.bind(feathers.service('issues'))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  feathers.service('issues').find = async (params: any) => {
    fetchCount++
    return originalFind(params)
  }

  let status = 'open'
  let setStatus: (s: string) => void

  function IssueList() {
    const [currentStatus, setCurrentStatus] = React.useState(status)
    setStatus = setCurrentStatus

    const issues = useStatusQuery(figbird.q.issues.where({ status: currentStatus }))

    if (issues.status === 'loading') {
      return <div className='loading'>Loading...</div>
    }

    if (issues.status === 'error') {
      return <div className='error'>{issues.error.message}</div>
    }

    return (
      <div className='issues'>
        <span className='status'>{currentStatus}</span>
        <span className='count'>{(issues.data as unknown as Issue[]).length}</span>
      </div>
    )
  }

  render(
    <App>
      <IssueList />
    </App>,
  )

  await flush()

  t.is(fetchCount, 1, 'Initial fetch')
  t.is($('.status')!.innerHTML, 'open')

  // Change the query param
  await flush(() => {
    setStatus('closed')
  })

  // Wait for refetch
  await flush()

  t.is(fetchCount, 2, 'Refetch after query change')
  t.is($('.status')!.innerHTML, 'closed')

  unmount()
})

test('useRelationalQuery: skip option prevents fetch', async t => {
  const { render, unmount, flush } = dom()
  const { App, figbird, feathers } = createApp()

  let fetchCount = 0
  const originalFind = feathers.service('issues').find.bind(feathers.service('issues'))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  feathers.service('issues').find = async (params: any) => {
    fetchCount++
    return originalFind(params)
  }

  function SkippedQuery() {
    const issues = useStatusQuery(figbird.q.issues, { skip: true })

    return <div className='status'>{issues.status}</div>
  }

  render(
    <App>
      <SkippedQuery />
    </App>,
  )

  await flush()

  // Status should be 'idle' and no fetch should have happened
  t.is(fetchCount, 0)

  unmount()
})

test('useRelationalQuery: refetch function works', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird, feathers } = createApp()

  let fetchCount = 0
  const originalFind = feathers.service('issues').find.bind(feathers.service('issues'))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  feathers.service('issues').find = async (params: any) => {
    fetchCount++
    return originalFind(params)
  }

  let triggerRefetch: () => void

  function RefetchTest() {
    const issues = useStatusQuery(figbird.q.issues)
    triggerRefetch = issues.refetch

    if (issues.status === 'loading') {
      return <div className='loading'>Loading...</div>
    }

    return <div className='loaded'>Loaded</div>
  }

  render(
    <App>
      <RefetchTest />
    </App>,
  )

  await flush()

  t.is(fetchCount, 1)
  t.is($('.loaded')!.innerHTML, 'Loaded')

  // Trigger refetch
  await flush(() => {
    triggerRefetch()
  })

  await flush()

  t.is(fetchCount, 2)

  unmount()
})

// ============================================================================
// Schema Relationship Tests
// ============================================================================

test('schema: one() helper creates correct relationship', t => {
  const rel = one({
    sourceField: ['creatorId'],
    destService: 'users',
    destField: ['id'],
  })

  t.is(rel.cardinality, 'one')
  t.deepEqual(rel.sourceField, ['creatorId'])
  t.is(rel.destService, 'users')
  t.deepEqual(rel.destField, ['id'])
})

test('schema: many() helper creates correct relationship', t => {
  const rel = many({
    sourceField: ['id'],
    destService: 'comments',
    destField: ['issueId'],
  })

  t.is(rel.cardinality, 'many')
  t.deepEqual(rel.sourceField, ['id'])
  t.is(rel.destService, 'comments')
  t.deepEqual(rel.destField, ['issueId'])
})

test('schema: relationships are accessible on schema', t => {
  t.truthy(schema.relationships)
  t.truthy(schema.relationships!.issues)
  t.truthy(schema.relationships!.issues!.comments)
  t.truthy(schema.relationships!.issues!.creator)
  t.truthy(schema.relationships!.comments)
  t.truthy(schema.relationships!.comments!.author)
  t.truthy(schema.relationships!.comments!.reactions)
})

test('schema: relationship properties are correct', t => {
  const issueComments = schema.relationships!.issues!.comments!
  t.is(issueComments.cardinality, 'many')
  t.deepEqual(issueComments.sourceField, ['id'])
  t.is(issueComments.destService, 'comments')
  t.deepEqual(issueComments.destField, ['issueId'])

  const issueCreator = schema.relationships!.issues!.creator!
  t.is(issueCreator.cardinality, 'one')
  t.deepEqual(issueCreator.sourceField, ['creatorId'])
  t.is(issueCreator.destService, 'users')
  t.deepEqual(issueCreator.destField, ['id'])
})

// ============================================================================
// Cache Sharing Tests (new in v2)
// ============================================================================

test('useRelationalQuery: two components share cached data', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird, feathers } = createApp()

  // Track fetch calls - should only fetch once for shared queries
  let fetchCount = 0
  const originalFind = feathers.service('issues').find.bind(feathers.service('issues'))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  feathers.service('issues').find = async (params: any) => {
    fetchCount++
    return originalFind(params)
  }

  function IssueListA() {
    const issues = useStatusQuery(figbird.q.issues)

    if (issues.status === 'loading') {
      return <div className='loading-a'>Loading A...</div>
    }

    return <div className='list-a'>List A: {(issues.data as unknown as Issue[]).length}</div>
  }

  function IssueListB() {
    const issues = useStatusQuery(figbird.q.issues)

    if (issues.status === 'loading') {
      return <div className='loading-b'>Loading B...</div>
    }

    return <div className='list-b'>List B: {(issues.data as unknown as Issue[]).length}</div>
  }

  render(
    <App>
      <IssueListA />
      <IssueListB />
    </App>,
  )

  await flush()

  // Both components should show data
  t.truthy($('.list-a'))
  t.truthy($('.list-b'))

  // Both should show same count
  t.is($('.list-a')!.innerHTML, 'List A: 3')
  t.is($('.list-b')!.innerHTML, 'List B: 3')

  // Should only have fetched once (cache sharing)
  t.is(fetchCount, 1)

  unmount()
})

// ============================================================================
// createHooks Tests
// ============================================================================

test('createHooks: useQuery with suspense:false is exported and works', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird } = createApp()

  // Create typed hooks from figbird instance
  const { useQuery: useTypedQuery, q } = createHooks(figbird)

  function IssueWithCreator() {
    // Use the typed hook - the query builder should be properly typed
    const issue = useTypedQuery(q.issues.where({ id: 1 }).one().related('creator'), {
      suspense: false,
    })

    if (issue.status === 'loading') {
      return <div className='loading'>Loading...</div>
    }

    if (issue.status === 'error') {
      return <div className='error'>{issue.error.message}</div>
    }

    const data = issue.data as Issue & { creator: User | null }

    return (
      <div className='issue-detail'>
        <div className='title'>{data.title}</div>
        <div className='creator'>{data.creator?.name ?? 'Unknown'}</div>
      </div>
    )
  }

  render(
    <App>
      <IssueWithCreator />
    </App>,
  )

  t.is($('.loading')!.innerHTML, 'Loading...')

  await flush()

  t.truthy($('.issue-detail'))
  t.is($('.title')!.innerHTML, 'First issue')
  t.is($('.creator')!.innerHTML, 'Alice')

  unmount()
})

// ============================================================================
// Realtime Tests — events flow into assembled relational views
// ============================================================================

test('realtime: creating a child entity appears in the active relation view', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird, feathers } = createApp()

  function IssueWithComments() {
    const issue = useStatusQuery(figbird.q.issues.where({ id: 1 }).one().related('comments'))
    if (issue.status !== 'success') return <div className='loading'>Loading...</div>
    const data = issue.data as Issue & { comments: Comment[] }
    return (
      <div className='issue-detail'>
        <div className='title'>{data.title}</div>
        <div className='comment-count'>{data.comments.length}</div>
        <ul className='comment-list'>
          {data.comments.map(c => (
            <li key={c.id} className='comment' data-id={c.id}>
              {c.body}
            </li>
          ))}
        </ul>
      </div>
    )
  }

  render(
    <App>
      <IssueWithComments />
    </App>,
  )
  await flush()

  t.is($('.comment-count')!.innerHTML, '2')

  // Simulate a new comment created on the server for the active issue. The mock emits
  // a 'created' event after the create promise resolves, which is exactly what a
  // socket.io-driven Feathers push would look like.
  await feathers.service('comments').create({
    id: 99,
    issueId: 1,
    authorId: 1,
    body: 'A fresh comment arriving via realtime',
  })
  await flush()

  t.is($('.comment-count')!.innerHTML, '3')
  t.truthy($('.comment[data-id="99"]'))
  t.is($('.comment[data-id="99"]')!.innerHTML, 'A fresh comment arriving via realtime')

  unmount()
})

test('realtime: patching a related entity updates the assembled view', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird, feathers } = createApp()

  function IssueWithCreator() {
    const issue = useStatusQuery(figbird.q.issues.where({ id: 1 }).one().related('creator'))
    if (issue.status !== 'success') return <div className='loading'>Loading...</div>
    const data = issue.data as Issue & { creator: User | null }
    return <div className='creator'>{data.creator?.name ?? 'Unknown'}</div>
  }

  render(
    <App>
      <IssueWithCreator />
    </App>,
  )
  await flush()

  t.is($('.creator')!.innerHTML, 'Alice')

  await feathers.service('users').patch(1, { name: 'Alicia' })
  await flush()

  t.is($('.creator')!.innerHTML, 'Alicia')

  unmount()
})

test('realtime: removing a related entity removes it from the assembled view', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird, feathers } = createApp()

  function IssueWithComments() {
    const issue = useStatusQuery(figbird.q.issues.where({ id: 1 }).one().related('comments'))
    if (issue.status !== 'success') return <div className='loading'>Loading...</div>
    const data = issue.data as Issue & { comments: Comment[] }
    return <div className='comment-count'>{data.comments.length}</div>
  }

  render(
    <App>
      <IssueWithComments />
    </App>,
  )
  await flush()

  t.is($('.comment-count')!.innerHTML, '2')

  await feathers.service('comments').remove(1)
  await flush()

  t.is($('.comment-count')!.innerHTML, '1')

  unmount()
})

test('realtime: a new root entity gets its relations fetched (Gap B)', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird, feathers } = createApp()

  // Pre-seed a comment for an issue that doesn't exist yet — so when the issue gets
  // created via realtime, the comment should naturally appear on it after relation sync.
  await feathers.service('comments').create({
    id: 100,
    issueId: 42,
    authorId: 1,
    body: 'Comment belonging to issue 42',
  })

  function IssueList() {
    const issues = useStatusQuery(figbird.q.issues.related('comments'))
    if (issues.status !== 'success') return <div className='loading'>Loading...</div>
    const data = issues.data as unknown as Array<Issue & { comments: Comment[] }>
    return (
      <div className='list'>
        {data.map(i => (
          <div key={i.id} className='issue' data-id={i.id}>
            {i.title} — {i.comments.length} comments
          </div>
        ))}
      </div>
    )
  }

  render(
    <App>
      <IssueList />
    </App>,
  )
  await flush()

  // Initial: 3 issues, none of which is issue 42
  t.is($('.list')!.children.length, 3)
  t.falsy($('.issue[data-id="42"]'))

  // A brand new issue appears via realtime.
  await feathers.service('issues').create({
    id: 42,
    title: 'Late-arriving issue',
    status: 'open',
    creatorId: 1,
  })
  await flush()

  // The new issue must show up AND have its comments re-fetched. Before the Gap B fix,
  // the $in filter for comments was frozen at the initial issue ids [1,2,3] and the new
  // root entity would never get its related data.
  t.truthy($('.issue[data-id="42"]'))
  t.is($('.issue[data-id="42"]')!.innerHTML, 'Late-arriving issue — 1 comments')

  unmount()
})

test('realtime: relation-path filters match root events through cached relations', async t => {
  interface FilterDocument {
    id: number
    title: string
    personId: number
  }

  interface FilterPerson {
    id: number
    name: string
    orgUnitId: number
  }

  interface FilterOrgUnit {
    id: number
    label: string
  }

  const filterSchema = createSchema({
    services: {
      documents: service<{ item: FilterDocument }>(),
      people: service<{ item: FilterPerson }>(),
      orgUnits: service<{ item: FilterOrgUnit }>(),
    },
    relationships: ({ one: oneRel }) => ({
      documents: {
        person: oneRel({ sourceField: ['personId'], destService: 'people', destField: ['id'] }),
      },
      people: {
        orgUnit: oneRel({ sourceField: ['orgUnitId'], destService: 'orgUnits', destField: ['id'] }),
      },
    }),
  })

  const { App, figbird, feathers } = createTestApp(filterSchema, {
    documents: { data: {} },
    people: {
      data: {
        1: { id: 1, name: 'Ari', orgUnitId: 1 },
        2: { id: 2, name: 'Bea', orgUnitId: 2 },
      },
    },
    orgUnits: {
      data: {
        1: { id: 1, label: 'Engineering' },
        2: { id: 2, label: 'People' },
      },
    },
  })
  const { render, unmount, flush, $all } = dom()

  function Documents() {
    const people = useStatusQuery(figbird.q.people.related('orgUnit'))
    const documents = useStatusQuery(
      figbird.q.documents
        .where({ 'person.orgUnit.label': 'Engineering' })
        .related('person', person => person.related('orgUnit')),
    )

    if (people.status !== 'success' || documents.status !== 'success') {
      return <div className='loading'>Loading...</div>
    }

    return (
      <ul>
        {documents.data.map(document => (
          <li key={document.id} className='document'>
            {document.title} - {document.person?.orgUnit?.label ?? 'unknown'}
          </li>
        ))}
      </ul>
    )
  }

  render(
    <App>
      <Documents />
    </App>,
  )
  await flush()

  t.deepEqual(
    $all('.document').map(node => node.innerHTML),
    [],
  )

  await feathers.service('documents').create({ id: 1, title: 'Matching doc', personId: 1 })
  await feathers.service('documents').create({ id: 2, title: 'Filtered out doc', personId: 2 })
  await flush()

  t.deepEqual(
    $all('.document').map(node => node.innerHTML),
    ['Matching doc - Engineering'],
  )

  const findCountAfterRootEvents = feathers.service('documents').counts.find

  await feathers.service('people').patch(1, { name: 'Ari Renamed' })
  await flush()

  t.is(
    feathers.service('documents').counts.find,
    findCountAfterRootEvents,
    'unrelated middle-row field changes should not refetch relation-filtered roots',
  )

  await feathers.service('people').patch(1, { orgUnitId: 2 })
  await flush()

  t.is(
    feathers.service('documents').counts.find,
    findCountAfterRootEvents + 1,
    'join-field changes on a middle relation should refetch relation-filtered roots',
  )

  await feathers.service('orgUnits').patch(2, { label: 'Engineering' })
  await flush()

  t.is(
    feathers.service('documents').counts.find,
    findCountAfterRootEvents + 2,
    'filter-field changes on a leaf relation should refetch relation-filtered roots',
  )

  unmount()
})

test('realtime: child entity arrival on nested relation updates the assembled view', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird, feathers } = createApp()

  function IssueWithCommentReactions() {
    const issue = useStatusQuery(
      figbird.q.issues
        .where({ id: 1 })
        .one()
        .related('comments', c => c.related('reactions')),
    )
    if (issue.status !== 'success') return <div className='loading'>Loading...</div>
    const data = issue.data as Issue & {
      comments: Array<Comment & { reactions: Reaction[] }>
    }
    return (
      <div className='issue-detail'>
        {data.comments.map(c => (
          <div key={c.id} className='comment' data-id={c.id}>
            r={c.reactions.length}
          </div>
        ))}
      </div>
    )
  }

  render(
    <App>
      <IssueWithCommentReactions />
    </App>,
  )
  await flush()

  // Issue 1 has comments 1 (2 reactions), 2 (1 reaction)
  t.is($('.comment[data-id="1"]')!.innerHTML, 'r=2')
  t.is($('.comment[data-id="2"]')!.innerHTML, 'r=1')

  // New reaction on comment 2 should propagate into the nested view.
  await feathers.service('reactions').create({
    id: 99,
    commentId: 2,
    userId: 1,
    emoji: '🚀',
  })
  await flush()

  t.is($('.comment[data-id="2"]')!.innerHTML, 'r=2')

  unmount()
})

// ============================================================================
// Suspense Tests — useQuery suspends on cold first mount, never re-suspends
// ============================================================================

class ErrorBoundary extends React.Component<
  { fallback: (err: Error) => React.ReactNode; children?: React.ReactNode },
  { error: Error | null }
> {
  override state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  override render() {
    if (this.state.error) return this.props.fallback(this.state.error)
    return this.props.children
  }
}

test('suspense: first-mount cold shows fallback, then data', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird } = createApp()

  function IssueDetail() {
    const { data } = useQuery(figbird.q.issues.where({ id: 1 }).one().related('creator'))
    // With Suspense mode, data is guaranteed to be defined here.
    const issue = data as Issue & { creator: User | null }
    return (
      <div className='issue-detail'>
        <div className='title'>{issue.title}</div>
        <div className='creator'>{issue.creator?.name ?? 'Unknown'}</div>
      </div>
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='fallback'>Loading...</div>}>
        <IssueDetail />
      </React.Suspense>
    </App>,
  )

  // Before flushing: the promise thrown by useQuery triggers Suspense to render fallback.
  t.truthy($('.fallback'))
  t.falsy($('.issue-detail'))

  await flush()

  // After flush: promise resolved, data rendered.
  t.falsy($('.fallback'))
  t.truthy($('.issue-detail'))
  t.is($('.title')!.innerHTML, 'First issue')
  t.is($('.creator')!.innerHTML, 'Alice')

  unmount()
})

test('get(): consecutive getSnapshot reads return ref-equal results (regression)', async t => {
  // Without caching the wrapped [data] array in #rootDataAsArray, the inputsChanged
  // check in getSnapshot trips on every read for `.get()` queries because the wrapper
  // array is a fresh allocation each call. lastSnapshot would be rebuilt each time and
  // useSyncExternalStore enters an infinite render loop ("getSnapshot should be cached").
  const { figbird } = createApp()

  const ref = figbird.relationalQuery(figbird.q.issues.get(1).related('creator'))

  // Subscribe so the underlying query actually fires.
  const unsubscribe = ref.subscribe(() => {})
  // Wait for the underlying queries to resolve.
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))

  const a = ref.getSnapshot()
  const b = ref.getSnapshot()
  const c = ref.getSnapshot()

  t.is(a.status, 'success')
  t.is(a, b, 'getSnapshot must return ref-equal results when nothing has changed')
  t.is(b, c, 'getSnapshot must stay stable across consecutive reads')

  unsubscribe()
})

test('suspense: refetch does not re-suspend', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird } = createApp()

  let refetchFn: (() => void) | null = null

  function IssueDetail() {
    const { data, isFetching, refetch } = useQuery(
      figbird.q.issues.where({ id: 1 }).one().related('creator'),
    )
    refetchFn = refetch
    const issue = data as Issue & { creator: User | null }
    return (
      <div className='issue-detail' data-fetching={isFetching}>
        <div className='title'>{issue.title}</div>
      </div>
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='fallback'>Loading...</div>}>
        <IssueDetail />
      </React.Suspense>
    </App>,
  )
  await flush()

  t.truthy($('.issue-detail'))
  t.is($('.title')!.innerHTML, 'First issue')

  // Trigger a refetch — the component must not unmount / show fallback again.
  await flush(() => {
    refetchFn!()
  })

  t.truthy($('.issue-detail'))
  t.falsy($('.fallback'))
  t.is($('.title')!.innerHTML, 'First issue')

  unmount()
})

test('suspense: param change inside startTransition keeps previous render committed', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird, feathers } = createApp()

  let setIssueId: ((id: number) => void) | null = null

  function IssueDetail() {
    const [issueId, _setIssueId] = React.useState(1)
    setIssueId = _setIssueId
    const { data, isFetching } = useQuery(
      figbird.q.issues.where({ id: issueId }).one().related('creator'),
    )
    const issue = data as Issue & { creator: User | null }
    return (
      <div className='issue-detail' data-fetching={isFetching}>
        <div className='title'>{issue.title}</div>
        <div className='id' data-current-id={issueId} />
      </div>
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='fallback'>Loading...</div>}>
        <IssueDetail />
      </React.Suspense>
    </App>,
  )
  await flush()

  t.is($('.title')!.innerHTML, 'First issue')
  t.is($('.id')!.getAttribute('data-current-id'), '1')

  // Slow down the next fetch so we can catch the transition window.
  feathers.service('issues').setDelay(30)

  // Update the param INSIDE startTransition — React keeps the previous render
  // committed while the new query resolves; the fallback must NOT flash.
  await flush(() => {
    React.startTransition(() => {
      setIssueId!(2)
    })
  })

  t.falsy($('.fallback'), 'fallback must not flash on transition-driven param change')
  t.truthy($('.issue-detail'))

  unmount()
})

test('suspense: first-mount error throws to ErrorBoundary', async t => {
  const { render, unmount, flush, $, act } = dom()
  const { App, figbird, feathers } = createApp()

  // Make the root fetch reject — this should trigger throw to the ErrorBoundary on
  // first mount, not render the fallback nor the component.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  feathers.service('issues').find = async () => {
    throw new Error('boom')
  }

  function IssueDetail() {
    const { data } = useQuery(figbird.q.issues.where({ id: 1 }).one())
    const issue = data as Issue
    return <div className='issue-detail'>{issue.title}</div>
  }

  // swallow React's error-boundary console noise
  const prevError = console.error
  console.error = () => {}
  try {
    render(
      <App>
        <ErrorBoundary fallback={err => <div className='boundary'>{err.message}</div>}>
          <React.Suspense fallback={<div className='fallback'>Loading...</div>}>
            <IssueDetail />
          </React.Suspense>
        </ErrorBoundary>
      </App>,
    )
    // Let promise rejection propagate.
    await act(async () => {
      await flush()
    })
  } finally {
    console.error = prevError
  }

  t.truthy($('.boundary'))
  t.is($('.boundary')!.innerHTML, 'boom')
  t.falsy($('.issue-detail'))

  unmount()
})

test('suspense: refetch failure keeps previous data, exposes error, clears on recovery', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird, feathers } = createApp()

  let refetchFn: (() => void) | null = null

  function IssueDetail() {
    const { data, error, refetch } = useQuery(
      figbird.q.issues.where({ id: 1 }).one().related('creator'),
    )
    refetchFn = refetch
    const issue = data as Issue & { creator: User | null }
    return (
      <div className='issue-detail' data-error={error ? error.message : ''}>
        <div className='title'>{issue.title}</div>
      </div>
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='fallback'>Loading...</div>}>
        <IssueDetail />
      </React.Suspense>
    </App>,
  )
  await flush()

  t.is($('.title')!.innerHTML, 'First issue')
  t.is($('.issue-detail')!.getAttribute('data-error'), '')

  // Break the service, then refetch. The screen must stay mounted with the last good
  // data (no fallback, no ErrorBoundary) and surface the failure via `error`.
  const originalFind = feathers.service('issues').find
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  feathers.service('issues').find = async () => {
    throw new Error('network down')
  }

  await flush(() => {
    refetchFn!()
  })

  t.falsy($('.fallback'))
  t.is($('.title')!.innerHTML, 'First issue')
  t.is($('.issue-detail')!.getAttribute('data-error'), 'network down')

  // Heal the service and refetch again — the error clears on the next successful fetch.
  feathers.service('issues').find = originalFind
  await flush(() => {
    refetchFn!()
  })

  t.is($('.title')!.innerHTML, 'First issue')
  t.is($('.issue-detail')!.getAttribute('data-error'), '')

  unmount()
})

test('suspense: root item removed while on screen keeps data and surfaces ItemRemoved', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird, feathers } = createApp()

  function IssueDetail() {
    const { data, error } = useQuery(figbird.q.issues.get(1).related('creator'))
    const issue = data as Issue & { creator: User | null }
    return (
      <div className='issue-detail' data-error={error ? error.name : ''}>
        <div className='title'>{issue.title}</div>
      </div>
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='fallback'>Loading...</div>}>
        <IssueDetail />
      </React.Suspense>
    </App>,
  )
  await flush()

  t.is($('.title')!.innerHTML, 'First issue')
  t.is($('.issue-detail')!.getAttribute('data-error'), '')

  // Remove the entity behind the get root. The screen keeps the stale item — the
  // consumer decides what "deleted while viewing" looks like via error.name.
  await feathers.service('issues').remove(1)
  await flush()

  t.falsy($('.fallback'))
  t.is($('.title')!.innerHTML, 'First issue')
  t.is($('.issue-detail')!.getAttribute('data-error'), 'ItemRemoved')

  unmount()
})

test('suspense: revisiting a query with warm nested relations does not re-suspend', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird } = createApp()

  function IssueWithCommentReactions({ issueId }: { issueId: number }) {
    const { data } = useQuery(
      figbird.q.issues
        .where({ id: issueId })
        .one()
        .related('comments', c => c.related('reactions')),
    )
    if (!data) return <div className='empty'>none</div>
    return <div className='view' data-id={data.id} data-comments={data.comments.length} />
  }

  // Mount with issue 1 — fetches root + comments + reactions, all get cached in QueryStore
  function Shell({ id }: { id: number }) {
    return (
      <React.Suspense fallback={<div className='fallback'>Loading…</div>}>
        <IssueWithCommentReactions issueId={id} />
      </React.Suspense>
    )
  }

  render(
    <App>
      <Shell id={1} />
    </App>,
  )
  await flush()
  t.truthy($('.view'))

  // Unmount — RelationalQueryRef is evicted from figbird's cache (listeners → 0), but
  // the underlying per-query data stays in QueryStore.
  unmount()

  // Mount again with the SAME issue. The fresh RelationalQueryRef has no private state,
  // so it must seed itself from the warm QueryStore cache — including nested relations —
  // synchronously. If it doesn't, areExpectedRelationsSynced reports false for
  // comments.reactions and we'd flash the Suspense fallback.
  const remount = dom()
  remount.render(
    <App>
      <Shell id={1} />
    </App>,
  )

  // Crucially: no fallback should be visible at this point, even before flush. The warm
  // cache should let the Suspense boundary render synchronously.
  t.falsy(remount.$('.fallback'), 'fallback must not appear on warm-cache remount')
  t.truthy(remount.$('.view'))

  remount.unmount()
})

test('empty top-level relation does not hang loading', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird, feathers } = createApp()

  // Force the issues service to return no rows — this exercises the empty-source-values
  // path on the comments relation. Before the fix, the relation query would never be
  // created (because there's nothing to fetch), yet the snapshot's loading check
  // compared relationQueryRefs.size to ast.related size and hung loading forever.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  feathers.service('issues').find = async () => ({ total: 0, limit: 100, skip: 0, data: [] }) as any

  function IssueList() {
    const issues = useStatusQuery(figbird.q.issues.related('comments'))
    if (issues.status === 'loading') return <div className='loading'>Loading...</div>
    if (issues.status === 'error') return <div className='error'>{issues.error.message}</div>
    const data = issues.data as unknown as Issue[]
    return <div className='list' data-count={data.length} />
  }

  render(
    <App>
      <IssueList />
    </App>,
  )
  await flush()

  t.truthy($('.list'))
  t.is($('.list')!.getAttribute('data-count'), '0')

  unmount()
})

test('useQuery: refined relations assemble from the relation query result, not the service cache', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird } = createExactQueryApp()

  function CachePolluter() {
    useFind('departments')
    useFind('people')
    useFind('employments')
    return null
  }

  function CompanyView() {
    const { data } = useQuery(
      figbird.q.companies
        .where({ id: 1 })
        .one()
        .related('departments', d => d.where({ archived: false }))
        .related('people', p =>
          p
            .where({ status: 'active' })
            .related('currentEmployment', e => e.where({ effectiveAt: '2025-04-23' })),
        ),
    )

    if (!data) return <div className='empty'>none</div>

    return (
      <div
        className='company'
        data-departments={data.departments.map(d => d.name).join(',')}
        data-people={data.people.map(p => p.name).join(',')}
        data-employment={data.people[0]?.currentEmployment?.title ?? 'none'}
      />
    )
  }

  render(
    <App>
      <CachePolluter />
      <React.Suspense fallback={<div className='loading'>Loading...</div>}>
        <CompanyView />
      </React.Suspense>
    </App>,
  )

  await flush()

  t.truthy($('.company'))
  t.is($('.company')!.getAttribute('data-departments'), 'Engineering')
  t.is($('.company')!.getAttribute('data-people'), 'Alice')
  t.is($('.company')!.getAttribute('data-employment'), 'Current role')

  unmount()
})

test('useQuery: profile graph fetches manager and windowed direct reports on demand', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird } = createProfileQueryApp()

  function ProfileView() {
    const { data } = useQuery(
      figbird.q.people
        .where({ id: 1 })
        .one()
        .related('manager')
        .related('currentEmployment', e => e.where({ effectiveAt: '2025-04-24' }))
        .related('directReports', r =>
          r
            .where({ status: 'active' })
            .orderBy('startDate', 'desc')
            .orderBy('id', 'asc')
            .limit(2)
            .related('currentEmployment', e => e.where({ effectiveAt: '2025-04-24' })),
        ),
    )

    if (!data) return <div className='empty'>none</div>

    return (
      <div
        className='profile'
        data-name={data.name}
        data-role={data.currentEmployment?.title ?? 'none'}
        data-manager={data.manager?.name ?? 'none'}
        data-reports={data.directReports.map(p => p.name).join(',')}
        data-report-roles={data.directReports
          .map(p => p.currentEmployment?.title ?? 'none')
          .join(',')}
      />
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='loading'>Loading...</div>}>
        <ProfileView />
      </React.Suspense>
    </App>,
  )

  await flush()

  t.truthy($('.profile'))
  t.is($('.profile')!.getAttribute('data-name'), 'Alice')
  t.is($('.profile')!.getAttribute('data-role'), 'Head of Product')
  t.is($('.profile')!.getAttribute('data-manager'), 'Mira')
  t.is($('.profile')!.getAttribute('data-reports'), 'Bob,Cara')
  t.is($('.profile')!.getAttribute('data-report-roles'), 'Engineer,Designer')

  unmount()
})

test('useQuery: server refetches a server-authoritative query from its service event', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird, feathers } = createServerProjectionQueryApp()
  const periodsService = feathers.service('timeAwayPeriods')

  function PeriodView() {
    const { data, isFetching } = useQuery(
      figbird.q.timeAwayPeriods.where({ personId: 1 }).one().server(),
    )

    if (!data) return <div className='empty'>none</div>

    return (
      <div
        className='period'
        data-balance={String(data.balance)}
        data-fetching={String(isFetching)}
      />
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='loading'>Loading...</div>}>
        <PeriodView />
      </React.Suspense>
    </App>,
  )

  await flush()

  t.truthy($('.period'))
  t.is($('.period')!.getAttribute('data-balance'), '10')
  const initialFindCount = periodsService.counts.find

  await periodsService.patch(1, { balance: 12 })
  await flush()

  t.is($('.period')!.getAttribute('data-fetching'), 'false')
  t.is($('.period')!.getAttribute('data-balance'), '12')
  t.is(periodsService.counts.find, initialFindCount + 1)

  unmount()
})

test('useQuery: foreign-key changes fetch the new relation leaf', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird, feathers } = createProfileQueryApp()

  function ProfileView() {
    const { data } = useQuery(figbird.q.people.where({ id: 1 }).one().related('manager'))

    if (!data) return <div className='empty'>none</div>

    return (
      <div
        className='profile'
        data-manager={data.manager?.name ?? 'none'}
        data-manager-id={String(data.manager?.id ?? 'none')}
      />
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='loading'>Loading...</div>}>
        <ProfileView />
      </React.Suspense>
    </App>,
  )

  await flush()

  t.is($('.profile')!.getAttribute('data-manager'), 'Mira')
  t.is($('.profile')!.getAttribute('data-manager-id'), '10')

  await feathers.service('people').patch(1, { managerId: 11 })
  await flush()

  t.is($('.profile')!.getAttribute('data-manager'), 'Nia')
  t.is($('.profile')!.getAttribute('data-manager-id'), '11')

  unmount()
})

test('useQuery: fixed-depth manager chains resolve through nested relations', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird } = createProfileQueryApp()

  function ManagerChainView() {
    const { data } = useQuery(
      figbird.q.people
        .where({ id: 1 })
        .one()
        .related('manager', manager => manager.related('manager')),
    )

    if (!data) return <div className='empty'>none</div>

    return (
      <div
        className='chain'
        data-manager={data.manager?.name ?? 'none'}
        data-skip-manager={data.manager?.manager?.name ?? 'none'}
      />
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='loading'>Loading...</div>}>
        <ManagerChainView />
      </React.Suspense>
    </App>,
  )

  await flush()

  t.is($('.chain')!.getAttribute('data-manager'), 'Mira')
  t.is($('.chain')!.getAttribute('data-skip-manager'), 'Nia')

  unmount()
})

test('useQuery: many-to-many through a join service expands nested relation leaves', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird, feathers } = createMembershipQueryApp()

  function PersonTeamsView() {
    const { data } = useQuery(
      figbird.q.people
        .where({ id: 1 })
        .one()
        .related('memberships', membership => membership.related('team')),
    )

    if (!data) return <div className='empty'>none</div>

    return (
      <div
        className='teams'
        data-teams={data.memberships.map(membership => membership.team?.name ?? 'none').join(',')}
      />
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='loading'>Loading...</div>}>
        <PersonTeamsView />
      </React.Suspense>
    </App>,
  )

  await flush()

  t.is($('.teams')!.getAttribute('data-teams'), 'Engineering')

  await feathers.service('memberships').create({ id: 2, personId: 1, teamId: 2 })
  await flush()

  t.is($('.teams')!.getAttribute('data-teams'), 'Engineering,Operations')

  unmount()
})

test('useQuery: limited sorted relation refetches its server window after a visible item leaves', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird, feathers } = createWindowQueryApp()

  function CompanyView() {
    const { data, isFetching } = useQuery(
      figbird.q.companies
        .where({ id: 1 })
        .one()
        .related('people', p =>
          p
            .where({ status: 'active' })
            .orderBy('startDate', 'desc')
            .orderBy('id', 'asc')
            .limit(2)
            .related('currentEmployment', e => e.where({ effectiveAt: '2025-04-23' })),
        ),
    )

    if (!data) return <div className='empty'>none</div>

    return (
      <div
        className='company'
        data-fetching={String(isFetching)}
        data-people={data.people.map(p => p.name).join(',')}
        data-employment={data.people.map(p => p.currentEmployment?.title ?? 'none').join(',')}
      />
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='loading'>Loading...</div>}>
        <CompanyView />
      </React.Suspense>
    </App>,
  )

  await flush()

  t.truthy($('.company'))
  t.is($('.company')!.getAttribute('data-people'), 'Alice,Bob')
  t.is($('.company')!.getAttribute('data-employment'), 'Alice role,Bob role')

  await feathers.service('people').patch(2, { status: 'inactive' })
  await flush()

  t.is($('.company')!.getAttribute('data-fetching'), 'false')
  t.is($('.company')!.getAttribute('data-people'), 'Alice,Cara')
  t.is($('.company')!.getAttribute('data-employment'), 'Alice role,Cara role')

  unmount()
})

test('useQuery: limited sorted many relation applies the window per parent', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird } = createWindowQueryApp()

  function CompaniesView() {
    const { data } = useQuery(
      figbird.q.companies.orderBy('id', 'asc').related('people', p =>
        p
          .where({ status: 'active' })
          .orderBy('startDate', 'desc')
          .orderBy('id', 'asc')
          .limit(2)
          .related('currentEmployment', e => e.where({ effectiveAt: '2025-04-23' })),
      ),
    )

    return (
      <div
        className='companies'
        data-people={data
          .map(company => `${company.name}:${company.people.map(p => p.name).join(',')}`)
          .join('|')}
        data-employment={data
          .map(
            company =>
              `${company.name}:${company.people.map(p => p.currentEmployment?.title ?? 'none').join(',')}`,
          )
          .join('|')}
      />
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='loading'>Loading...</div>}>
        <CompaniesView />
      </React.Suspense>
    </App>,
  )

  await flush()

  t.truthy($('.companies'))
  t.is($('.companies')!.getAttribute('data-people'), 'Acme:Alice,Bob|Globex:Eve,Finn')
  t.is(
    $('.companies')!.getAttribute('data-employment'),
    'Acme:Alice role,Bob role|Globex:Eve role,Finn role',
  )

  unmount()
})

test('useQuery: limited sorted relation refetches when an out-of-window item enters', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird, feathers } = createProfileQueryApp()

  function ProfileView() {
    const { data, isFetching } = useQuery(
      figbird.q.people
        .where({ id: 1 })
        .one()
        .related('directReports', r =>
          r.where({ status: 'active' }).orderBy('startDate', 'desc').orderBy('id', 'asc').limit(2),
        ),
    )

    if (!data) return <div className='empty'>none</div>

    return (
      <div
        className='profile'
        data-fetching={String(isFetching)}
        data-reports={data.directReports.map(p => p.name).join(',')}
      />
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='loading'>Loading...</div>}>
        <ProfileView />
      </React.Suspense>
    </App>,
  )

  await flush()

  t.truthy($('.profile'))
  t.is($('.profile')!.getAttribute('data-reports'), 'Bob,Cara')

  await feathers.service('people').create({
    id: 5,
    name: 'Dana',
    status: 'active',
    managerId: 1,
    startDate: '2025-03-01',
  })
  await flush()

  t.is($('.profile')!.getAttribute('data-fetching'), 'false')
  t.is($('.profile')!.getAttribute('data-reports'), 'Dana,Bob')

  unmount()
})

// ============================================================================
// defineQuery + prepare
// ============================================================================

test('defineQuery + prepare: prepare and useQuery share the same cache entry', async t => {
  const { App, figbird, feathers } = createApp()
  const { render, unmount, flush, $ } = dom()

  const issueDetail = defineQuery('issueDetail', passthrough<{ id: number }>(), ({ id }) =>
    figbird.q.issues.where({ id }).one().related('comments'),
  )

  // Prepare the query before any component reads it.
  const prepared = figbird.prepare(issueDetail, { id: 1 })
  t.truthy(prepared.key)

  await prepared.promise

  // The find call already fired during preparation. Trace it.
  const beforeRender = feathers.service('issues').counts.find

  function IssueView() {
    const { data } = useQuery(issueDetail, { id: 1 })
    return (
      <div className='issue'>
        <span className='title'>{data?.title}</span>
        <span className='comments'>{data?.comments.length}</span>
      </div>
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='fallback'>Loading...</div>}>
        <IssueView />
      </React.Suspense>
    </App>,
  )
  await flush()

  // Hook should mount synchronously without re-fetching the issue — the cache is warm.
  t.falsy($('.fallback'), 'warm cache must not suspend')
  t.is($('.title')!.innerHTML, 'First issue')
  t.is($('.comments')!.innerHTML, '2')

  // No additional `find` should have been triggered for the issue itself.
  t.is(feathers.service('issues').counts.find, beforeRender)

  prepared.release()
  unmount()
})

test('defineQuery + prepare: prepare key is stable for identical args', t => {
  const { figbird } = createApp()

  const issueDetail = defineQuery('issueDetail', passthrough<{ id: number }>(), ({ id }) =>
    figbird.q.issues.where({ id }).one(),
  )

  const a = figbird.prepare(issueDetail, { id: 1 })
  const b = figbird.prepare(issueDetail, { id: 1 })
  const c = figbird.prepare(issueDetail, { id: 2 })

  t.is(a.key, b.key, 'identical args must share a cache key')
  t.not(a.key, c.key, 'different args must produce different cache keys')

  a.release()
  b.release()
  c.release()
})

test('explain: classifies nodes with structured reasons', t => {
  const { figbird } = createApp()

  const report = figbird.explain(
    figbird.q.issues
      .where({ title: { $regex: 'foo' } })
      .orderBy('id', 'desc')
      .limit(30)
      .related('comments')
      .related('creator'),
  )

  const root = report.nodes.find(n => n.path === '(root)')!
  t.is(root.class, 'server-authoritative')
  t.is(root.realtime, 'refetch')
  t.true(root.reasons.some(r => r.code === 'server-only-operator' && r.detail === '$regex'))
  t.true(root.reasons.some(r => r.code === 'window-filter' && r.detail === '$limit'))

  // Unwindowed relations stay local-exact — realtime events merge locally.
  const comments = report.nodes.find(n => n.path === 'comments')!
  t.is(comments.service, 'comments')
  t.is(comments.class, 'local-exact')
  t.is(comments.realtime, 'merge')

  // A paginated root is a window even without explicit $limit in the builder query.
  const paginated = figbird.explain(figbird.q.issues.paginate({ pageSize: 10 }))
  t.is(paginated.nodes[0]!.class, 'server-window')
})

test('inspect: stable read-only projection of live queries', async t => {
  const { figbird } = createApp()

  const ref = figbird.relationalQuery(figbird.q.issues.related('comments'))
  const unsub = ref.subscribe(() => {})
  await new Promise(resolve => setTimeout(resolve, 10))

  const rows = figbird.inspect()
  const issuesRow = rows.find(r => r.serviceName === 'issues')!
  t.is(issuesRow.method, 'find')
  t.is(issuesRow.classification, 'local-exact')
  t.is(issuesRow.status, 'success')
  t.is(issuesRow.itemCount, 3)
  t.true(typeof issuesRow.fetchedAt === 'number')
  t.true(issuesRow.subscriberCount > 0)

  unsub()
})

test('createHooks: bound hooks and q work without a FigbirdProvider', async t => {
  const { render, unmount, flush, $ } = dom()
  const { figbird } = createApp()
  const { useQuery: useBoundQuery, q } = createHooks(figbird)

  function IssueList() {
    const { data } = useBoundQuery(q.issues.related('creator'))
    return <div className='count'>{data.length}</div>
  }

  // No FigbirdProvider anywhere in the tree — hooks resolve the bound instance.
  render(
    <StrictMode>
      <React.Suspense fallback={<div className='fallback'>Loading…</div>}>
        <IssueList />
      </React.Suspense>
    </StrictMode>,
  )
  await flush()

  t.is($('.count')!.innerHTML, '3')

  unmount()
})

test('.all(): materializes the service; subset and windowed reads answer locally', async t => {
  const { figbird, feathers } = createApp()

  // Preload the complete set.
  const unsubAll = figbird.relationalQuery(figbird.q.issues.all()).subscribe(() => {})
  await new Promise(resolve => setTimeout(resolve, 10))
  const findsAfterAll = feathers.service('issues').counts.find
  t.true(findsAfterAll >= 1)

  // Filtered subset — answered from the materialized cache, no fetch.
  const openRef = figbird.relationalQuery(figbird.q.issues.where({ status: 'open' }))
  const unsubOpen = openRef.subscribe(() => {})
  await new Promise(resolve => setTimeout(resolve, 10))
  t.is(openRef.getSnapshot().status, 'success')
  t.is((openRef.getSnapshot().data as Issue[]).length, 2)
  t.is(feathers.service('issues').counts.find, findsAfterAll, 'subset read must not fetch')

  // Windowed subset — sorted and sliced locally.
  const winRef = figbird.relationalQuery(figbird.q.issues.orderBy('id', 'desc').limit(2))
  const unsubWin = winRef.subscribe(() => {})
  await new Promise(resolve => setTimeout(resolve, 10))
  t.deepEqual(
    (winRef.getSnapshot().data as Issue[]).map(issue => issue.id),
    [3, 2],
  )
  t.is(feathers.service('issues').counts.find, findsAfterAll, 'window computed locally')

  // Realtime maintains the set; the windowed subset recomputes locally — still no fetch.
  await feathers.service('issues').create({ id: 9, title: 'Newest', status: 'open', creatorId: 1 })
  await new Promise(resolve => setTimeout(resolve, 20))
  t.deepEqual(
    (winRef.getSnapshot().data as Issue[]).map(issue => issue.id),
    [9, 3],
  )
  t.is(feathers.service('issues').counts.find, findsAfterAll, 'realtime maintenance stays local')

  unsubOpen()
  unsubWin()
  unsubAll()
})

test('.all(): rejects filters, produces an all-kind AST', t => {
  const { figbird } = createApp()
  t.throws(() => figbird.q.issues.where({ status: 'open' }).all(), { message: /all\(\)/ })
  const ast = figbird.q.issues.all().toAST()
  t.is(ast.kind, 'all')
  t.is(ast.cardinality, 'many')
})

test('snapshot: frozen queries ignore realtime; refetch still works; explain says manual', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird, feathers } = createApp()

  let refetchFn: (() => void) | null = null

  function FrozenIssues() {
    const { data, refetch } = useQuery(figbird.q.issues.related('comments').snapshot())
    refetchFn = refetch
    return (
      <div className='frozen' data-count={data.length}>
        {data.map(issue => (
          <span key={issue.id} className='row' data-comments={issue.comments.length} />
        ))}
      </div>
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='fallback'>Loading…</div>}>
        <FrozenIssues />
      </React.Suspense>
    </App>,
  )
  await flush()
  t.is($('.frozen')!.getAttribute('data-count'), '3')

  // Realtime events on both services — a frozen tree must not move.
  await feathers.service('issues').create({ id: 99, title: 'New', status: 'open', creatorId: 1 })
  await feathers.service('comments').create({ id: 99, issueId: 1, authorId: 1, body: 'hi' })
  await flush()
  t.is($('.frozen')!.getAttribute('data-count'), '3', 'snapshot must ignore realtime creates')

  // refetch() is the only way it moves.
  await flush(() => refetchFn!())
  t.is($('.frozen')!.getAttribute('data-count'), '4')

  // Identity: frozen and live reads of the same filters do not share a cache entry.
  t.not(
    figbird.relationalQuery(figbird.q.issues.snapshot()).hash(),
    figbird.relationalQuery(figbird.q.issues).hash(),
  )

  // explain() reports the frozen realtime mode.
  const report = figbird.explain(figbird.q.issues.related('comments').snapshot())
  t.true(report.nodes.every(n => n.realtime === 'manual'))
  t.true(report.nodes[0]!.reasons.some(r => r.code === 'snapshot'))

  unmount()
})

test('staleTime: fresh data skips the SWR revalidation on resubscribe', async t => {
  const { figbird, feathers } = createApp()
  const builder = figbird.q.issues.related('creator')

  // Cold read — fetches.
  const unsub1 = figbird.relationalQuery(builder).subscribe(() => {}, { staleTime: 60_000 })
  await new Promise(resolve => setTimeout(resolve, 10))
  t.is(feathers.service('issues').counts.find, 1)
  unsub1()
  await new Promise(resolve => setTimeout(resolve, 10)) // let deferred teardown run

  // Resubscribe within the tolerance — warm store data, no revalidation.
  const ref2 = figbird.relationalQuery(builder)
  const unsub2 = ref2.subscribe(() => {}, { staleTime: 60_000 })
  await new Promise(resolve => setTimeout(resolve, 10))
  t.is(feathers.service('issues').counts.find, 1, 'fresh data must not refetch')
  t.is(ref2.getSnapshot().status, 'success')
  unsub2()
  await new Promise(resolve => setTimeout(resolve, 10))

  // Default tolerance (0) revalidates on resubscribe.
  const unsub3 = figbird.relationalQuery(builder).subscribe(() => {})
  await new Promise(resolve => setTimeout(resolve, 10))
  t.is(feathers.service('issues').counts.find, 2, 'default revalidates on resubscribe')
  unsub3()
})

test('prefetch: idempotent within staleTime and warms the cache for a later read', async t => {
  const { figbird, feathers } = createApp()
  const issueDetail = defineQuery('issueDetailPrefetch', ({ id }: { id: number }) =>
    figbird.q.issues.where({ id }).one().related('creator'),
  )

  // Hover-spam: repeated calls within staleTime must not re-trigger fetches.
  figbird.prefetch(issueDetail, { id: 1 })
  figbird.prefetch(issueDetail, { id: 1 })
  figbird.prefetch(issueDetail, { id: 1 })
  await new Promise(resolve => setTimeout(resolve, 10))

  t.is(feathers.service('issues').counts.find, 1, 'three prefetch calls, one fetch')

  // The data is warm — the interned ref reads success synchronously.
  const ref = figbird.relationalQuery(issueDetail.build({ id: 1 }))
  t.is(ref.getSnapshot().status, 'success')
})

test('useQuery suspense:false returns the tagged union and never suspends', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, figbird } = createApp()

  function IssueView() {
    const issues = useQuery(figbird.q.issues.related('creator'), { suspense: false })
    if (issues.status === 'error') return <div className='error'>{issues.error.message}</div>
    if (issues.status !== 'success') return <div className='loading'>loading</div>
    return <div className='count'>{issues.data.length}</div>
  }

  // No Suspense boundary anywhere — the loading branch renders instead of throwing.
  render(
    <App>
      <IssueView />
    </App>,
  )
  t.truthy($('.loading'))

  await flush()
  t.is($('.count')!.innerHTML, '3')

  unmount()
})

test('defineQuery: typed-args form (no validator, no name) builds and prepares', t => {
  const { figbird } = createApp()

  // No Standard Schema, no name — args are typed from the build function's parameter,
  // and identity is the built AST's hash (the name is optional label metadata).
  const issueDetail = defineQuery(({ id }: { id: number }) => figbird.q.issues.where({ id }).one())
  t.is(issueDetail.name, '')

  const a = figbird.prepare(issueDetail, { id: 1 })
  const b = figbird.prepare(issueDetail, { id: 1 })
  t.is(a.key, b.key, 'same args must map to the same cache key')
  t.false('priority' in a, 'prepare handles carry no router vocabulary')

  a.release()
  b.release()
})

test('defineQuery: zero-arg definition takes options in the args slot', async t => {
  const { App, figbird } = createApp()
  const { render, unmount, flush, $ } = dom()

  const allIssues = defineQuery(() => figbird.q.issues)

  // prepare(def, options) — no middle undefined.
  const prepared = figbird.prepare(allIssues, { staleTime: 60_000 })
  await prepared.promise

  // prefetch(def, options) — same shape.
  figbird.prefetch(allIssues, { staleTime: 60_000 })

  // useQuery(def, options) — options land straight after the definition, both modes.
  function NonSuspense() {
    const result = useQuery(allIssues, { suspense: false })
    return <div className='count'>{result.status === 'success' ? result.data.length : '…'}</div>
  }
  render(
    <App>
      <NonSuspense />
    </App>,
  )
  await flush()
  t.is($('.count')!.innerHTML, '3')

  // The old (undefined, options) spelling is still tolerated at runtime.
  const legacy = (figbird.prepare as (...a: unknown[]) => { key: string; release: () => void })(
    allIssues,
    undefined,
    { staleTime: 60_000 },
  )
  t.is(legacy.key, prepared.key, 'legacy (undefined, options) hits the same cache entry')
  legacy.release()

  prepared.release()
  unmount()
})

// ============================================================================
// embed() — relation through an embedded list-of-ids field
// ============================================================================

interface Role {
  id: number
  name: string
  /** Server-materialised preview: top-N member ids alphabetically. */
  membersPreview: number[]
}

interface RoleService {
  item: Role
}

interface PersonRow {
  id: number
  name: string
}

interface PersonService {
  item: PersonRow
}

const embedSchema = createSchema({
  services: {
    roles: service<RoleService>(),
    people: service<PersonService>(),
  },
  relationships: ({ embed: embedRel }) => ({
    roles: {
      membersPreview: embedRel({
        sourceField: ['membersPreview'],
        destService: 'people',
        destField: ['id'],
      }),
    },
  }),
})

function createEmbedApp() {
  const services = {
    roles: {
      data: {
        1: { id: 1, name: 'Admin', membersPreview: [3, 1, 4] }, // Cara, Alice, Dan
        2: { id: 2, name: 'Editor', membersPreview: [2] }, // Bob
        3: { id: 3, name: 'Viewer', membersPreview: [] }, // empty preview
      },
    },
    people: {
      data: {
        1: { id: 1, name: 'Alice' },
        2: { id: 2, name: 'Bob' },
        3: { id: 3, name: 'Cara' },
        4: { id: 4, name: 'Dan' },
        5: { id: 5, name: 'Erin' },
      },
    },
  }
  return createTestApp(embedSchema, services, { queryAwareFind: true })
}

test('embed: helper returns cardinality "embedded"', t => {
  const rel = embed({
    sourceField: ['membersPreview'],
    destService: 'people',
    destField: ['id'],
  })
  t.is(rel.cardinality, 'embedded')
  t.deepEqual(rel.sourceField, ['membersPreview'])
  t.deepEqual(rel.destField, ['id'])
})

test("embed: useQuery resolves the parent's id-list field, preserving order", async t => {
  const { App, figbird } = createEmbedApp()
  const { render, unmount, flush, $all } = dom()

  function RoleList() {
    const { data } = useQuery(figbird.q.roles.where({}).related('membersPreview'))
    return (
      <ul className='roles'>
        {data.map(role => (
          <li key={role.id} className='role' data-id={role.id} data-name={role.name}>
            <span className='preview'>{role.membersPreview.map(p => p.name).join(',')}</span>
          </li>
        ))}
      </ul>
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='fallback'>Loading...</div>}>
        <RoleList />
      </React.Suspense>
    </App>,
  )
  await flush()

  const roles = $all('.role')
  t.is(roles.length, 3)
  // Order from the parent's membersPreview list is preserved verbatim.
  const previewByRole = new Map(
    roles.map(el => [el.getAttribute('data-name'), el.querySelector('.preview')!.innerHTML]),
  )
  t.is(previewByRole.get('Admin'), 'Cara,Alice,Dan')
  t.is(previewByRole.get('Editor'), 'Bob')
  t.is(previewByRole.get('Viewer'), '')

  unmount()
})

test('embed: realtime — patching a referenced person updates the inline preview', async t => {
  const { App, figbird, feathers } = createEmbedApp()
  const { render, unmount, flush, $ } = dom()

  function AdminRole() {
    const { data } = useQuery(figbird.q.roles.where({ id: 1 }).one().related('membersPreview'))
    return <div className='preview'>{data!.membersPreview.map(p => p.name).join(',')}</div>
  }

  render(
    <App>
      <React.Suspense fallback={<div className='fallback'>Loading...</div>}>
        <AdminRole />
      </React.Suspense>
    </App>,
  )
  await flush()
  t.is($('.preview')!.innerHTML, 'Cara,Alice,Dan')

  await flush(async () => {
    await feathers.service('people').patch(1, { id: 1, name: 'Alicia' })
  })
  // Realtime patch on a person referenced from membersPreview should re-flow into the
  // assembled view because the dest sub's data ref changes.
  t.is($('.preview')!.innerHTML, 'Cara,Alicia,Dan')

  unmount()
})

test("embed: realtime — patching the parent's id-list reorders/changes the preview", async t => {
  const { App, figbird, feathers } = createEmbedApp()
  const { render, unmount, flush, $ } = dom()

  function AdminRole() {
    const { data } = useQuery(figbird.q.roles.where({ id: 1 }).one().related('membersPreview'))
    return <div className='preview'>{data!.membersPreview.map(p => p.name).join(',')}</div>
  }

  render(
    <App>
      <React.Suspense fallback={<div className='fallback'>Loading...</div>}>
        <AdminRole />
      </React.Suspense>
    </App>,
  )
  await flush()
  t.is($('.preview')!.innerHTML, 'Cara,Alice,Dan')

  // The server has recomputed the preview: Erin (5) bumped Dan (4).
  await flush(async () => {
    await feathers.service('roles').patch(1, {
      id: 1,
      name: 'Admin',
      membersPreview: [3, 1, 5],
    })
  })
  t.is($('.preview')!.innerHTML, 'Cara,Alice,Erin')

  unmount()
})

// ============================================================================
// many(parentToJunction, junctionToDest) — true many-to-many via a junction table
// ============================================================================

interface Role2 {
  id: number
  name: string
}
interface Role2Service {
  item: Role2
}

interface RoleMember {
  id: number
  roleId: number
  userId: number
}
interface RoleMemberService {
  item: RoleMember
}

interface User2 {
  id: number
  name: string
}
interface User2Service {
  item: User2
}

const junctionSchema = createSchema({
  services: {
    roles2: service<Role2Service>(),
    roleMembers: service<RoleMemberService>(),
    users2: service<User2Service>(),
  },
  relationships: ({ many: manyRel }) => ({
    roles2: {
      // Two-hop many: roles2 → roleMembers → users2. The consumer of `.related('members')`
      // never sees roleMembers; figbird traverses the junction transparently.
      members: manyRel(
        {
          sourceField: ['id'],
          destService: 'roleMembers',
          destField: ['roleId'],
        },
        { sourceField: ['userId'], destService: 'users2', destField: ['id'] },
      ),
    },
  }),
})

function createJunctionApp() {
  const services = {
    roles2: {
      data: {
        1: { id: 1, name: 'Admin' },
        2: { id: 2, name: 'Editor' },
        3: { id: 3, name: 'Viewer' },
      },
    },
    roleMembers: {
      data: {
        1: { id: 1, roleId: 1, userId: 1 },
        2: { id: 2, roleId: 1, userId: 2 },
        3: { id: 3, roleId: 2, userId: 2 },
        4: { id: 4, roleId: 2, userId: 3 },
        // role 3 has no members
      },
    },
    users2: {
      data: {
        1: { id: 1, name: 'Alice' },
        2: { id: 2, name: 'Bob' },
        3: { id: 3, name: 'Cara' },
        4: { id: 4, name: 'Dan' },
      },
    },
  }
  return createTestApp(junctionSchema, services, { queryAwareFind: true })
}

test('many variadic: helper records via hop and stores the dest hop at the top level', t => {
  const rel = many(
    { sourceField: ['id'], destService: 'roleMembers', destField: ['roleId'] },
    { sourceField: ['userId'], destService: 'users2', destField: ['id'] },
  )
  t.is(rel.cardinality, 'many')
  t.is(rel.destService, 'users2')
  t.deepEqual(rel.sourceField, ['userId']) // junction → dest field name
  t.deepEqual(rel.destField, ['id'])
  t.truthy(rel.via)
  t.is(rel.via!.destService, 'roleMembers')
  t.deepEqual(rel.via!.sourceField, ['id'])
  t.deepEqual(rel.via!.destField, ['roleId'])
})

test('junction: useQuery returns dest items via the junction transparently', async t => {
  const { App, figbird } = createJunctionApp()
  const { render, unmount, flush, $all } = dom()

  function RoleList() {
    const { data } = useQuery(figbird.q.roles2.where({}).related('members'))
    return (
      <ul className='roles'>
        {data.map(role => (
          <li key={role.id} className='role' data-name={role.name}>
            <span className='members'>
              {role.members
                .map(u => u.name)
                .sort()
                .join(',')}
            </span>
          </li>
        ))}
      </ul>
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='fallback'>Loading...</div>}>
        <RoleList />
      </React.Suspense>
    </App>,
  )
  await flush()

  const byRole = new Map(
    $all('.role').map(el => [
      el.getAttribute('data-name'),
      el.querySelector('.members')!.innerHTML,
    ]),
  )
  t.is(byRole.get('Admin'), 'Alice,Bob')
  t.is(byRole.get('Editor'), 'Bob,Cara')
  t.is(byRole.get('Viewer'), '')

  unmount()
})

test('junction: realtime — adding a roleMember row appears under the right role', async t => {
  const { App, figbird, feathers } = createJunctionApp()
  const { render, unmount, flush, $ } = dom()

  function AdminRole() {
    const { data } = useQuery(figbird.q.roles2.where({ id: 1 }).one().related('members'))
    return (
      <div className='members'>
        {data!.members
          .map(u => u.name)
          .sort()
          .join(',')}
      </div>
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='fallback'>Loading...</div>}>
        <AdminRole />
      </React.Suspense>
    </App>,
  )
  await flush()
  t.is($('.members')!.innerHTML, 'Alice,Bob')

  // Add a junction row binding Cara to Admin. Realtime on the junction service should
  // flow through both subs and re-assemble.
  await flush(async () => {
    await feathers.service('roleMembers').create({ id: 5, roleId: 1, userId: 3 })
  })
  t.is($('.members')!.innerHTML, 'Alice,Bob,Cara')

  unmount()
})

test('junction: realtime — patching a destination user updates the assembled view', async t => {
  const { App, figbird, feathers } = createJunctionApp()
  const { render, unmount, flush, $ } = dom()

  function AdminRole() {
    const { data } = useQuery(figbird.q.roles2.where({ id: 1 }).one().related('members'))
    return (
      <div className='members'>
        {data!.members
          .map(u => u.name)
          .sort()
          .join(',')}
      </div>
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div className='fallback'>Loading...</div>}>
        <AdminRole />
      </React.Suspense>
    </App>,
  )
  await flush()
  t.is($('.members')!.innerHTML, 'Alice,Bob')

  await flush(async () => {
    await feathers.service('users2').patch(1, { id: 1, name: 'Alicia' })
  })
  t.is($('.members')!.innerHTML, 'Alicia,Bob')

  unmount()
})

test('junction: empty parent set (.one() no match) resolves with no junction fetch needed', async t => {
  const { App, figbird, feathers } = createJunctionApp()
  const { render, unmount, flush, $ } = dom()

  function NoSuchRole() {
    const { data } = useQuery(figbird.q.roles2.where({ id: 999 }).one().related('members'))
    return <div className='result'>{data === null ? 'no-match' : 'matched'}</div>
  }

  const beforeJunctionFinds = feathers.service('roleMembers').counts.find

  render(
    <App>
      <React.Suspense fallback={<div className='fallback'>Loading...</div>}>
        <NoSuchRole />
      </React.Suspense>
    </App>,
  )
  await flush()
  t.is($('.result')!.innerHTML, 'no-match')
  // No parents → no junction IN(...) query was issued.
  t.is(feathers.service('roleMembers').counts.find, beforeJunctionFinds)

  unmount()
})
