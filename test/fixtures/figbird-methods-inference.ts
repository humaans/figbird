/* oxlint-disable @typescript-eslint/no-unused-vars */
import type { AnyQueryInput, FeathersClient } from '../../lib'
import { FeathersAdapter, Figbird, createSchema, defineQuery, service } from '../../lib'

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

// Router adapters can name the erased public boundary without importing internal
// builder types. Every supported input form forwards directly to Figbird.
export const prepareRouteQuery = (query: AnyQueryInput<typeof schema>) => figbird.prepare(query)

const personDetail = defineQuery(({ id }: { id: string }) => figbird.q['api/people'].get(id))
const allPeople = defineQuery(() => figbird.q['api/people'])

prepareRouteQuery(figbird.q['api/people'])
prepareRouteQuery(personDetail({ id: '1' }))
prepareRouteQuery(allPeople)

export type PreparedRouteQuery = ReturnType<typeof prepareRouteQuery>

// Helper to extract subscribe fn type without leaking the full class type (TS6 TS4094)
function subscribeFn<Fn extends (...args: never[]) => unknown>(q: { subscribe: Fn }): Fn {
  return q.subscribe
}

// QueryRef for find and get to inspect subscribe param typing
const findSubscribe = subscribeFn(figbird.queryDesc({ serviceName: 'api/people', method: 'find' }))
const getSubscribe = subscribeFn(
  figbird.queryDesc({ serviceName: 'api/people', method: 'get', resourceId: '1' }),
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
const createPromise = figbird.mutateDesc(createDesc)
export type CreateResult = Awaited<typeof createPromise>
