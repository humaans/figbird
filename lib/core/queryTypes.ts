import type { AnySchema, Schema, ServiceItem, ServiceNames } from './schema.js'

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

/**
 * Queued event for batch processing
 */
export interface QueuedEvent {
  serviceName: string
  type: EventType
  items: unknown[]
}

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
      isFetching: boolean
      error: null
    }
  | {
      status: 'success'
      data: T
      meta: TMeta
      isFetching: boolean
      error: null
    }
  | {
      status: 'error'
      data: null
      meta: TMeta
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
  pending: boolean
  dirty: boolean
  filterItem: (item: ElementType<T>) => boolean
  state: QueryState<T, TMeta>
}

/**
 * Service state in the store
 */
export interface ServiceState<TMeta = Record<string, unknown>> {
  entities: Map<string | number, unknown>
  queries: Map<string, Query<unknown, TMeta, unknown>>
  itemQueryIndex: Map<string | number, Set<string>>
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
}

/**
 * Discriminated union of query descriptors
 */
export type QueryDescriptor = GetDescriptor | FindDescriptor

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
   * Optional custom matcher factory. Only used in realtime 'merge' mode.
   * Receives the prepared query object; returns a predicate for items.
   * Provide this if your adapter needs custom client-side matching logic.
   * Note: For find queries, the matcher works with individual items, not arrays.
   */
  matcher?: (query: TQuery | undefined) => (item: ElementType<TItem>) => boolean
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
  : D extends { serviceName: infer N extends string; method: infer M }
    ? N extends ServiceNames<S>
      ? M extends 'find'
        ? ServiceItem<S, N>[]
        : M extends 'get'
          ? ServiceItem<S, N>
          : UntypedData
      : UntypedData
    : UntypedData

/**
 * Base mutation descriptor with common fields
 */
interface BaseMutationDescriptor {
  serviceName: string
  params?: unknown
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
  : D extends { serviceName: infer N extends string; data: readonly unknown[] }
    ? N extends ServiceNames<S>
      ? ServiceItem<S, N>[]
      : UntypedData
    : D extends { serviceName: infer N extends string }
      ? N extends ServiceNames<S>
        ? ServiceItem<S, N>
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
  const { serviceName, method, skip, realtime, fetchPolicy, matcher, ...rest } = combinedConfig

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
      ...(matcher !== undefined && { matcher }),
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
      ...(matcher !== undefined && { matcher }),
      ...(allPages !== undefined && { allPages }),
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
