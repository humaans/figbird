import type { Adapter, AdapterFindMeta, AdapterParams, AdapterQuery } from '../adapters/adapter.js'
import { FigbirdEventEmitter, type FigbirdEvents } from './events.js'
import {
  createQueryBuilderProxy,
  type QueryBuilder,
  type QueryBuilderProxy,
  type QueryBuilderResult,
} from './query-builder.js'
import {
  QUERY_DEFINITION_BRAND,
  validateQueryArgs,
  type PreparedQuery,
  type QueryDefinition,
  type StandardSchemaV1,
} from './queryDefinition.js'
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
import { RelationalQueryRef } from './relationalQuery.js'
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

export { isFetching, isIdle, isLoading, isPending, splitConfig } from './queryTypes.js'
export type {
  EventType,
  FindQueryConfig,
  GetQueryConfig,
  MutationOptions,
  QueryConfig,
  QueryDescriptor,
  QueryState,
  QueryStatus,
} from './queryTypes.js'
export type { FigbirdEvent, FigbirdEvents, MutationMethod } from './events.js'
export {
  isQueryDefinition,
  QUERY_DEFINITION_BRAND,
  QueryArgsError,
  validateQueryArgs,
} from './queryDefinition.js'
export type { PreparedQuery, QueryDefinition, StandardSchemaV1 } from './queryDefinition.js'
export { RelationalQueryRef } from './relationalQuery.js'
export type { RelationalPaginationState, RelationalQueryState } from './relationalQuery.js'

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
  #events: FigbirdEventEmitter

  // Cache of active RelationalQueryRef instances, keyed by AST hash. This is critical for
  // React 18 Suspense interop: on suspense retries React discards render-state (including
  // useMemo and useRef), so if we recreated a RelationalQueryRef per render the hook would
  // keep throwing fresh promises and loop. By interning refs here we guarantee the same
  // instance is returned to any consumer with the same query shape. An internal listener
  // count drives eviction — refs are removed from the cache when their last hook unmounts
  // (see RelationalQueryRef#cleanup).
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  #relationalQueryCache: Map<string, RelationalQueryRef<any, S, any, any, any>> = new Map()

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
    this.#events = new FigbirdEventEmitter()
    this.queryStore = new QueryStore<S, AdapterParams<A>, AdapterFindMeta<A>, AdapterQuery<A>>({
      adapter,
      eventBatchProcessingInterval: eventBatchProcessingInterval,
      events: this.#events,
    })
  }

  /**
   * Subscribe to Figbird's observability events — lifecycle signals for fetches,
   * realtime events flowing in, and mutations (including optimistic / rollback).
   * Designed for dev panels, tracing, and analytics.
   *
   * @example
   * ```ts
   * const unsub = figbird.events.subscribe(event => {
   *   console.log(event.kind, event)
   * })
   * ```
   */
  get events(): FigbirdEvents {
    return this.#events
  }

  /** Returns the entire internal state map keyed by service name. */
  getState(): Map<string, ServiceState<AdapterFindMeta<A>>> {
    return this.queryStore.getState()
  }

  /**
   * Query builder proxy for creating relational queries.
   * Access services as properties to get a QueryBuilder for that service.
   *
   * @example
   * ```ts
   * const { q } = figbird
   *
   * const issues = q.issues
   *   .where({ status: 'open' })
   *   .related('comments')
   *   .limit(50)
   *
   * const result = useQuery(issues)
   * ```
   */
  get q(): QueryBuilderProxy<S> {
    if (!this.schema) {
      throw new Error(
        'Cannot use query builder without a schema. ' +
          'Pass schema to Figbird constructor: new Figbird({ schema, adapter })',
      )
    }
    return createQueryBuilderProxy(this.schema)
  }

  /**
   * Create a relational query reference from a QueryBuilder.
   * The returned RelationalQueryRef manages sub-queries and assembles related data.
   *
   * @example
   * ```ts
   * const qRef = figbird.relationalQuery(
   *   figbird.q.issues
   *     .where({ status: 'open' })
   *     .related('comments')
   *     .related('creator')
   * )
   *
   * // Subscribe to get updates
   * const unsub = qRef.subscribe(state => {
   *   console.log(state.status, state.data)
   * })
   *
   * // Get current snapshot
   * const snapshot = qRef.getSnapshot()
   *
   * // Refetch
   * qRef.refetch()
   * ```
   */
  relationalQuery<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    B extends QueryBuilder<S, any, any, any, any, any>,
  >(
    builder: B,
  ): RelationalQueryRef<
    QueryBuilderResult<B>,
    S,
    AdapterParams<A>,
    AdapterFindMeta<A>,
    AdapterQuery<A>
  > {
    type T = QueryBuilderResult<B>
    if (!this.schema) {
      throw new Error(
        'Cannot use relational queries without a schema. ' +
          'Pass schema to Figbird constructor: new Figbird({ schema, adapter })',
      )
    }
    const hash = builder.hash()
    const cached = this.#relationalQueryCache.get(hash)
    if (cached) {
      return cached as RelationalQueryRef<
        T,
        S,
        AdapterParams<A>,
        AdapterFindMeta<A>,
        AdapterQuery<A>
      >
    }
    const ast = builder.toAST()
    const ref = new RelationalQueryRef<T, S, AdapterParams<A>, AdapterFindMeta<A>, AdapterQuery<A>>(
      // Figbird structurally satisfies the engine's narrow RelationalQueryHost contract.
      this,
      ast,
      this.schema,
      // Evict only if the cache still points at THIS instance. An already-replaced
      // instance (evicted earlier, e.g. by StrictMode's unsubscribe/resubscribe cycle)
      // cleaning up must not delete its successor's entry — that would force every
      // render to intern a fresh ref whose subscription tears down the previous one,
      // evicting the current one in turn: an unsubscribe/re-intern loop.
      () => {
        if (this.#relationalQueryCache.get(hash) === ref) {
          this.#relationalQueryCache.delete(hash)
        }
      },
    )
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    this.#relationalQueryCache.set(hash, ref as RelationalQueryRef<any, S, any, any, any>)
    return ref
  }

  /**
   * Register a named query factory. Returns a typed `QueryDefinition` that can be passed to
   * `figbird.prepare(query, args)` and `useQuery(query, args)`. Identical `name + args`
   * resolves to the same builder hash and the same cache entry — so a query the router
   * prepared and a query the component reads share state.
   *
   * Args are typed from the build function's parameter. When args arrive from an
   * untrusted source (URL params, storage), pass a
   * [Standard Schema](https://github.com/standard-schema/standard-schema) validator
   * (zod, valibot, arktype, etc.) as the middle argument — it runs at every
   * `prepare()`/`useQuery()` call site and throws `QueryArgsError` on failure, turning
   * silent cache-misses (e.g. `{ id: "42" }` vs `{ id: 42 }`) into loud, fast failures.
   * The (possibly normalized) value returned by the schema feeds into `build`, so the
   * cache key reflects the normalized args. Args from typed code don't need one.
   *
   * @example
   * ```ts
   * // Typed args, no runtime validation — the common case
   * const issueDetail = figbird.defineQuery('issueDetail', ({ id }: { id: number }) =>
   *   figbird.q.issues.where({ id }).one().related('comments'),
   * )
   *
   * // Validated args — for URL-driven call sites
   * import { z } from 'zod'
   * const issueDetail = figbird.defineQuery(
   *   'issueDetail',
   *   z.object({ id: z.coerce.number().int().positive() }),
   *   ({ id }) => figbird.q.issues.where({ id }).one().related('comments'),
   * )
   *
   * figbird.prepare(issueDetail, { id: '42' })  // coerces "42" → 42 before build
   * useQuery(issueDetail, { id: 42 })           // component reads the same cache entry
   * ```
   */
  // Overload: typed args only, no runtime validation.
  defineQuery<
    Args,
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    B extends QueryBuilder<S, any, any, any, any, any>,
  >(name: string, build: (args: Args) => B): QueryDefinition<Args, B>
  // Overload: Standard Schema-validated args.
  defineQuery<
    TSchema extends StandardSchemaV1,
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    B extends QueryBuilder<S, any, any, any, any, any>,
  >(
    name: string,
    argsSchema: TSchema,
    build: (args: StandardSchemaV1.InferOutput<TSchema>) => B,
  ): QueryDefinition<StandardSchemaV1.InferOutput<TSchema>, B>
  // Implementation
  defineQuery(
    name: string,
    argsSchemaOrBuild: StandardSchemaV1 | ((args: unknown) => unknown),
    maybeBuild?: (args: unknown) => unknown,
  ): QueryDefinition<unknown, unknown> {
    const argsSchema = maybeBuild ? (argsSchemaOrBuild as StandardSchemaV1) : null
    const build = maybeBuild ?? (argsSchemaOrBuild as (args: unknown) => unknown)
    return {
      [QUERY_DEFINITION_BRAND]: true,
      name,
      build,
      validate: argsSchema
        ? (args: unknown) => validateQueryArgs(name, argsSchema, args)
        : (args: unknown) => args,
    }
  }

  /**
   * Pre-warm a query before any component reads it. Returns a `PreparedQuery` handle whose
   * `promise` resolves when the same `useQuery(query, args)` would have data ready and
   * rejects with the error a Suspense read would throw. Holds the cache entry alive until
   * `release()` is called or the underlying ref's last subscriber unmounts.
   *
   * Designed for router preparation, hover prefetch, and parents that can see child needs
   * earlier than the child itself. The component still reads via `useQuery(query, args)` —
   * preparation is an earlier read, not a different read.
   *
   * @example
   * ```ts
   * // routes.ts — router metadata (like a priority) is attached by the app
   * defineRoute({
   *   path: '/issues/:id',
   *   resolver: () => import('./pages/IssueDetail/screen'),
   *   prepare: ({ figbird, params }) => [
   *     { ...figbird.prepare(issueDetail, { id: Number(params.id) }), priority: 'route' },
   *   ],
   * })
   * ```
   */
  prepare<
    Args,
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    B extends QueryBuilder<S, any, any, any, any, any>,
  >(query: QueryDefinition<Args, B>, args: Args): PreparedQuery {
    const validatedArgs = query.validate(args)
    const builder = query.build(validatedArgs)
    const ref = this.relationalQuery(builder)
    // No-op listener — purely a pin. The promise drives readiness; release() drops the pin.
    // While pinned, subsequent useQuery subscribers join the same ref. When everyone has
    // released and unsubscribed, RelationalQueryRef cleans up and evicts the cache entry.
    const unsub = ref.subscribe(() => {})
    return {
      key: ref.hash(),
      promise: ref.suspensePromise(),
      release: unsub,
    }
  }

  // Active speculative pins, keyed by query hash (see prefetch()).
  #prefetches: Map<
    string,
    { at: number; release: () => void; timer: ReturnType<typeof setTimeout> }
  > = new Map()

  /**
   * Speculatively warm a query — the idempotent, fire-and-forget sibling of `prepare()`.
   *
   * Safe to call at any frequency (hover, viewport entry, likely-next): if the same
   * query was prefetched within `staleTime`, the call is a no-op. Otherwise the query
   * is materialized and held alive by an internal pin that auto-releases after
   * `staleTime` — the fetched data stays in the QueryStore either way, so a later
   * `useQuery` gets a warm synchronous read. If a component subscribes in the
   * meantime, its own subscription keeps the query alive past the pin.
   *
   * Use `prepare()` instead when you need to await readiness or control the lease
   * explicitly (router navigation).
   *
   * @example
   * ```ts
   * <Row onMouseEnter={() => figbird.prefetch(issueDetail, { id: issue.id })} />
   * ```
   */
  prefetch<
    Args,
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    B extends QueryBuilder<S, any, any, any, any, any>,
  >(query: QueryDefinition<Args, B>, args: Args, options: { staleTime?: number } = {}): void {
    const staleTime = options.staleTime ?? 30_000
    const validatedArgs = query.validate(args)
    const builder = query.build(validatedArgs)
    const ref = this.relationalQuery(builder)
    const hash = ref.hash()

    const now = Date.now()
    const existing = this.#prefetches.get(hash)
    if (existing && now - existing.at < staleTime) return
    if (existing) {
      clearTimeout(existing.timer)
      existing.release()
      this.#prefetches.delete(hash)
    }

    const release = ref.subscribe(() => {})
    const timer = setTimeout(() => {
      this.#prefetches.delete(hash)
      release()
    }, staleTime)
    // Never keep a Node process alive for a speculative pin (browsers ignore this).
    ;(timer as { unref?: () => void }).unref?.()
    this.#prefetches.set(hash, { at: now, release, timer })
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
    optimistic?: boolean | ServiceItem<S, N>
  }): Promise<ServiceItem<S, N>>

  /** Create multiple new items (batch). */
  mutate<N extends ServiceNames<S>>(desc: {
    serviceName: N
    method: 'create'
    data: ServiceCreate<S, N>[]
    params?: AdapterParams<A>
    optimistic?: boolean | ServiceItem<S, N>[]
  }): Promise<ServiceItem<S, N>[]>

  /** Update an existing item by ID (full replacement). */
  mutate<N extends ServiceNames<S>>(desc: {
    serviceName: N
    method: 'update'
    id: string | number
    data: ServiceUpdate<S, N>
    params?: AdapterParams<A>
    optimistic?: boolean | ServiceItem<S, N>
  }): Promise<ServiceItem<S, N>>

  /** Patch an existing item by ID (partial update). */
  mutate<N extends ServiceNames<S>>(desc: {
    serviceName: N
    method: 'patch'
    id: string | number
    data: ServicePatch<S, N>
    params?: AdapterParams<A>
    optimistic?: boolean | ServiceItem<S, N>
  }): Promise<ServiceItem<S, N>>

  /** Remove an item by ID. */
  mutate<N extends ServiceNames<S>>(desc: {
    serviceName: N
    method: 'remove'
    id: string | number
    params?: AdapterParams<A>
    optimistic?: boolean
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
