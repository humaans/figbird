import type { Adapter, AdapterFindMeta, AdapterParams, AdapterQuery } from '../adapters/adapter.js'
import { FigbirdEventEmitter, type FigbirdEvents } from './events.js'
import { createMutationsProxy, type MutationsHost, type MutationsProxy } from './mutations.js'
import { MutationTracker, type MutationActivity } from './mutationTracker.js'
import {
  createQueryBuilderProxy,
  type QueryBuilder,
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
import {
  classifyQueryNode,
  explainQueryNode,
  hasWindowFilters,
  type ClassificationReason,
  type QueryNodeClass,
} from './queryClassification.js'
import type { QueryAST } from './queryBuilder.js'
import { QueryRef } from './queryRef.js'
import { QueryStore, type VisibilitySource } from './queryStore.js'

export type { VisibilitySource } from './queryStore.js'
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
  #mutationTracker: MutationTracker

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
   * @param reconcileCooldown Burst safety: minimum interval (ms) between event-driven
   *   refetches of one query. First event refetches immediately; further events within
   *   the window coalesce into one guaranteed trailing refetch. Default 2000; 0 disables.
   * @param visibility Visibility source for hidden-tab gating (defaults to `document`).
   *   Hidden tabs defer event-driven reconciliation until they become visible.
   */
  constructor({
    adapter,
    eventBatchProcessingInterval,
    schema,
    reconcileCooldown,
    visibility,
  }: {
    adapter: A
    eventBatchProcessingInterval?: number
    schema?: S
    reconcileCooldown?: number
    visibility?: VisibilitySource
  }) {
    this.adapter = adapter
    this.schema = schema
    this.#events = new FigbirdEventEmitter()
    this.#mutationTracker = new MutationTracker()
    this.queryStore = new QueryStore<S, AdapterParams<A>, AdapterFindMeta<A>, AdapterQuery<A>>({
      adapter,
      eventBatchProcessingInterval: eventBatchProcessingInterval,
      events: this.#events,
      mutations: this.#mutationTracker,
      ...(reconcileCooldown !== undefined ? { reconcileCooldown } : {}),
      ...(visibility !== undefined ? { visibility } : {}),
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
  query<
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
  >
  query<
    Args,
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    B extends QueryBuilder<S, any, any, any, any, any>,
  >(
    query: QueryDefinition<Args, B>,
    ...rest: ArgsAndOptions<Args, never>
  ): RelationalQueryRef<
    QueryBuilderResult<B>,
    S,
    AdapterParams<A>,
    AdapterFindMeta<A>,
    AdapterQuery<A>
  >
  query<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    B extends QueryBuilder<S, any, any, any, any, any>,
  >(
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
    const builder = isQueryDefinition(queryOrBuilder)
      ? queryOrBuilder.build(queryOrBuilder.validate(args))
      : queryOrBuilder
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
  >(
    query: QueryDefinition<Args, B>,
    ...rest: ArgsAndOptions<Args, { staleTime?: number }>
  ): PreparedQuery
  prepare(
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    query: QueryDefinition<unknown, QueryBuilder<S, any, any, any, any, any>>,
    argsOrOptions?: unknown,
    maybeOptions?: { staleTime?: number },
  ): PreparedQuery {
    const { args, options } = splitDefinitionRest<{ staleTime?: number }>(
      query,
      argsOrOptions,
      maybeOptions,
    )
    const validatedArgs = query.validate(args)
    const builder = query.build(validatedArgs)
    const ref = this.query(builder)
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
  prefetch<
    Args,
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    B extends QueryBuilder<S, any, any, any, any, any>,
  >(query: QueryDefinition<Args, B>, ...rest: ArgsAndOptions<Args, { staleTime?: number }>): void
  prefetch(
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    query: QueryDefinition<unknown, QueryBuilder<S, any, any, any, any, any>>,
    argsOrOptions?: unknown,
    maybeOptions?: { staleTime?: number },
  ): void {
    const { args, options } = splitDefinitionRest<{ staleTime?: number }>(
      query,
      argsOrOptions,
      maybeOptions,
    )
    const staleTime = options?.staleTime ?? 30_000
    const validatedArgs = query.validate(args)
    const builder = query.build(validatedArgs)
    const ref = this.query(builder)
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
    return this.#mutationTracker
  }

  /**
   * Static analysis of a query: one entry per node (root + each relation, dotted
   * paths for nesting) with figbird's classification of how that node is maintained
   * and the structured reasons why. No fetching happens — callable anywhere.
   *
   * Use it to answer "why did adding `.limit(30)` change realtime behavior", to
   * assert a query's class in tests, or to power devtools.
   */
  explain(
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    builderOrDefinition: QueryBuilder<S, any, any, any, any, any> | QueryDefinition<any, any>,
    args?: unknown,
  ): ExplainReport {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    type AnyBuilder = QueryBuilder<S, any, any, any, any, any>
    const builder: AnyBuilder = isQueryDefinition(builderOrDefinition)
      ? (builderOrDefinition.build(builderOrDefinition.validate(args)) as AnyBuilder)
      : (builderOrDefinition as AnyBuilder)
    const ast = builder.toAST()
    const nodes: ExplainNode[] = []
    this.#explainAst(ast, '(root)', true, nodes)
    return { nodes }
  }

  #explainAst(ast: QueryAST, path: string, isRoot: boolean, nodes: ExplainNode[]): void {
    const snapshot = Boolean(ast.snapshot)
    // Mirrors the runtime: .all() drains every page, so window filters ($sort — the
    // builder refuses $limit/$skip) don't demote the class.
    const explained = explainQueryNode(ast.query, {
      server: ast.server,
      allPages: ast.kind === 'all',
    })
    if (snapshot) {
      explained.reasons = [...explained.reasons, { code: 'snapshot', detail: '.snapshot()' }]
    }
    if (isRoot && ast.kind === 'paginate' && explained.class === 'local-exact') {
      explained.class = 'server-window'
      explained.reasons = [
        ...explained.reasons,
        { code: 'window-filter', detail: 'paginate() — each page is a $limit/$skip window' },
      ]
    }

    nodes.push({
      path,
      service: ast.service,
      kind: ast.kind,
      class: explained.class,
      reasons: explained.reasons,
      realtime: snapshot ? 'manual' : explained.class === 'local-exact' ? 'merge' : 'refetch',
    })

    const relationships = this.schema?.relationships?.[ast.service] ?? {}
    for (const [relName, relAST] of Object.entries(ast.related)) {
      const relDef = relationships[relName]
      const relPath = path === '(root)' ? relName : `${path}.${relName}`
      // Mirrors the runtime: relations without explicit windowing fetch allPages, so
      // window filters only count when the consumer asked for a window (which the
      // engine resolves per-parent).
      const windowed = hasWindowFilters(relAST.query)
      const relExplained = explainQueryNode(relAST.query, {
        server: relAST.server,
        allPages: !windowed,
      })
      if (windowed && relDef?.cardinality === 'many' && !relDef.via) {
        relExplained.reasons = [
          ...relExplained.reasons,
          { code: 'window-filter', detail: 'per-parent window — one query per parent' },
        ]
      }
      nodes.push({
        path: relPath,
        service: relDef?.destService ?? relName,
        kind: 'find',
        class: relExplained.class,
        reasons: relExplained.reasons,
        realtime: snapshot ? 'manual' : relExplained.class === 'local-exact' ? 'merge' : 'refetch',
        ...(relDef?.via ? { via: relDef.via.destService } : {}),
      })
      if (Object.keys(relAST.related).length > 0) {
        this.#explainRelated(relAST, relPath, nodes)
      }
    }
  }

  #explainRelated(ast: QueryAST, path: string, nodes: ExplainNode[]): void {
    // Nested relations reuse the same walk minus the root handling.
    const relationships = this.schema?.relationships?.[ast.service] ?? {}
    for (const [relName, relAST] of Object.entries(ast.related)) {
      const relDef = relationships[relName]
      const relPath = `${path}.${relName}`
      const windowed = hasWindowFilters(relAST.query)
      const relExplained = explainQueryNode(relAST.query, {
        server: relAST.server,
        allPages: !windowed,
      })
      nodes.push({
        path: relPath,
        service: relDef?.destService ?? relName,
        kind: 'find',
        class: relExplained.class,
        reasons: relExplained.reasons,
        realtime: relExplained.class === 'local-exact' ? 'merge' : 'refetch',
        ...(relDef?.via ? { via: relDef.via.destService } : {}),
      })
      if (Object.keys(relAST.related).length > 0) {
        this.#explainRelated(relAST, relPath, nodes)
      }
    }
  }

  /**
   * Read-only snapshot of every query currently in the store — the stable projection
   * devtools should build on (internal store shapes stay free to change).
   */
  inspect(): InspectedQuery[] {
    const rows: InspectedQuery[] = []
    for (const [serviceName, service] of this.queryStore.getState()) {
      for (const query of service.queries.values()) {
        const q = (query.desc.params as { query?: Record<string, unknown> } | undefined)?.query
        const config = query.config as { server?: boolean; allPages?: boolean }
        rows.push({
          queryId: query.queryId,
          serviceName,
          method: query.desc.method,
          query: q,
          classification: query.desc.method === 'get' ? 'get' : classifyQueryNode(q, config),
          status: query.state.status,
          isFetching: query.state.isFetching,
          itemCount: Array.isArray(query.state.data)
            ? query.state.data.length
            : query.state.data
              ? 1
              : 0,
          fetchedAt: query.fetchedAt,
          subscriberCount: this.queryStore.getSubscriberCount(query.queryId),
        })
      }
    }
    return rows
  }

  /** Subscribe to any state changes within Figbird (across all queries/services). */
  subscribeToStateChanges(
    fn: (state: Map<string, ServiceState<AdapterFindMeta<A>>>) => void,
  ): () => void {
    return this.queryStore.subscribeToStateChanges(fn)
  }
}

/** One node of a `figbird.explain()` report. */
export interface ExplainNode {
  /** `'(root)'` or the dotted relation path (`'comments.reactions'`). */
  path: string
  service: string
  kind: 'find' | 'get' | 'paginate' | 'all'
  class: QueryNodeClass
  reasons: ClassificationReason[]
  /** How realtime events on this node's service are handled. */
  realtime: 'merge' | 'refetch' | 'manual'
  /** Junction service name for transparent two-hop relations. */
  via?: string
}

export interface ExplainReport {
  nodes: ExplainNode[]
}

/** One row of `figbird.inspect()` — a stable, read-only view of a live query. */
export interface InspectedQuery {
  queryId: string
  serviceName: string
  method: 'find' | 'get'
  query: Record<string, unknown> | undefined
  classification: QueryNodeClass | 'get'
  status: 'loading' | 'success' | 'error'
  isFetching: boolean
  itemCount: number
  fetchedAt: number | undefined
  subscriberCount: number
}
