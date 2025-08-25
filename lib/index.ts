// core
export { Figbird } from './core/figbird.js'

// schema
export { createSchema, findServiceByName, hasSchema, service } from './schema/types.js'
export type {
  AnySchema,
  Item,
  Methods,
  Query,
  Schema,
  Service,
  ServiceItem,
  ServiceMethods,
  ServiceNames,
  ServiceQuery,
  UntypedService,
} from './schema/types.js'

// adapters
export { FeathersAdapter } from './adapters/feathers.js'
export { matcher } from './adapters/matcher.js'

// react hooks
export { createHooks } from './react/createHooks.js'
export { FigbirdProvider, useFeathers, useFigbird } from './react/react.js'
export { useMutation } from './react/useMutation.js'
export { useFind, useGet } from './react/useQuery.js'

// Core types that users will interact with
export type { Adapter, EventHandlers, EventType, Response } from './types.js'

// Query-related types for advanced usage
export type { QueryConfig, QueryDescriptor } from './core/figbird.js'
export type { QueryStatus } from './core/internal-types.js'

// React hook result types (already exported but let's be complete)
export type { UseMutationResult } from './react/useMutation.js'
export type { QueryResult } from './react/useQuery.js'

// Feathers-specific types for TypeScript users
export type {
  FeathersClient,
  FeathersFindMeta,
  FeathersItem,
  FeathersParams,
  FeathersQuery,
  FeathersService,
} from './adapters/feathers.js'

// Adapter options for creating custom adapters
export type { PrepareQueryOptions } from './adapters/matcher.js'
