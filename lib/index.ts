// core
export {
  defineMutationQueue,
  Figbird,
  defineQuery,
  QUERY_DEFINITION_BRAND,
  QUERY_REQUEST_BRAND,
  QueryArgsError,
  isFetching,
  isIdle,
  isLoading,
  isPending,
  isQueryDefinition,
  isQueryRequest,
} from './core/figbird.js'

export type {
  AnyQueryInput,
  CreateMutationOptions,
  DefineQuery,
  EventType,
  FigbirdEvent,
  FigbirdEvents,
  InFlightMutation,
  MutationActivity,
  MutationCallOptions,
  MutationParamsOptions,
  MutationEventMethod,
  MutationMethod,
  MutationQueueConfig,
  MutationQueueDefinition,
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
  QueryInput,
  QueryRequest,
  ReconnectJitter,
  RetryDelay,
  StandardSchemaV1,
  TransactionContext,
  TransactionMutationsHandle,
  TransactionMutationsProxy,
  VisibilitySource,
  WriteMutationOptions,
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
  ServiceByPath,
  ServiceCreate,
  ServiceDeclaration,
  ServiceDefinitionByPath,
  ServiceItem,
  ServiceMethods,
  ServiceNames,
  ServicePaths,
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
export type {
  ExplainNode,
  ExplainReport,
  InspectedCacheEntity,
  InspectedCacheService,
  InspectedQuery,
} from './core/figbird.js'

// relational query
export { RelationalQueryRef } from './core/figbird.js'
export type { RelationalQueryState } from './core/figbird.js'

// adapters
export {
  cursorPagination,
  FeathersAdapter,
  feathersBatchTransactions,
  FeathersTransactionError,
  offsetPagination,
} from './adapters/feathers.js'
export type {
  CursorPaginationOptions,
  CustomOperator,
  CustomOperatorContext,
  CustomOperatorRegistration,
  FeathersAdapterOptions,
  FeathersBatchTransactionsOptions,
  FeathersCursorPagination,
  FeathersOffsetPagination,
  FeathersPagination,
  FeathersTransaction,
} from './adapters/feathers.js'
export { matcher } from './adapters/matcher.js'

// Adapter interface and types
export type {
  Adapter,
  AdapterFindMeta,
  AdapterParams,
  AdapterQuery,
  AdapterTransactionOperation,
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
// Data-first reads and the explicit result-object counterpart.
export { useQuery, useQueryResult } from './react/useQuery.js'
// useWindowQuery keeps a bounded set of relational pages around a visible index range.
export { useWindowQuery } from './react/useWindowQuery.js'
// Parallel data and result-object reads.
export { useQueries, useQueryResults } from './react/useQueries.js'
export { useDelayedFlag } from './react/useDelayedFlag.js'
// The rest of the no-flash kit (see the "no-flash checklist" docs section):
export { useDebouncedTransition } from './react/useDebouncedTransition.js'
export { DelayedFallback } from './react/DelayedFallback.js'
export type {
  PaginationControls,
  RelationalQueryResult,
  SuspenseQueryResult,
  UseQueryHook,
  UseQueryOptions,
  UseQueryResultHook,
  UseQueryResultOptions,
} from './react/useQuery.js'
export type {
  SuspenseWindowQueryResult,
  UseWindowQueryHook,
  UseWindowQueryOptions,
  WindowQueryResult,
  WindowRange,
} from './react/useWindowQuery.js'
export type { WindowQueryConfig, WindowQueryState } from './core/windowQuery.js'
export type { UseQueriesHook, UseQueriesOptions, UseQueryResultsHook } from './react/useQueries.js'

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
