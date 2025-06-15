// core
export { Figbird } from './core/figbird.js'

// adapters
export { FeathersAdapter } from './adapters/feathers.js'
export { matcher } from './adapters/matcher.js'

// react hooks
export { useGet, useFind } from './react/useQuery.js'
export { useMutation } from './react/useMutation.js'
export { FigbirdProvider, useFigbird, useFeathers } from './react/react.js'

// Core types that users will interact with
export type { Response, EventType, EventHandlers, Adapter } from './types.js'

// Query-related types for advanced usage
export type { QueryDescriptor, QueryConfig } from './core/figbird.js'
export type { QueryStatus } from './core/internal-types.js'

// React hook result types (already exported but let's be complete)
export type { QueryResult } from './react/useQuery.js'
export type { UseMutationResult } from './react/useMutation.js'

// Feathers-specific types for TypeScript users
export type {
  FeathersItem,
  FeathersParams,
  FeathersService,
  FeathersClient,
  FeathersQuery,
  FeathersFindMeta,
} from './adapters/feathers-types.js'

// Adapter options for creating custom adapters
export type { PrepareQueryOptions } from './adapters/matcher.js'
