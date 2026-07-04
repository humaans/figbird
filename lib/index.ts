// core
export {
  Figbird,
  QUERY_DEFINITION_BRAND,
  QueryArgsError,
  isFetching,
  isIdle,
  isLoading,
  isPending,
  isQueryDefinition,
} from './core/figbird.js'

export type {
  EventType,
  FigbirdEvent,
  FigbirdEvents,
  MutationMethod,
  MutationOptions,
  PreparedQuery,
  QueryDefinition,
  StandardSchemaV1,
} from './core/figbird.js'

// schema
export { createSchema, service, one, many, embed } from './core/schema.js'
export type {
  AnySchema,
  Create,
  Item,
  Methods,
  Patch,
  Query,
  RelationshipDef,
  RelationshipHelpers,
  RelationshipHop,
  RelationshipsFactory,
  Schema,
  SchemaRelationships,
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

// query builder
export { QueryBuilder, createQueryBuilderProxy } from './core/query-builder.js'
export type {
  QueryAST,
  QueryBuilderProxy,
  FeathersQuery,
  FieldOperators,
  WhereClause,
} from './core/query-builder.js'

// query classification (how a query node is maintained — useful for devtools)
export { classifyQueryNode, hasWindowFilters } from './core/queryClassification.js'
export type { QueryNodeClass } from './core/queryClassification.js'

// relational query
export { RelationalQueryRef } from './core/figbird.js'
export type { RelationalQueryState } from './core/figbird.js'

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
export { useFind, useGet } from './react/useQueryByDesc.js'
export { useService } from './react/useService.js'
// useQuery is the unified, Suspense-by-default builder hook. useRelationalQuery stays
// exported as the classic tagged-union variant for back-compat and for code that prefers
// explicit status handling.
export { useQuery, useRelationalQuery } from './react/useRelationalQuery.js'
export { useDelayedFlag } from './react/useDelayedFlag.js'
export type {
  RelationalQueryResult,
  SuspenseQueryResult,
  UseQueryOptions,
  UseRelationalQueryOptions,
} from './react/useRelationalQuery.js'

// Query-related types for advanced usage
export type {
  FindQueryConfig,
  GetQueryConfig,
  QueryConfig,
  QueryState,
  QueryStatus,
} from './core/figbird.js'

// React hook result types
export type { UseMethodResult } from './react/useMethod.js'
export type { UseMutationOptions, UseMutationResult } from './react/useMutation.js'
export type { QueryResult } from './react/useQueryByDesc.js'

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
