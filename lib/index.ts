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
  DefineQuery,
  EventType,
  FigbirdEvent,
  FigbirdEvents,
  InFlightMutation,
  MutationActivity,
  MutationCallOptions,
  MutationEventMethod,
  MutationMethod,
  MutationQueueConfig,
  MutationQueueOperation,
  MutationQueueRetry,
  MutationQueueRetryDelay,
  MutationQueueSnapshot,
  MutationQueueStatus,
  MutationSchedule,
  MutationsHandle,
  MutationsProxy,
  PreparedQuery,
  QueryDefinition,
  ReconnectJitter,
  RetryDelay,
  StandardSchemaV1,
  VisibilitySource,
} from './core/figbird.js'
export {
  MutationQueueDiscardedError,
  MutationSupersededError,
  isMutationSupersededError,
} from './core/figbird.js'
export type { MutationQueue } from './core/mutationQueue.js'
export { ItemRemovedError, isItemRemovedError } from './core/errors.js'

// schema
export { createSchema, service } from './core/schema.js'
export type {
  AnySchema,
  RelationshipDef,
  RelationshipHelpers,
  RelationshipHop,
  RelationshipsConfig,
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
} from './core/schema.js'

// query builder
export { QueryBuilder } from './core/queryBuilder.js'
export type { QueryAST, QueryBuilderProxy } from './core/queryBuilder.js'

// query classification report types (returned by figbird.explain / figbird.inspect)
export type { ClassificationReason, QueryNodeClass } from './core/queryClassification.js'
export type { ExplainNode, ExplainReport, InspectedQuery } from './core/figbird.js'

// relational query
export { RelationalQueryRef } from './core/figbird.js'
export type { RelationalQueryState } from './core/figbird.js'

// adapters
export { cursorPagination, FeathersAdapter, offsetPagination } from './adapters/feathers.js'
export type {
  CursorPaginationOptions,
  CustomOperator,
  CustomOperatorContext,
  CustomOperatorRegistration,
  FeathersAdapterOptions,
  FeathersCursorPagination,
  FeathersOffsetPagination,
  FeathersPagination,
} from './adapters/feathers.js'
export { matcher } from './adapters/matcher.js'

// Adapter interface and types
export type {
  Adapter,
  AdapterFindMeta,
  AdapterParams,
  AdapterQuery,
  EventHandlers,
  MatcherContext,
  PageCursor,
  PageInfo,
  PageRequest,
  PageResponse,
  PageSource,
} from './adapters/adapter.js'

// react hooks
export { createHooks } from './react/createHooks.js'
export type { FigbirdHooks } from './react/createHooks.js'
export { FigbirdProvider, useFigbird, useFigbirdMaybe } from './react/context.js'
// The write-side story: useMutations returns the provider instance's stateless write
// proxy; useAction carries per-action pending/error; useMutating answers entity/service-
// level "is anything in flight". Imperative code uses figbird.m directly.
export { useAction } from './react/useAction.js'
export { useMutating } from './react/useMutating.js'
export { useMutationQueue } from './react/useMutationQueue.js'
// Deprecated: superseded by useMutations + useAction + useMutating.
export { useMutation } from './react/useMutation.js'
// useFeathers is the raw-client escape hatch, typed via createHooks.
export { useFeathers } from './react/useFeathers.js'
// Legacy generation (deprecated): descriptor-based reads. Fully functional, but new
// code should use useQuery + builders.
export { useFind, useGet } from './react/useQueryByDesc.js'
// useQuery is the unified, Suspense-by-default builder hook; pass { suspense: false }
// for the explicit tagged-union variant.
export { useQuery } from './react/useQuery.js'
// useQueries suspends on several independent queries at once — one boundary, all
// fetches in parallel, no sequential waterfall.
export { useQueries } from './react/useQueries.js'
export { useDelayedFlag } from './react/useDelayedFlag.js'
// The rest of the no-flash kit (see the "no-flash checklist" docs section):
export { useDebouncedTransition } from './react/useDebouncedTransition.js'
export { DelayedFallback } from './react/DelayedFallback.js'
export type {
  RelationalQueryResult,
  SuspenseQueryResult,
  UseQueryHook,
  UseQueryOptions,
} from './react/useQuery.js'
export type { UseQueriesHook, UseQueriesOptions } from './react/useQueries.js'

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
export type { UseMutationQueueHook } from './react/useMutationQueue.js'
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
