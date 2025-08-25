import type { FeathersClient } from '../../lib'
import { createHooks, createSchema, FeathersAdapter, Figbird, service } from '../../lib'

// Define a simple interface for testing
interface Person {
  id: string
  name: string
  email: string
}

// Create schema
const schema = createSchema({
  services: [service<Person, 'api/people'>('api/people')],
})

// Create Figbird instance with FeathersAdapter
const feathers = {} as FeathersClient
const adapter = new FeathersAdapter(feathers)
const figbird = new Figbird({ schema, adapter })

// Create hooks with figbird instance - meta type should be inferred as FeathersFindMeta
const { useFind, useGet } = createHooks(figbird)

// Test that useFind returns QueryResult with FeathersFindMeta
export const findResult = useFind('api/people')

// Extract meta type for testing
export type FindMetaType = typeof findResult.meta
export type FindMetaTotal = typeof findResult.meta.total
export type FindMetaLimit = typeof findResult.meta.limit
export type FindMetaSkip = typeof findResult.meta.skip

// Test that useGet also gets the meta type (though it won't have meaningful values)
export const getResult = useGet('api/people', '123')
export type GetMetaType = typeof getResult.meta

// Test accessing meta properties - these should not cause type errors
export const metaTotalAccess = findResult.meta.total
export const metaLimitAccess = findResult.meta.limit
export const metaSkipAccess = findResult.meta.skip

// These should be typed as number | undefined
export type MetaTotalType = typeof metaTotalAccess
export type MetaLimitType = typeof metaLimitAccess
export type MetaSkipType = typeof metaSkipAccess
