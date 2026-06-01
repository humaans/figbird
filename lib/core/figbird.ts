import type { Adapter, AdapterFindMeta, AdapterParams, AdapterQuery } from '../adapters/adapter.js'
import type {
  AnySchema,
  Schema,
  ServiceCreate,
  ServiceItem,
  ServiceNames,
  ServicePatch,
  ServiceQuery,
  ServiceUpdate,
} from './schema.js'
import { resolveServicePath } from './schema.js'
import { QueryRef } from './queryRef.js'
import { QueryStore } from './queryStore.js'
import {
  normalizeQueryConfig,
  type InferQueryData,
  type MutationDescriptor,
  type QueryConfig,
  type QueryDescriptor,
  type ServiceState,
} from './queryTypes.js'

export { isFetching, isIdle, isLoading, isPending, splitConfig } from './queryTypes.js'
export type { QueryConfig, QueryState, QueryStatus } from './queryTypes.js'

// Helper to specialize adapter params' `query` by service-level domain query
type ParamsWithServiceQuery<S extends Schema, N extends ServiceNames<S>, A extends Adapter> = Omit<
  AdapterParams<A>,
  'query'
> & { query?: ServiceQuery<S, N> }

/**
    Usage:

    const adapter = new FeathersAdapter({ feathers })
    const figbird = new Figbird({ adapter })

    const q = figbird.query({ serviceName: 'notes', method: 'find' })

    // Execute query and begin listening for realtime updates
    const unsub = q.subscribe(state => console.log(state.status, state.data))

    // Get current query state synchronously
    q.getSnapshot()

    // Stop listening to updates while preserving the query state and data in cache.
    // The query state can be recovered by creating a new query with the same parameters.
    // Multiple queries can safely reference the same cached state.
    unsub()
*/
/**
 * Figbird core instance holding the adapter and shared query state.
 * Prefer `createHooks(figbird)` in React apps to get strongly-typed hooks.
 */
export class Figbird<
  S extends Schema = AnySchema,
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  A extends Adapter<any, any, any> = Adapter<unknown, Record<string, unknown>, unknown>,
> {
  adapter: A
  queryStore: QueryStore<S, AdapterParams<A>, AdapterFindMeta<A>, AdapterQuery<A>>
  schema: S | undefined

  /**
   * Create a Figbird instance.
   * @param adapter Data adapter (e.g. FeathersAdapter)
   * @param eventBatchProcessingInterval Optional interval (ms) for batching realtime events
   * @param schema Optional schema to enable full TypeScript inference
   */
  constructor({
    adapter,
    eventBatchProcessingInterval,
    schema,
  }: {
    adapter: A
    eventBatchProcessingInterval?: number
    schema?: S
  }) {
    this.adapter = adapter
    this.schema = schema
    this.queryStore = new QueryStore<S, AdapterParams<A>, AdapterFindMeta<A>, AdapterQuery<A>>({
      adapter,
      eventBatchProcessingInterval: eventBatchProcessingInterval,
    })
  }

  /** Returns the entire internal state map keyed by service name. */
  getState(): Map<string, ServiceState<AdapterFindMeta<A>>> {
    return this.queryStore.getState()
  }

  // Strongly-typed overloads for inference from serviceName and method
  /** Create a typed `find` query reference. */
  query<N extends ServiceNames<S>>(
    desc: { serviceName: N; method: 'find'; params?: ParamsWithServiceQuery<S, N, A> },
    config?: QueryConfig<ServiceItem<S, N>[], ServiceQuery<S, N>>,
  ): QueryRef<
    ServiceItem<S, N>[],
    ServiceQuery<S, N>,
    S,
    AdapterParams<A>,
    AdapterFindMeta<A>,
    AdapterQuery<A>
  >
  /** Create a typed `get` query reference. */
  query<N extends ServiceNames<S>>(
    desc: {
      serviceName: N
      method: 'get'
      resourceId: string | number
      params?: ParamsWithServiceQuery<S, N, A>
    },
    config?: QueryConfig<ServiceItem<S, N>, ServiceQuery<S, N>>,
  ): QueryRef<
    ServiceItem<S, N>,
    ServiceQuery<S, N>,
    S,
    AdapterParams<A>,
    AdapterFindMeta<A>,
    AdapterQuery<A>
  >
  // Generic fallback overload (for dynamic descriptors)
  query<D extends QueryDescriptor>(
    desc: D,
    config?: QueryConfig<InferQueryData<S, D>, AdapterQuery<A>>,
  ): QueryRef<
    InferQueryData<S, D>,
    AdapterQuery<A>,
    S,
    AdapterParams<A>,
    AdapterFindMeta<A>,
    AdapterQuery<A>
  >
  // Implementation
  query(
    desc: {
      serviceName: string
      method: 'find' | 'get'
      resourceId?: string | number
      params?: unknown
    },
    config?: QueryConfig<unknown, unknown>,
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  ): any {
    const resolvedDesc = {
      ...desc,
      serviceName: resolveServicePath(this.schema, desc.serviceName),
    }

    return new QueryRef<unknown, unknown, S, AdapterParams<A>, AdapterFindMeta<A>, AdapterQuery<A>>(
      {
        desc: resolvedDesc as QueryDescriptor,
        config: normalizeQueryConfig(config),
        queryStore: this.queryStore,
      },
    )
  }

  // Strongly-typed mutation overloads

  /** Create a single new item. */
  mutate<N extends ServiceNames<S>>(desc: {
    serviceName: N
    method: 'create'
    data: ServiceCreate<S, N>
    params?: AdapterParams<A>
  }): Promise<ServiceItem<S, N>>

  /** Create multiple new items (batch). */
  mutate<N extends ServiceNames<S>>(desc: {
    serviceName: N
    method: 'create'
    data: ServiceCreate<S, N>[]
    params?: AdapterParams<A>
  }): Promise<ServiceItem<S, N>[]>

  /** Update an existing item by ID (full replacement). */
  mutate<N extends ServiceNames<S>>(desc: {
    serviceName: N
    method: 'update'
    id: string | number
    data: ServiceUpdate<S, N>
    params?: AdapterParams<A>
  }): Promise<ServiceItem<S, N>>

  /** Patch an existing item by ID (partial update). */
  mutate<N extends ServiceNames<S>>(desc: {
    serviceName: N
    method: 'patch'
    id: string | number
    data: ServicePatch<S, N>
    params?: AdapterParams<A>
  }): Promise<ServiceItem<S, N>>

  /** Remove an item by ID. */
  mutate<N extends ServiceNames<S>>(desc: {
    serviceName: N
    method: 'remove'
    id: string | number
    params?: AdapterParams<A>
  }): Promise<ServiceItem<S, N>>

  // Implementation
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  mutate(desc: MutationDescriptor): Promise<any> {
    return this.queryStore.mutate({
      ...desc,
      serviceName: resolveServicePath(this.schema, desc.serviceName),
    })
  }

  /** Subscribe to any state changes within Figbird (across all queries/services). */
  subscribeToStateChanges(
    fn: (state: Map<string, ServiceState<AdapterFindMeta<A>>>) => void,
  ): () => void {
    return this.queryStore.subscribeToStateChanges(fn)
  }
}
