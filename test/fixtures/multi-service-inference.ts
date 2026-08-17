import type { FeathersClient } from '../../lib'
import {
  createHooks,
  createSchema,
  FeathersAdapter,
  service,
  type ServiceByIdentifier,
  type ServiceItem,
  type ServiceNames,
  type ServicePaths,
} from '../../lib'

// Test multi-service schema type inference with distinct types
interface Person {
  id: string
  name: string
  email: string
  role: 'admin' | 'user'
}

interface Task {
  id: string
  title: string
  completed: boolean
  priority: number
  tags: string[]
}

interface PersonService {
  item: Person
}

interface TaskService {
  item: Task
}

export const schema = createSchema({
  services: {
    people: service<PersonService, 'api/people'>({ path: 'api/people' }),
    tasks: service<TaskService, 'api/tasks'>({ path: 'api/tasks' }),
  },
})

type AppSchema = typeof schema

type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false
type Assert<T extends true> = T

const feathers = {} as FeathersClient
const adapter = new FeathersAdapter(feathers)

const { q, useFeathers, useFind, useGet, useMutation, useMutations } = createHooks<
  typeof schema,
  typeof adapter
>(schema)

export const peopleQuery = q.people.all()
export const person = useGet('api/people', 'person-id')
export const peopleMutation = useMutation('api/people')
export const namedMutations = useMutations().people
export const peopleFeathersService = useFeathers().service('api/people')

// @ts-expect-error Builder APIs use schema names, not transport paths.
q['api/people'].all()
// @ts-expect-error Legacy descriptor hooks use transport paths, not schema names.
useFind('people')
// @ts-expect-error Legacy mutation hooks use transport paths, not schema names.
useMutation('people')
// @ts-expect-error The current mutation proxy uses schema names, not transport paths.
void useMutations()['api/people']
// @ts-expect-error Direct Feathers access uses transport paths, not schema names.
useFeathers().service('people')

// Debug types - these will be inspected by the test
export type SchemaServiceNames = ServiceNames<AppSchema>
export type SchemaServicePaths = ServicePaths<AppSchema>
export type ServiceNamesArePreserved = Assert<Equal<SchemaServiceNames, 'people' | 'tasks'>>
export type ServicePathsArePreserved = Assert<Equal<SchemaServicePaths, 'api/people' | 'api/tasks'>>
export type ServiceLookupByName = Assert<
  Equal<ServiceByIdentifier<AppSchema, 'people'>, AppSchema['services']['people']>
>
export type ServiceLookupByPath = Assert<
  Equal<ServiceByIdentifier<AppSchema, 'api/people'>, AppSchema['services']['people']>
>
export type PersonServiceByName = AppSchema['services']['people']
export type TaskServiceByName = AppSchema['services']['tasks']
export type PersonServiceItemByName = ServiceItem<AppSchema, 'people'>
export type PersonServiceItem = ServiceItem<AppSchema, 'api/people'>
export type TaskServiceItem = ServiceItem<AppSchema, 'api/tasks'>

// Test the actual hooks - these types will be checked by the test
export const people = useFind('api/people')
export const tasks = useFind('api/tasks')
