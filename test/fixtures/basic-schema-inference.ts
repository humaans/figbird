import { createHooks, createSchema, service, type ServiceItem } from '../../lib'

// Test basic schema type inference with a simple Person interface
interface Person {
  id: string
  name: string
  email: string
  [key: string]: unknown
}

export const schema = createSchema({
  services: [service<Person, 'api/people'>('api/people')],
})

type AppSchema = typeof schema
const { useFind } = createHooks<AppSchema>()

// Debug types - these will be inspected by the test
export type DebugServiceByName = AppSchema['services']['api/people']
export type DebugServiceItem = ServiceItem<AppSchema, 'api/people'>

// Test the actual hook - this type will be checked by the test
export const people = useFind('api/people')
