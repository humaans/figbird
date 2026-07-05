// core
export {
  Figbird,
  defineQuery,
  QUERY_DEFINITION_BRAND,
  QueryArgsError,
  isFetching,
  isIdle,
  isLoading,
  isPending,
  isQueryDefinition,
} from './core/figbird.js'

export type {
  ArgsAndOptions,
  EventType,
  FigbirdEvent,
  FigbirdEvents,
  InFlightMutation,
  MutationActivity,
  MutationCallOptions,
  MutationEventMethod,
  MutationMethod,
  MutationsHandle,
  MutationsProxy,
  PreparedQuery,
  QueryDefinition,
  StandardSchemaV1,
  VisibilitySource,
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
export { QueryBuilder, createQueryBuilderProxy } from './core/queryBuilder.js'
export type {
  QueryAST,
  QueryBuilderProxy,
  FeathersQuery,
  FieldOperators,
  WhereClause,
} from './core/queryBuilder.js'

// query classification (how a query node is maintained — useful for devtools)
export {
  classifyQueryNode,
  explainQueryNode,
  hasWindowFilters,
} from './core/queryClassification.js'
export type { ClassificationReason, QueryNodeClass } from './core/queryClassification.js'
export type { ExplainNode, ExplainReport, InspectedQuery } from './core/figbird.js'

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
export { FigbirdProvider, useFigbird, useFigbirdMaybe } from './react/context.js'
// The write-side story: mutations() handles (from figbird.mutations / createHooks)
// are stateless service clients; useAction carries per-action pending/error;
// useMutating answers entity/service-level "is anything in flight".
export { useAction } from './react/useAction.js'
export { useMutating } from './react/useMutating.js'
// Deprecated: superseded by mutations() + useAction + useMutating.
export { useMutation } from './react/useMutation.js'
// useFeathers is the raw-client escape hatch, typed via createHooks.
export { useFeathers } from './react/useFeathers.js'
// Legacy generation (deprecated): descriptor-based reads. Fully functional, but new
// code should use useQuery + builders.
export { useFind, useGet } from './react/useQueryByDesc.js'
// useQuery is the unified, Suspense-by-default builder hook; pass { suspense: false }
// for the explicit tagged-union variant.
export { useQuery } from './react/useQuery.js'
export { useDelayedFlag } from './react/useDelayedFlag.js'
// The rest of the no-flash kit (see the "no-flash checklist" docs section):
export { useDebouncedTransition } from './react/useDebouncedTransition.js'
export { DelayedFallback } from './react/DelayedFallback.js'
export type {
  RelationalQueryResult,
  SuspenseQueryResult,
  UseQueryOptions,
} from './react/useQuery.js'

// Query-related types for advanced usage
export type {
  FindQueryConfig,
  GetQueryConfig,
  QueryConfig,
  QueryState,
  QueryStatus,
} from './core/figbird.js'

// React hook result types
export type { UseActionHook, UseActionResult } from './react/useAction.js'
export type { UseMutatingFilter } from './react/useMutating.js'
export type { UseMutationResult } from './react/useMutation.js'
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
