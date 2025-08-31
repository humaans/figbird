import type { FeathersClient } from '../../lib'
import { createHooks, createSchema, FeathersAdapter, Figbird, service } from '../../lib'

// Define a simple interface for testing
interface Person {
  id: string
  name: string
  email: string
}

interface PersonService {
  item: Person
}

// Create schema
const schema = createSchema({
  services: {
    'api/people': service<PersonService>(),
  },
})

// Create Figbird instance with FeathersAdapter
const feathers = {} as FeathersClient
const adapter = new FeathersAdapter(feathers)
const figbird = new Figbird({ schema, adapter })

// Create hooks with figbird instance - find meta type should be inferred as FeathersFindMeta
const { useFind, useGet } = createHooks(figbird)

// Test that useFind returns QueryResult with FeathersFindMeta
export const findResult = useFind('api/people')

// Extract meta type for testing
export type FindMetaType = typeof findResult.meta
export type FindMetaTotal = typeof findResult.meta.total
export type FindMetaLimit = typeof findResult.meta.limit
export type FindMetaSkip = typeof findResult.meta.skip

// useGet does not expose meta by default
export const getResult = useGet('api/people', '123')

// Test accessing meta properties from find - these should not cause type errors
export const metaTotalAccess = findResult.meta.total
export const metaLimitAccess = findResult.meta.limit
export const metaSkipAccess = findResult.meta.skip

// These should be typed as number | undefined
export type MetaTotalType = typeof metaTotalAccess
export type MetaLimitType = typeof metaLimitAccess
export type MetaSkipType = typeof metaSkipAccess
