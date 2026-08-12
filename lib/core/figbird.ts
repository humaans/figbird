import {
  locallySupportedOperators,
  type Adapter,
  type AdapterFindMeta,
  type AdapterParams,
  type AdapterQuery,
  type PageInfo,
  type PageRequest,
} from '../adapters/adapter.js'
import { registerDevtoolsInstance } from './devtoolsBridge.js'
import type { FigbirdEvents } from './events.js'
import { createMutationsProxy, type MutationsHost, type MutationsProxy } from './mutations.js'
import type { MutationActivity } from './mutationTracker.js'
import {
  createQueryBuilderProxy,
  queryBuilderUsesSchema,
  type AnyQueryBuilder,
  type QueryBuilderProxy,
  type QueryBuilderResult,
} from './queryBuilder.js'
import {
  isQueryDefinition,
  splitDefinitionRest,
  type ArgsAndOptions,
  type PreparedQuery,
  type QueryDefinition,
} from './queryDefinition.js'
import { explainQuery, type ExplainReport, type QueryNodeClass } from './queryClassification.js'
export type { ExplainNode, ExplainReport } from './queryClassification.js'
import { QueryRef } from './queryRef.js'
import {
  QueryStore,
  type ReconnectJitter,
  type RetryDelay,
  type VisibilitySource,
} from './queryStore.js'

export type { ReconnectJitter, RetryDelay, VisibilitySource } from './queryStore.js'
import {
  normalizeQueryConfig,
  queryOfParams,
  type InferQueryData,
  type MutationDescriptor,
  type QueryConfig,
  type QueryDescriptor,
  type ServiceState,
} from './queryTypes.js'
import { RelationalQueryRef, type InspectedRelationalQuery } from './relationalQuery.js'
export type { InspectedRelationalQuery } from './relationalQuery.js'
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
  QueryConfig,
  QueryDescriptor,
  QueryState,
  QueryStatus,
} from './queryTypes.js'
export type { FigbirdEvent, FigbirdEvents, MutationEventMethod, MutationMethod } from './events.js'
export type {
  MethodArgs,
  MethodData,
  MutationCallOptions,
  MutationsHandle,
  MutationsProxy,
} from './mutations.js'
export type { InFlightMutation, MutationActivity } from './mutationTracker.js'
export {
  defineQuery,
  isQueryDefinition,
  QUERY_DEFINITION_BRAND,
  QueryArgsError,
  splitDefinitionRest,
  validateQueryArgs,
} from './queryDefinition.js'
export type {
  ArgsAndOptions,
  ArgsAndRequiredOptions,
  DefineQuery,
  PreparedQuery,
  QueryDefinition,
  StandardSchemaV1,
} from './queryDefinition.js'
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

    const q = figbird.queryDesc({ serviceName: 'notes', method: 'find' })

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
 * Prefer `createHooks(schema)` in React apps to get strongly-typed hooks.
 */
export class Figbird<
  S extends Schema = AnySchema,
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  A extends Adapter<any, any, any> = Adapter<unknown, Record<string, unknown>, unknown>,
> {
  adapter: A
  queryStore: QueryStore<S, AdapterParams<A>, AdapterFindMeta<A>, AdapterQuery<A>>
  schema: S | undefined

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
   * @param eventBatchInterval Optional interval (ms) for batching realtime events
   * @param schema Optional schema to enable full TypeScript inference
   * @param reconcileCooldown Burst safety: minimum interval (ms) between event-driven
   *   refetches of one query. First event refetches immediately; further events within
   *   the window coalesce into one guaranteed trailing refetch. Default 2000; 0 disables.
   * @param retry Failed fetches to retry before exposing the error. Defaults to 3;
   *   `false` disables automatic retry.
   * @param retryDelay Fixed or computed delay before each retry. Defaults to exponential
   *   backoff (1s, 2s, 4s, capped at 30s).
   * @param reconnectJitter Random delay before a reconnect sweep, which staggers visible
   *   clients after a server restart. Defaults to [0, 3000]; 0 restores immediate sweeps.
   * @param visibility Visibility source for hidden-tab gating (defaults to `document`).
   *   Hidden tabs defer event-driven reconciliation until they become visible.
   * @param defaultSort The backend's implicit ordering for queries without `$sort`
   *   (e.g. `{ createdAt: -1, id: -1 }`). Window maintenance uses it to place
   *   realtime items into unsorted windows locally instead of refetching. This is a
   *   correctness contract like custom operators: it must mirror the order the
   *   server actually applies — divergence shows up as misplaced rows until the
   *   next fetch.
   */
  constructor({
    adapter,
    eventBatchInterval,
    schema,
    reconcileCooldown,
    retry,
    retryDelay,
    reconnectJitter,
    visibility,
    defaultSort,
  }: {
    adapter: A
    eventBatchInterval?: number
    schema?: S
    reconcileCooldown?: number
    retry?: number | false
    retryDelay?: RetryDelay
    reconnectJitter?: ReconnectJitter
    visibility?: VisibilitySource
    defaultSort?: Record<string, 1 | -1>
  }) {
    this.adapter = adapter
    this.schema = schema
    this.queryStore = new QueryStore<S, AdapterParams<A>, AdapterFindMeta<A>, AdapterQuery<A>>({
      adapter,
      eventBatchInterval,
      ...(reconcileCooldown !== undefined ? { reconcileCooldown } : {}),
      ...(retry !== undefined ? { retry } : {}),
      ...(retryDelay !== undefined ? { retryDelay } : {}),
      ...(reconnectJitter !== undefined ? { reconnectJitter } : {}),
      ...(visibility !== undefined ? { visibility } : {}),
      ...(defaultSort !== undefined ? { defaultSort } : {}),
    })
    registerDevtoolsInstance(this)
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
    return this.queryStore.events
  }

  /**
   * Returns the entire internal state map keyed by service name — including the
   * cached entities themselves, which `inspect()` deliberately omits. Debug-grade:
   * internal shapes may change between versions; prefer `inspect()` for anything
   * built to last.
   */
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
  #qProxy: QueryBuilderProxy<S> | null = null

  get q(): QueryBuilderProxy<S> {
    if (!this.schema) {
      throw new Error(
        'Cannot use query builder without a schema. ' +
          'Pass schema to Figbird constructor: new Figbird({ schema, adapter })',
      )
    }
    this.#qProxy ??= createQueryBuilderProxy(this.schema)
    return this.#qProxy
  }

  /**
   * Materialize a query and return its live reference — the non-React mirror of
   * `useQuery`. Accepts a builder, or a definition plus args. The returned
   * RelationalQueryRef manages sub-queries and assembles related data.
   *
   * @example
   * ```ts
   * const qRef = figbird.query(
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
   *
   * // Definition form — same cache entry as useQuery(issueDetail, { id })
   * const ref = figbird.query(issueDetail, { id: 42 })
   * ```
   */
  query<B extends AnyQueryBuilder<S>>(
    builder: B,
  ): RelationalQueryRef<
    QueryBuilderResult<B>,
    S,
    AdapterParams<A>,
    AdapterFindMeta<A>,
    AdapterQuery<A>
  >
  query<Args, B extends AnyQueryBuilder<S>>(
    query: QueryDefinition<Args, B>,
    ...rest: ArgsAndOptions<Args, never>
  ): RelationalQueryRef<
    QueryBuilderResult<B>,
    S,
    AdapterParams<A>,
    AdapterFindMeta<A>,
    AdapterQuery<A>
  >
  query<B extends AnyQueryBuilder<S>>(
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    queryOrBuilder: B | QueryDefinition<unknown, B>,
    args?: unknown,
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
    const definition = isQueryDefinition(queryOrBuilder) ? queryOrBuilder : null
    const builder: B = definition
      ? definition.build(definition.validate(args))
      : (queryOrBuilder as B)
    if (!queryBuilderUsesSchema(builder, this.schema)) {
      throw new Error('The query builder uses a different schema from this Figbird instance')
    }
    const hash = builder.hash()
    const cached = this.#relationalQueryCache.get(hash)
    let ref = cached as
      RelationalQueryRef<T, S, AdapterParams<A>, AdapterFindMeta<A>, AdapterQuery<A>> | undefined
    if (!ref) {
      const ast = builder.toAST()
      ref = new RelationalQueryRef<T, S, AdapterParams<A>, AdapterFindMeta<A>, AdapterQuery<A>>(
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
    }
    ref.setDisplayName(definition?.name)
    return ref
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
  prepare<Args, B extends AnyQueryBuilder<S>>(
    query: QueryDefinition<Args, B>,
    ...rest: ArgsAndOptions<Args, { staleTime?: number }>
  ): PreparedQuery
  prepare(
    query: QueryDefinition<unknown, AnyQueryBuilder<S>>,
    argsOrOptions?: unknown,
    maybeOptions?: { staleTime?: number },
  ): PreparedQuery {
    const { args, options } = splitDefinitionRest<{ staleTime?: number }>(
      query,
      argsOrOptions,
      maybeOptions,
    )
    // query() owns definition resolution (validate → build → intern), so the
    // "definition + args collapses to one cache entry" contract lives in one place.
    const ref = this.query(query, args as never)
    // No-op listener — purely a pin. The promise drives readiness; release() drops the pin.
    // While pinned, subsequent useQuery subscribers join the same ref. When everyone has
    // released and unsubscribed, RelationalQueryRef cleans up and evicts the cache entry.
    // A staleTime skips the SWR revalidation when the data is already fresh enough.
    const unsub = ref.subscribe(() => {}, options ?? {})
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
  prefetch<Args, B extends AnyQueryBuilder<S>>(
    query: QueryDefinition<Args, B>,
    ...rest: ArgsAndOptions<Args, { staleTime?: number }>
  ): void
  prefetch(
    query: QueryDefinition<unknown, AnyQueryBuilder<S>>,
    argsOrOptions?: unknown,
    maybeOptions?: { staleTime?: number },
  ): void {
    const { args, options } = splitDefinitionRest<{ staleTime?: number }>(
      query,
      argsOrOptions,
      maybeOptions,
    )
    const staleTime = options?.staleTime ?? 30_000
    const ref = this.query(query, args as never)
    const hash = ref.hash()

    const now = Date.now()
    const existing = this.#prefetches.get(hash)
    if (existing && now - existing.at < staleTime) return
    if (existing) {
      clearTimeout(existing.timer)
      existing.release()
      this.#prefetches.delete(hash)
    }

    // The pin also carries the staleTime so a warm-in-store read within the window
    // skips the SWR revalidation instead of re-fetching.
    const release = ref.subscribe(() => {}, { staleTime })
    const timer = setTimeout(() => {
      this.#prefetches.delete(hash)
      release()
    }, staleTime)
    // Never keep a Node process alive for a speculative pin (browsers ignore this).
    ;(timer as { unref?: () => void }).unref?.()
    this.#prefetches.set(hash, { at: now, release, timer })
  }

  // Descriptor layer — the primitive the relational engine (and the deprecated
  // useFind/useGet path) is built on. Speaks plain `{ serviceName, method }`
  // descriptors, requires no schema, and resolves service path aliases centrally.
  // Prefer `figbird.query(builder)` in app code.

  // Strongly-typed overloads for inference from serviceName and method
  /** Create a typed `find` query reference from a descriptor. */
  queryDesc<N extends ServiceNames<S>>(
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
  /** Create a typed `get` query reference from a descriptor. */
  queryDesc<N extends ServiceNames<S>>(
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
  queryDesc<D extends QueryDescriptor>(
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
  queryDesc(
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

  // Descriptor layer, write side — the primitive `m` is built on. Speaks plain
  // `{ serviceName, method, id, data }` descriptors and requires no schema.
  // Prefer `figbird.m` in app code.

  // Strongly-typed mutation overloads

  /** Create a single new item. */
  mutateDesc<N extends ServiceNames<S>>(desc: {
    serviceName: N
    method: 'create'
    data: ServiceCreate<S, N>
    params?: AdapterParams<A>
    optimistic?: boolean | ServiceItem<S, N>
  }): Promise<ServiceItem<S, N>>

  /** Create multiple new items (batch). */
  mutateDesc<N extends ServiceNames<S>>(desc: {
    serviceName: N
    method: 'create'
    data: ServiceCreate<S, N>[]
    params?: AdapterParams<A>
    optimistic?: boolean | ServiceItem<S, N>[]
  }): Promise<ServiceItem<S, N>[]>

  /** Update an existing item by ID (full replacement). */
  mutateDesc<N extends ServiceNames<S>>(desc: {
    serviceName: N
    method: 'update'
    id: string | number
    data: ServiceUpdate<S, N>
    params?: AdapterParams<A>
    optimistic?: boolean | ServiceItem<S, N>
  }): Promise<ServiceItem<S, N>>

  /** Patch an existing item by ID (partial update). */
  mutateDesc<N extends ServiceNames<S>>(desc: {
    serviceName: N
    method: 'patch'
    id: string | number
    data: ServicePatch<S, N>
    params?: AdapterParams<A>
    optimistic?: boolean | ServiceItem<S, N>
  }): Promise<ServiceItem<S, N>>

  /** Remove an item by ID. */
  mutateDesc<N extends ServiceNames<S>>(desc: {
    serviceName: N
    method: 'remove'
    id: string | number
    params?: AdapterParams<A>
    optimistic?: boolean
  }): Promise<ServiceItem<S, N>>

  // Implementation
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  mutateDesc(desc: MutationDescriptor): Promise<any> {
    return this.queryStore.mutate({
      ...desc,
      serviceName: resolveServicePath(this.schema, desc.serviceName),
    })
  }

  /**
   * Call a custom (non-CRUD) service method — the mutation path for everything
   * beyond create/update/patch/remove. No cache update is applied (the result
   * shape is unknown), but the call is tracked (`figbird.mutating`, `useMutating`)
   * and emits `mutate:*` observability events like any mutation.
   *
   * Prefer the typed methods on an `m` handle in app code; this is the
   * underlying primitive.
   */
  call(serviceName: string, method: string, ...args: unknown[]): Promise<unknown> {
    return this.queryStore.call(resolveServicePath(this.schema, serviceName), method, args)
  }

  #mutationsProxy: MutationsProxy<S> | null = null

  /**
   * The write proxy — the write-side counterpart of `q`. Services are
   * properties; verbs are methods; handles are stateless plain values (no
   * hook, no lifecycle) usable at module scope, in event handlers, and in
   * non-React code. Writes are optimistic by default; `confirmed` variants
   * wait for the server ack before the cache shows the change.
   *
   * @example
   * ```ts
   * const { m } = figbird
   * await m.issues.patch(id, { status: 'closed' })   // optimistic (default)
   * await m.policies.confirmed.create(policy)        // waits for the ack
   * await m.issues.archive(id)                       // custom schema method
   * m(serviceName).patch(id, data)                   // dynamic service name
   * ```
   */
  get m(): MutationsProxy<S> {
    if (!this.#mutationsProxy) {
      const host: MutationsHost = {
        mutate: desc =>
          this.queryStore.mutate({
            ...desc,
            serviceName: resolveServicePath(this.schema, desc.serviceName),
          }),
        call: (service, method, args) =>
          this.queryStore.call(resolveServicePath(this.schema, service), method, args),
      }
      this.#mutationsProxy = createMutationsProxy(host) as MutationsProxy<S>
    }
    return this.#mutationsProxy
  }

  /**
   * Live view of in-flight mutations (CRUD and custom methods). Synchronously
   * maintained — correct even for subscribers that attach mid-mutation — and
   * shaped for `useSyncExternalStore`. `useMutating` is the React binding.
   */
  get mutating(): MutationActivity {
    return this.queryStore.mutations
  }

  /**
   * Manually refetch cached queries — the escape hatch for changes figbird cannot
   * observe (custom methods on services without realtime events, out-of-band
   * writes). `figbird.refetch('issues')` refetches every query on the service;
   * `figbird.refetch()` refetches everything. Active queries refetch immediately;
   * inactive cached ones refetch when next subscribed.
   */
  refetch(serviceName?: ServiceNames<S> | (string & {})): void {
    this.queryStore.refetchQueries(
      serviceName === undefined ? undefined : resolveServicePath(this.schema, serviceName),
    )
  }

  /**
   * Static analysis of a query: one entry per executed node (root, relations, and
   * junction hops) with figbird's classification of how that node is maintained and
   * the structured reasons why. No fetching happens — callable anywhere.
   *
   * Use it to answer "why did adding `.limit(30)` change realtime behavior", to
   * assert a query's class in tests, or to power devtools.
   */
  explain<B extends AnyQueryBuilder<S>>(builder: B): ExplainReport
  explain<Args>(
    query: QueryDefinition<Args, AnyQueryBuilder<S>>,
    ...rest: ArgsAndOptions<Args, never>
  ): ExplainReport
  explain(
    queryOrBuilder: AnyQueryBuilder<S> | QueryDefinition<unknown, AnyQueryBuilder<S>>,
    args?: unknown,
  ): ExplainReport {
    // Resolved without interning — explain never materializes a query. The walk
    // itself lives in queryClassification.ts, next to the plans it reports on.
    const builder = isQueryDefinition(queryOrBuilder)
      ? queryOrBuilder.build(queryOrBuilder.validate(args))
      : queryOrBuilder
    const nodes = explainQuery(
      builder.toAST(),
      this.schema?.relationships,
      serviceName =>
        locallySupportedOperators(this.adapter, resolveServicePath(this.schema, serviceName)),
      serviceName =>
        this.adapter.pageSource?.(resolveServicePath(this.schema, serviceName)) !== undefined,
    )
    return { nodes }
  }

  /**
   * Read-only snapshot of every query currently in the store — the stable projection
   * devtools should build on (internal store shapes stay free to change).
   */
  inspect(): InspectedQuery[] {
    const rows: InspectedQuery[] = []
    for (const [serviceName, service] of this.queryStore.getState()) {
      for (const query of service.queries.values()) {
        const q = queryOfParams(query.desc.params)
        const stats = this.queryStore.getQueryStats(query.queryId)
        const generation = this.queryStore.getQueryGeneration(query.queryId)
        if (generation === undefined) continue
        rows.push({
          queryId: query.queryId,
          generation,
          serviceName,
          method: query.desc.method,
          ...(query.desc.method === 'get' ? { resourceId: query.desc.resourceId } : {}),
          query: q,
          ...(query.desc.method === 'find' && query.desc.page
            ? {
                page: {
                  request: query.desc.page,
                  ...(query.state.pageInfo ? { info: query.state.pageInfo } : {}),
                },
              }
            : {}),
          classification: query.classification,
          status: query.state.status,
          isFetching: query.state.isFetching,
          itemCount: Array.isArray(query.state.data)
            ? query.state.data.length
            : query.state.data
              ? 1
              : 0,
          fetchedAt: query.fetchedAt,
          subscriberCount: this.queryStore.getSubscriberCount(query.queryId),
          fetchCount: stats?.fetchCount ?? 0,
          errorCount: stats?.errorCount ?? 0,
          ...(stats?.lastDurationMs !== undefined ? { lastDurationMs: stats.lastDurationMs } : {}),
          totalDurationMs: stats?.totalDurationMs ?? 0,
        })
      }
    }
    return rows
  }

  /**
   * Read-only grouping of active relational query refs and the store-level queries
   * each one currently owns. Entries exist while the interned ref is alive.
   */
  inspectRelational(): InspectedRelationalQuery[] {
    return Array.from(this.#relationalQueryCache.values()).map(ref => ref.inspect())
  }

  /** Subscribe to any state changes within Figbird (across all queries/services). */
  subscribeToStateChanges(
    fn: (state: Map<string, ServiceState<AdapterFindMeta<A>>>) => void,
  ): () => void {
    return this.queryStore.subscribeToStateChanges(fn)
  }
}

/** One row of `figbird.inspect()` — a stable, read-only view of a live query. */
export interface InspectedQuery {
  queryId: string
  /** Store-entry generation for this stable logical query id. */
  generation: number
  serviceName: string
  method: 'find' | 'get'
  resourceId?: string | number
  query: Record<string, unknown> | undefined
  /** Native adapter page details. Offset pages remain visible in `query` as `$skip`/`$limit`. */
  page?: { request: PageRequest; info?: PageInfo }
  classification: QueryNodeClass | 'get'
  status: 'loading' | 'success' | 'error'
  isFetching: boolean
  itemCount: number
  fetchedAt: number | undefined
  subscriberCount: number
  fetchCount: number
  errorCount: number
  lastDurationMs?: number
  totalDurationMs: number
}
