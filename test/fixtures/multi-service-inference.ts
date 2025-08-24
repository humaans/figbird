import { createHooks, createSchema, service, type ServiceItem } from '../../lib'

// Test multi-service schema type inference with distinct types
interface Person {
  id: string
  name: string
  email: string
  role: 'admin' | 'user'
  [key: string]: unknown
}

interface Task {
  id: string
  title: string
  completed: boolean
  priority: number
  tags: string[]
  [key: string]: unknown
}

// Create services using the service function
const personService = service<Person, 'api/people'>('api/people')
const taskService = service<Task, 'api/tasks'>('api/tasks')

export const schema = createSchema({
  services: [personService, taskService] as const,
})

type AppSchema = typeof schema
const { useFind } = createHooks<AppSchema>()

// Debug individual services
export type DebugPersonService = typeof personService
export type DebugTaskService = typeof taskService

// Debug types - these will be inspected by the test
export type PersonServiceByName = AppSchema['services']['api/people']
export type TaskServiceByName = AppSchema['services']['api/tasks']
export type PersonServiceItem = ServiceItem<AppSchema, 'api/people'>
export type TaskServiceItem = ServiceItem<AppSchema, 'api/tasks'>

// Test the actual hooks - these types will be checked by the test
export const people = useFind('api/people')
export const tasks = useFind('api/tasks')
