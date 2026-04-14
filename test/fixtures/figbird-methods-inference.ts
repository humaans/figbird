/* oxlint-disable @typescript-eslint/no-unused-vars */
import type { FeathersClient } from '../../lib'
import { FeathersAdapter, Figbird, createSchema, service } from '../../lib'

// Define a simple Person model
interface Person {
  id: string
  name: string
}

// Service definition with just the item type to drive schema inference
interface PersonService {
  item: Person
}

// Build schema with a single service
const schema = createSchema({
  services: {
    'api/people': service<PersonService>(),
  },
})

// Figbird instance with Feathers adapter (meta inferred as FeathersFindMeta)
const feathers = {} as FeathersClient
const adapter = new FeathersAdapter(feathers)
const figbird = new Figbird({ schema, adapter })

// Helper to extract subscribe fn type without leaking the full class type (TS6 TS4094)
function subscribeFn<Fn extends (...args: never[]) => unknown>(q: { subscribe: Fn }): Fn {
  return q.subscribe
}

// QueryRef for find and get to inspect subscribe param typing
const findSubscribe = subscribeFn(figbird.query({ serviceName: 'api/people', method: 'find' }))
const getSubscribe = subscribeFn(
  figbird.query({ serviceName: 'api/people', method: 'get', resourceId: '1' }),
)

// Export the state type expected by the subscribe callback for both query kinds
export type FindSubscribeState = Parameters<Parameters<typeof findSubscribe>[0]>[0]
export type GetSubscribeState = Parameters<Parameters<typeof getSubscribe>[0]>[0]

// Mutate: create — return type should be Person based on schema
const createDesc = {
  serviceName: 'api/people',
  method: 'create',
  data: {} as Partial<Person>,
} as const
const createPromise = figbird.mutate(createDesc)
export type CreateResult = Awaited<typeof createPromise>
