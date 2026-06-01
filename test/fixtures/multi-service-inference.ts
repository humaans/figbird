import type { FeathersClient } from '../../lib'
import {
  createHooks,
  defineSchema,
  FeathersAdapter,
  Figbird,
  type ServiceByName,
  type ServiceItem,
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

interface AppSchemaTypes {
  'api/people': PersonService
  'api/tasks': TaskService
}

export const schema = defineSchema<AppSchemaTypes>()

type AppSchema = typeof schema

// Create Figbird instance
const feathers = {} as FeathersClient
const adapter = new FeathersAdapter(feathers)
const figbird = new Figbird({ schema, adapter })

// Create hooks with figbird instance
const { useFind } = createHooks(figbird)

// Debug types - these will be inspected by the test
export type PersonServiceByName = ServiceByName<AppSchema, 'api/people'>
export type TaskServiceByName = ServiceByName<AppSchema, 'api/tasks'>
export type PersonServiceItem = ServiceItem<AppSchema, 'api/people'>
export type TaskServiceItem = ServiceItem<AppSchema, 'api/tasks'>

// Test the actual hooks - these types will be checked by the test
export const people = useFind('api/people')
export const tasks = useFind('api/tasks')
