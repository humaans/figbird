import type { AnySchema, Schema, ServiceDefinitionByPath, ServicePaths } from './schema.js'
import type { StoredQueryClass } from './queryClassification.js'
import type { PageInfo, PageRequest } from '../adapters/adapter.js'

export type ItemId = string | number
export type EntityKey = string

/** Canonical cache identity: numeric and string forms address the same item. */
export function entityKey(id: ItemId): EntityKey {
  return String(id)
}

/**
 * Event types supported by Figbird
 */
export type EventType = 'created' | 'updated' | 'patched' | 'removed'

/**
 * Internal event representation
 */
export interface Event {
  type: EventType
  item: unknown
}

export type TraceCause =
  | { kind: 'realtime'; traceId: number }
  | { kind: 'reconnect'; traceId: number }
  | { kind: 'visibility'; traceId: number }
  | { kind: 'mutation'; traceId: number; mutationId?: number }
  | { kind: 'fetch-rebase'; traceId: number }
  | { kind: 'manual'; traceId: number }
  | { kind: 'subscription'; traceId: number }

/**
 * Identifies the relational operation run and structural node that owns a fetch.
 * This is execution metadata only: it must never participate in query identity.
 */
export interface QueryGraphRef {
  operationId: string
  runId: string
  path: string
  role?: 'junction'
}

export interface QueryExecutionOptions {
  staleTime?: number | undefined
  graph?: QueryGraphRef | undefined
}

/**
 * Queued event for batch processing
 */
interface QueuedEventBase {
  serviceName: string
  type: EventType
  item: unknown
  cause?: TraceCause
}

/** Internal entity changes waiting at the store's atomic event boundary. */
export type QueuedEvent =
  | (QueuedEventBase & { mode: 'server'; source: 'realtime' | 'mutation' })
  | (QueuedEventBase & { mode: 'optimistic'; mutationLaneKey: string })

/**
 * A realtime event after it has been applied to the entity cache. Carries the
 * previous entity so downstream invalidation logic (e.g. relational filters) can
 * detect which fields changed.
 */
interface ProcessedEventBase {
  serviceName: string
  type: EventType
  item: unknown
  previousItem: unknown | null
  /** Always defined — events whose item has no resolvable id are never applied. */
  itemId: EntityKey
  cause?: TraceCause
}

/** An optimistic entity change after cache application. */
export type ProcessedProjectionEvent = ProcessedEventBase & {
  mode: 'optimistic'
  mutationLaneKey: string
}

/** A server, optimistic, or explicitly local entity change after cache application. */
export type ProcessedServerEvent = ProcessedEventBase & {
  mode: 'server'
  source: 'realtime' | 'mutation' | 'fetch'
}

export type ProcessedCacheEvent =
  | ProcessedServerEvent
  | ProcessedProjectionEvent
  | (ProcessedEventBase & { mode: 'local' })

export type QueryStatus = 'loading' | 'success' | 'error'

type QueryStatusState = {
  status: QueryStatus
  isFetching: boolean
}

export function isPending(query: QueryStatusState): boolean {
  return query.status === 'loading'
}

export function isFetching(query: QueryStatusState): boolean {
  return query.isFetching
}

export function isLoading(query: QueryStatusState): boolean {
  return query.status === 'loading' && query.isFetching
}

export function isIdle(query: QueryStatusState): boolean {
  return query.status === 'loading' && !query.isFetching
}

/**
 * Query state representation - discriminated union for better type safety
 */
export type QueryState<T, TMeta = Record<string, unknown>> =
  | {
      status: 'loading'
      data: null
      meta: TMeta
      pageInfo?: PageInfo
      isFetching: boolean
      error: null
    }
  | {
      status: 'success'
      data: T
      meta: TMeta
      pageInfo?: PageInfo
      isFetching: boolean
      error: null
    }
  | {
      status: 'error'
      data: null
      meta: TMeta
      pageInfo?: PageInfo
      isFetching: boolean
      error: Error
    }

/**
 * Internal query representation
 */
export interface Query<T = unknown, TMeta = Record<string, unknown>, TQuery = unknown> {
  queryId: string
  desc: QueryDescriptor
  config: QueryConfig<T, TQuery>
  /**
   * How this query is maintained, computed once at materialize time (`desc` and
   * `config` are frozen — they are what the query id hashes). The realtime event
   * loop reads this instead of re-walking the query per item.
   */
  classification: StoredQueryClass
  pending: boolean
  dirty: boolean
  filterItem: (item: ElementType<T>) => boolean
  state: QueryState<T, TMeta>
  /** Epoch ms of the last successful fetch — the seed of staleness decisions. */
  fetchedAt?: number
}

/**
 * Service state in the store
 */
export interface ServiceState<TMeta = Record<string, unknown>> {
  entities: Map<EntityKey, unknown>
  queries: Map<string, Query<unknown, TMeta, unknown>>
  itemQueryIndex: Map<EntityKey, Set<string>>
  /**
   * Set when an unfiltered allPages fetch (a filterless `.all()`) succeeded: the
   * complete row set is in the entity cache, realtime maintains it, and matcher-
   * decidable finds are answered locally without a roundtrip. A *filtered* `.all()`
   * is complete only for its own query and never sets this.
   */
  materialized?: { queryId: string; fetchedAt: number }
}

/**
 * Query descriptor for get operations
 */
export interface GetDescriptor {
  serviceName: string
  method: 'get'
  resourceId: string | number
  params?: unknown
}

/**
 * Query descriptor for find operations
 */
export interface FindDescriptor {
  serviceName: string
  method: 'find'
  params?: unknown
  /** Internal adapter-managed page request. Kept outside params.query deliberately. */
  page?: PageRequest
}

/**
 * Discriminated union of query descriptors
 */
export type QueryDescriptor = GetDescriptor | FindDescriptor

/**
 * The one sanctioned crossing of the `params?: unknown` boundary: project the
 * adapter-shaped params down to the `query` object figbird inspects (for
 * classification, matching, and window maintenance).
 */
export function queryOfParams(params: unknown): Record<string, unknown> | undefined {
  // `|| undefined` normalizes a runtime null (or other falsy junk) to undefined.
  return (params as { query?: Record<string, unknown> } | undefined)?.query || undefined
}

/**
 * Helper type to extract element type from arrays
 */
export type ElementType<T> = T extends (infer E)[] ? E : T

// Public untyped APIs intentionally resolve to `any` for backwards compatibility.
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
type UntypedData = any

/**
 * Base query configuration shared by all query types.
 * Add these alongside adapter params when calling useFind/useGet.
 */
interface BaseQueryConfig<TItem = unknown, TQuery = unknown> {
  /**
   * Skip fetching entirely. Useful for conditional queries.
   * When true, status is 'loading' with isFetching: false and no network request is made.
   */
  skip?: boolean

  /**
   * Realtime strategy for handling events:
   * - 'merge' (default): merge incoming events into cached results
   * - 'refetch': refetch the entire query when an event is received
   * - 'disabled': ignore realtime events for this query
   */
  realtime?: 'merge' | 'refetch' | 'disabled'

  /**
   * Fetch policy determines how cache vs network is used:
   * - 'swr' (default): stale-while-revalidate (show cache, refetch in background)
   * - 'cache-first': prefer cache and avoid network if data is present
   * - 'network-only': always fetch on mount
   */
  fetchPolicy?: 'swr' | 'cache-first' | 'network-only'

  /**
   * Failed fetches to retry before exposing the error. Inherits the Figbird
   * instance setting when omitted. `false` disables retries for this query.
   */
  retry?: number | false

  /** Fixed delay in milliseconds before each retry for this query. */
  retryDelay?: number

  /**
   * Optional custom matcher factory. Only used in realtime 'merge' mode.
   * Receives the prepared query object; returns a predicate for items.
   * Provide this if your adapter needs custom client-side matching logic.
   * Note: For find queries, the matcher works with individual items, not arrays.
   * Queries with a matcher use isolated cache identity because functions cannot
   * be serialized into a stable shared cache key.
   */
  matcher?: (query: TQuery | undefined) => (item: ElementType<TItem>) => boolean

  /**
   * Explicit cache-sharing key for custom matchers. Queries with the same
   * descriptor and matcherKey share one result; the key must therefore identify
   * equivalent matcher behavior. Without it, matcher queries stay hook-isolated.
   */
  matcherKey?: string

  /**
   * Treat this query as server-maintained. Realtime events from the query's service
   * refetch active subscribers and mark inactive cached queries pending.
   * Use this for server-authoritative projections, virtual fields, search, or
   * other server-only membership/order/value semantics.
   */
  server?: boolean
}

/**
 * Configuration for get queries
 */
export type GetQueryConfig<TItem = unknown, TQuery = unknown> = BaseQueryConfig<TItem, TQuery>

/**
 * Configuration for find queries
 */
export interface FindQueryConfig<TItem = unknown, TQuery = unknown> extends BaseQueryConfig<
  TItem,
  TQuery
> {
  /**
   * Fetches all pages by iterating until completion, aggregating results.
   * Honors adapter pagination controls (e.g. $limit/$skip for Feathers).
   */
  allPages?: boolean
}

/**
 * Discriminated union of query configurations
 */
export type QueryConfig<TItem = unknown, TQuery = unknown> =
  | GetQueryConfig<TItem, TQuery>
  | FindQueryConfig<TItem, TQuery>

/**
 * Combined config for get operations
 * Combines the descriptor and config properties with index signature for extra params
 */
export type CombinedGetConfig<TItem = unknown, TQuery = unknown> = GetDescriptor &
  GetQueryConfig<TItem, TQuery> & {
    [key: string]: unknown
  }

/**
 * Combined config for find operations
 * Combines the descriptor and config properties with index signature for extra params
 */
export type CombinedFindConfig<TItem = unknown, TQuery = unknown> = FindDescriptor &
  FindQueryConfig<TItem, TQuery> & {
    [key: string]: unknown
  }

/**
 * Combined config for internal use
 */
export type CombinedConfig<TItem = unknown, TQuery = unknown> =
  | CombinedGetConfig<TItem, TQuery>
  | CombinedFindConfig<TItem, TQuery>

/**
 * Item matcher function type
 */
export type ItemMatcher<T> = (item: T) => boolean

/**
 * Helper type to infer data type from schema and query descriptor
 */
export type InferQueryData<S extends Schema, D extends QueryDescriptor> = S extends AnySchema
  ? UntypedData
  : D extends { serviceName: infer P extends string; method: infer M }
    ? P extends ServicePaths<S>
      ? M extends 'find'
        ? ServiceDefinitionByPath<S, P>['item'][]
        : M extends 'get'
          ? ServiceDefinitionByPath<S, P>['item']
          : UntypedData
      : UntypedData
    : UntypedData

/**
 * Base mutation descriptor with common fields
 */
interface BaseMutationDescriptor {
  serviceName: string
  params?: unknown
  /**
   * When set, apply a synthetic event to the local store before the network round-trip.
   * On success the server's response replaces the optimistic item; on failure the change
   * is rolled back and a `mutate:rollback` event is emitted. `true` synthesizes the item
   * from the request; a non-boolean value is applied as the optimistic item verbatim
   * (typed per service by the `mutateDesc` overloads — this is the untyped base).
   */
  optimistic?: boolean | unknown
  /**
   * Partial record used for the optimistic projection when the wire payload and
   * the local shape differ. Unlike `optimistic`, this is merged over the current
   * projected record. It is meaningful for update/patch mutations only.
   */
  optimisticPatch?: unknown
}

/**
 * Descriptor for create mutations
 */
export interface CreateMutationDescriptor extends BaseMutationDescriptor {
  method: 'create'
  data: unknown
}

/**
 * Descriptor for update mutations
 */
export interface UpdateMutationDescriptor extends BaseMutationDescriptor {
  method: 'update'
  id: string | number
  data: unknown
}

/**
 * Descriptor for patch mutations
 */
export interface PatchMutationDescriptor extends BaseMutationDescriptor {
  method: 'patch'
  id: string | number
  data: unknown
}

/**
 * Descriptor for remove mutations
 */
export interface RemoveMutationDescriptor extends BaseMutationDescriptor {
  method: 'remove'
  id: string | number
}

/**
 * Discriminated union of all mutation descriptors
 */
export type MutationDescriptor =
  | CreateMutationDescriptor
  | UpdateMutationDescriptor
  | PatchMutationDescriptor
  | RemoveMutationDescriptor

/**
 * Helper type to infer data type from schema and mutation descriptor
 */
export type InferMutationData<S extends Schema, D extends MutationDescriptor> = S extends AnySchema
  ? UntypedData
  : D extends { serviceName: infer P extends string; data: readonly unknown[] }
    ? P extends ServicePaths<S>
      ? ServiceDefinitionByPath<S, P>['item'][]
      : UntypedData
    : D extends { serviceName: infer P extends string }
      ? P extends ServicePaths<S>
        ? ServiceDefinitionByPath<S, P>['item']
        : UntypedData
      : UntypedData

/**
 * A helper to split the properties into a query descriptor `desc` (including 'params')
 * and figbird-specific query configuration `config`
 */
export function splitConfig<TItem = unknown, TQuery = unknown>(
  combinedConfig: CombinedConfig<TItem, TQuery>,
): {
  desc: QueryDescriptor
  config: QueryConfig<TItem, TQuery>
} {
  // Extract common properties
  const {
    serviceName,
    method,
    skip,
    realtime,
    fetchPolicy,
    retry,
    retryDelay,
    matcher,
    matcherKey,
    server,
    ...rest
  } = combinedConfig

  if (method === 'get') {
    const { resourceId, ...params } = rest as CombinedGetConfig<TItem, TQuery>

    const desc: GetDescriptor = {
      serviceName,
      method,
      resourceId,
      params,
    }

    const config: GetQueryConfig<TItem, TQuery> = {
      ...(skip !== undefined && { skip }),
      ...(realtime !== undefined && { realtime }),
      ...(fetchPolicy !== undefined && { fetchPolicy }),
      ...(retry !== undefined && { retry }),
      ...(retryDelay !== undefined && { retryDelay }),
      ...(matcher !== undefined && { matcher }),
      ...(matcherKey !== undefined && { matcherKey }),
      ...(server !== undefined && { server }),
    }

    return { desc, config: normalizeQueryConfig(config) }
  } else {
    const { allPages, ...params } = rest as CombinedFindConfig<TItem, TQuery>

    const desc: FindDescriptor = {
      serviceName,
      method,
      params,
    }

    const config: FindQueryConfig<TItem, TQuery> = {
      ...(skip !== undefined && { skip }),
      ...(realtime !== undefined && { realtime }),
      ...(fetchPolicy !== undefined && { fetchPolicy }),
      ...(retry !== undefined && { retry }),
      ...(retryDelay !== undefined && { retryDelay }),
      ...(matcher !== undefined && { matcher }),
      ...(matcherKey !== undefined && { matcherKey }),
      ...(allPages !== undefined && { allPages }),
      ...(server !== undefined && { server }),
    }

    return { desc, config: normalizeQueryConfig(config) }
  }
}

export function normalizeQueryConfig<TItem = unknown, TQuery = unknown>(
  config: QueryConfig<TItem, TQuery> = {},
): QueryConfig<TItem, TQuery> {
  return {
    realtime: 'merge',
    fetchPolicy: 'swr',
    ...config,
  }
}
