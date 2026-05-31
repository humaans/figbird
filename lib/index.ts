// core
export { Figbird, isFetching, isIdle, isLoading, isPending } from './core/figbird.js'

export type { EventType } from './core/figbird.js'

// schema
export { defineSchema, defineSchemaFor, defineService } from './core/schema.js'
export type {
  AnySchema,
  Create,
  Item,
  Methods,
  Patch,
  Query,
  Schema,
  Service,
  ServiceByName,
  ServiceCreate,
  ServiceItem,
  ServiceMethods,
  ServiceNames,
  ServicePatch,
  ServiceQuery,
  ServiceTypeDefinition,
  ServiceUpdate,
  UntypedService,
  Update,
} from './core/schema.js'

// adapters
export { FeathersAdapter } from './adapters/feathers.js'
export { matcher } from './adapters/matcher.js'

// Adapter interface and types
export type {
  Adapter,
  AdapterFindMeta,
  AdapterParams,
  AdapterQuery,
  EventHandlers,
} from './adapters/adapter.js'

// react hooks
export { createHooks } from './react/createHooks.js'
export { FigbirdProvider, useFigbird } from './react/react.js'
export { useFeathers } from './react/useFeathers.js'
export { useMethod } from './react/useMethod.js'
export { useMutation } from './react/useMutation.js'
export { useFind, useGet } from './react/useQuery.js'
export { useService } from './react/useService.js'

// Query-related types for advanced usage
export type {
  FindQueryConfig,
  GetQueryConfig,
  QueryConfig,
  QueryState,
  QueryStatus,
} from './core/figbird.js'

// React hook result types (already exported but let's be complete)
export type {
  UseMethodCall,
  UseMethodResult,
  UseMethodState,
  UseMethodStatus,
} from './react/useMethod.js'
export type { UseMutationResult } from './react/useMutation.js'
export type { QueryResult } from './react/useQuery.js'

// Feathers-specific types for TypeScript users
export type {
  FeathersClient,
  FeathersFindMeta,
  FeathersParams,
  FeathersService,
  TypedFeathersClient,
  TypedFeathersService,
} from './adapters/feathers.js'

// Adapter options for creating custom adapters
export type { PrepareQueryOptions } from './adapters/matcher.js'
