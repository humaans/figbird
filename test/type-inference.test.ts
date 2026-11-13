import test from 'ava'
import { dirname, join } from 'path'
import { getTypeAtPosition } from './type-helpers'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

test('type narrowing works correctly with multiple services', t => {
  const fixturePath = join(__dirname, 'fixtures', 'multi-service-inference.ts')

  // Check Person service types
  const personServiceType = getTypeAtPosition(fixturePath, 'PersonServiceByName')
  const personItemType = getTypeAtPosition(fixturePath, 'PersonServiceItem')
  const personItemByNameType = getTypeAtPosition(fixturePath, 'PersonServiceItemByName')
  const peopleType = getTypeAtPosition(fixturePath, 'people')

  // Check Task service types
  const taskServiceType = getTypeAtPosition(fixturePath, 'TaskServiceByName')
  const taskItemType = getTypeAtPosition(fixturePath, 'TaskServiceItem')
  const tasksType = getTypeAtPosition(fixturePath, 'tasks')

  // Service<TDef, TName, TPath>: both schema name and transport path stay literal.
  t.true(
    personServiceType.startsWith('import("figbird").Service<{ item: Person;') &&
      personServiceType.includes('"people", "api/people"'),
    `Expected personServiceType to retain name "people" and path "api/people", got: ${personServiceType}`,
  )
  t.true(
    taskServiceType.startsWith('import("figbird").Service<{ item: Task;') &&
      taskServiceType.includes('"tasks", "api/tasks"'),
    `Expected taskServiceType to retain name "tasks" and path "api/tasks", got: ${taskServiceType}`,
  )

  // Names and paths remain separate projections with explicit utility types.
  t.is(personItemType, 'Person')
  t.is(personItemByNameType, 'Person')
  t.is(taskItemType, 'Task')

  // Test that useFind correctly narrows to specific types (no more unions!)
  t.is(peopleType, 'import("figbird").QueryResult<Person[], import("figbird").FeathersFindMeta>')
  t.is(tasksType, 'import("figbird").QueryResult<Task[], import("figbird").FeathersFindMeta>')

  // Verify type narrowing - ensure services don't cross-contaminate
  t.not(peopleType, tasksType, 'People and tasks should have different types')
  t.not(personItemType, taskItemType, 'Person and Task item types should be distinct')
})

test('legacy hooks accept an explicit adapter type for params and metadata', t => {
  const fixturePath = join(__dirname, 'fixtures', 'inferred-meta-from-figbird.ts')

  // Check that data types are correct
  const tasksDataType = getTypeAtPosition(fixturePath, 'TasksData')
  const projectDataType = getTypeAtPosition(fixturePath, 'ProjectData')

  // Check that meta types are preserved as FeathersFindMeta
  const tasksMetaType = getTypeAtPosition(fixturePath, 'TasksMeta')
  // get no longer exposes meta by default

  // Check individual meta properties
  const tasksMetaTotalType = getTypeAtPosition(fixturePath, 'TasksMetaTotal')
  const tasksMetaLimitType = getTypeAtPosition(fixturePath, 'TasksMetaLimit')
  const tasksMetaSkipType = getTypeAtPosition(fixturePath, 'TasksMetaSkip')

  // Check backward compatibility
  const backwardCompatMetaType = getTypeAtPosition(fixturePath, 'BackwardCompatMeta')

  // Verify data types
  t.is(tasksDataType, 'Task[] | null')
  t.is(projectDataType, 'Project | null')

  // Verify that the adapter generic carries FeathersFindMeta into useFind.
  t.is(tasksMetaType, 'import("figbird").FeathersFindMeta')

  // Verify individual meta properties are typed correctly
  t.is(tasksMetaTotalType, 'number')
  t.is(tasksMetaLimitType, 'number')
  t.is(tasksMetaSkipType, 'number')

  // The adapter's default metadata type is FeathersFindMeta too.
  t.is(backwardCompatMetaType, 'import("figbird").FeathersFindMeta')
})

test('combined params includes both QueryConfig and FeathersParams', t => {
  const fixturePath = join(__dirname, 'fixtures', 'params-type-inference.ts')

  // Check that combined params type includes both Figbird and adapter params
  const combinedParamsType = getTypeAtPosition(fixturePath, 'testCombinedParams')

  // Should include FeathersParams properties
  t.true(
    combinedParamsType.includes('query') || combinedParamsType.includes('FeathersParams'),
    `Expected combined params to include FeathersParams properties, got: ${combinedParamsType}`,
  )

  // Check that specific QueryConfig properties are present in the type
  const hasQueryConfig =
    combinedParamsType.includes('skip') ||
    combinedParamsType.includes('realtime') ||
    combinedParamsType.includes('fetchPolicy') ||
    combinedParamsType.includes('QueryConfig')

  t.true(
    hasQueryConfig,
    `Expected combined params to include QueryConfig properties, got: ${combinedParamsType}`,
  )

  // Verify complex query accepts all combined param types
  const complexQueryType = getTypeAtPosition(fixturePath, 'complexQuery')
  t.true(
    complexQueryType.includes('QueryResult'),
    `Expected complexQuery to return QueryResult, got: ${complexQueryType}`,
  )
})

test('Figbird methods infer types from schema (query, subscribe, mutate)', t => {
  const fixturePath = join(__dirname, 'fixtures', 'figbird-methods-inference.ts')

  const findSubscribeStateType = getTypeAtPosition(fixturePath, 'FindSubscribeState')
  const getSubscribeStateType = getTypeAtPosition(fixturePath, 'GetSubscribeState')
  const createResultType = getTypeAtPosition(fixturePath, 'CreateResult')
  const preparedRouteQueryType = getTypeAtPosition(fixturePath, 'PreparedRouteQuery')

  // Query subscribe param should carry QueryState with inferred data + Feathers meta
  t.is(
    findSubscribeStateType,
    'import("figbird").QueryState<Person[], import("figbird").FeathersFindMeta>',
  )
  t.is(
    getSubscribeStateType,
    'import("figbird").QueryState<Person, import("figbird").FeathersFindMeta>',
  )

  // Mutate create should resolve to Person
  t.is(createResultType, 'Person')
  t.is(preparedRouteQueryType, 'import("figbird").PreparedQuery')
})

test('optional query definitions are inferred', t => {
  const fixturePath = join(__dirname, 'fixtures', 'optional-query-inference.ts')

  const taskQueryType = getTypeAtPosition(fixturePath, 'TaskQueryType')

  t.is(taskQueryType, 'TaskQuery')
})
