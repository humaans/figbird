// core
export { Figbird } from './core/figbird.js'

export type { EventType } from './core/figbird.js'

// schema
export { createSchema, findServiceByName, hasSchema, service } from './core/schema.js'
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
} from './core/schema.js'

// adapters
export { FeathersAdapter } from './adapters/feathers.js'
export { matcher } from './adapters/matcher.js'

// Adapter interface and types
export type { Adapter, EventHandlers, QueryResponse } from './adapters/adapter.js'

// react hooks
export { createHooks } from './react/createHooks.js'
export { FigbirdProvider, useFigbird } from './react/react.js'
export { useFeathers } from './react/useFeathers.js'
export { useMutation } from './react/useMutation.js'
export { useFind, useGet } from './react/useQuery.js'

// Query-related types for advanced usage
export type {
  FindDescriptor,
  FindQueryConfig,
  GetDescriptor,
  GetQueryConfig,
  QueryConfig,
  QueryDescriptor,
  QueryState,
  QueryStatus,
} from './core/figbird.js'

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
