import { trimAbandonedReads } from './abandonedReads.js'
import { systemClock, type Clock, type ClockTimer } from './clock.js'
import { explainQuery } from './relationPlan.js'
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
import { hashObject } from './hash.js'
import type { FigbirdEvents } from './events.js'
import { createMutationsProxy, type MutationsHost, type MutationsProxy } from './mutations.js'
import {
  MutationQueue,
  mutationQueueDefinitionConfig,
  type MutationQueueConfig,
  type MutationQueueDefinition,
  type MutationQueueHost,
} from './mutationQueue.js'
import type { MutationActivity } from './mutationTracker.js'
import {
  createQueryBuilderProxy,
  queryBuilderUsesSchema,
  type AnyQueryBuilder,
  type AnyWindowQueryBuilder,
  type QueryBuilderProxy,
  type QueryBuilderItem,
  type QueryBuilderResult,
} from './queryBuilder.js'
import { resolveQueryInput, type PreparedQuery, type QueryInput } from './queryDefinition.js'
import {
  explainQueryNode,
  isServerMaintained,
  type ClassificationReason,
  type ExplainReport,
  type QueryNodeClass,
} from './queryClassification.js'
export type { ExplainNode, ExplainReport } from './queryClassification.js'
import { QueryRef } from './queryRef.js'
import {
  DEFAULT_GC_TIME,
  DEFAULT_STALE_TIME,
  QueryStore,
  type DevtoolsCacheEditResult,
  type QueryFetchHistoryEntry,
  type ReconnectJitter,
  type RetryDelay,
  type VisibilitySource,
} from './queryStore.js'

export type {
  QueryFetchHistoryEntry,
  ReconnectJitter,
  RetryDelay,
  VisibilitySource,
} from './queryStore.js'
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
import { WindowQueryRef, type WindowQueryConfig } from './windowQuery.js'
export type { InspectedRelationalQuery } from './relationalQuery.js'
import type {
  AnySchema,
  Schema,
  ServiceDefinitionByPath,
  ServiceNames,
  ServicePaths,
} from './schema.js'
import { resolveServicePath } from './schema.js'
import { isWithinStaleTime, validatePrefetchStaleTime, validateStaleTime } from './staleTime.js'
import { createTransactionContext, type TransactionContext } from './transactions.js'

type DescriptorWriteProjection<TItem> =
  | {
      optimistic?: true
      optimisticPatch?: Partial<TItem>
    }
  | {
      optimistic: false | TItem
      optimisticPatch?: never
    }

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
  CreateMutationOptions,
  MethodArgs,
  MethodData,
  MutationCallOptions,
  MutationParamsOptions,
  MutationsHandle,
  MutationsProxy,
  WriteMutationOptions,
} from './mutations.js'
export type {
  TransactionContext,
  TransactionMutationsHandle,
  TransactionMutationsProxy,
} from './transactions.js'
export {
  defineMutationQueue,
  MutationQueueDiscardedError,
  MutationSupersededError,
  isMutationSupersededError,
} from './mutationQueue.js'
export type {
  MutationQueueConfig,
  MutationQueueDefinition,
  MutationQueueOperation,
  MutationQueueRetry,
  MutationQueueRetryDelay,
  MutationQueueSnapshot,
  MutationQueueStatus,
  MutationSchedule,
} from './mutationQueue.js'
export type { InFlightMutation, MutationActivity } from './mutationTracker.js'
export {
  defineQuery,
  isQueryDefinition,
  isQueryRequest,
  QUERY_DEFINITION_BRAND,
  QUERY_REQUEST_BRAND,
  QueryArgsError,
  validateQueryArgs,
} from './queryDefinition.js'
export type {
  DefineQuery,
  PreparedQuery,
  QueryDefinition,
  QueryInput,
  QueryRequest,
  StandardSchemaV1,
} from './queryDefinition.js'

/**
 * Query input with its result type intentionally erased for integration boundaries
 * such as router data adapters. Use `QueryInput<B, Args>` when preserving a specific
 * builder's result type matters.
 */
export type AnyQueryInput<S extends Schema = AnySchema> = QueryInput<AnyQueryBuilder<S>>

export { RelationalQueryRef } from './relationalQuery.js'
export type { RelationalPaginationState, RelationalQueryState } from './relationalQuery.js'

// Helper to specialize adapter params' `query` by service-level domain query
type ParamsWithServiceQuery<S extends Schema, P extends ServicePaths<S>, A extends Adapter> = Omit<
  AdapterParams<A>,
  'query'
> & { query?: ServiceDefinitionByPath<S, P>['query'] }

const KEYED_MUTATION_QUEUE_RETENTION_MS = 5 * 60_000

interface KeyedMutationQueueEntry<S extends Schema> {
  queue: MutationQueue<S>
  owners: number
  evictionTimer: ClockTimer | null
  unsubscribe: () => void
}

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
  queryStore: QueryStore<AdapterParams<A>, AdapterFindMeta<A>, AdapterQuery<A>>
  schema: S | undefined
  /** @internal Time source shared by the query and mutation engines. */
  readonly clock: Clock
  #staleTime: number
  #disposed = false
  #mutationQueues = new Set<MutationQueue<S>>()
  #unregisterDevtools: () => void

  // Cache of active RelationalQueryRef instances, keyed by AST hash. This is critical for
  // React 18 Suspense interop: on suspense retries React discards render-state (including
  // useMemo and useRef), so if we recreated a RelationalQueryRef per render the hook would
  // keep throwing fresh promises and loop. By interning refs here we guarantee the same
  // instance is returned to any consumer with the same query shape. An internal listener
  // count drives eviction — refs are removed from the cache when their last hook unmounts
  // (see RelationalQueryRef#cleanup).
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  #relationalQueryCache: Map<string, RelationalQueryRef<any, S, any, any, any>> = new Map()

  // Window refs are interned independently from ordinary relational refs because their
  // range is subscriber state rather than query identity. Multiple readers of the same
  // list share retained blocks while contributing their own visible ranges. Recently
  // settled render-phase reads stay warm for React's retry; an LRU bound prevents
  // abandoned reads for old query shapes from accumulating indefinitely.
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  #windowQueryCache: Map<string, WindowQueryRef<any, S, any, any, any>> = new Map()

  // Keyed mutation queues outlive individual React owners while work remains,
  // allowing a remounted feature to reconnect to its pending/error state.
  #keyedMutationQueues = new Map<MutationQueueDefinition, Map<string, KeyedMutationQueueEntry<S>>>()

  /**
   * Create a Figbird instance.
   * @param adapter Data adapter (e.g. FeathersAdapter)
   * @param eventBatchInterval Optional interval (ms) for batching realtime events
   * @param schema Optional schema to enable full TypeScript inference
   * @param staleTime Default age (ms) for reusing successful data without a
   *   mount-time revalidation. Defaults to 5 minutes; readers can override it.
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
    staleTime = DEFAULT_STALE_TIME,
    gcTime = DEFAULT_GC_TIME,
    reconcileCooldown,
    retry,
    retryDelay,
    reconnectJitter,
    visibility,
    defaultSort,
    clock = systemClock,
  }: {
    adapter: A
    eventBatchInterval?: number
    schema?: S
    staleTime?: number
    /** Idle cache retention in ms. Defaults to thirty minutes; Infinity disables eviction. */
    gcTime?: number
    reconcileCooldown?: number
    retry?: number | false
    retryDelay?: RetryDelay
    reconnectJitter?: ReconnectJitter
    visibility?: VisibilitySource
    defaultSort?: Record<string, 1 | -1>
    /** @internal Deterministic policy time for tests. */
    clock?: Clock
  }) {
    staleTime = validateStaleTime(staleTime, 'Figbird(): staleTime')
    this.clock = clock
    this.adapter = adapter
    this.schema = schema
    this.#staleTime = staleTime
    this.queryStore = new QueryStore<AdapterParams<A>, AdapterFindMeta<A>, AdapterQuery<A>>({
      adapter,
      clock,
      eventBatchInterval,
      staleTime,
      gcTime,
      ...(reconcileCooldown !== undefined ? { reconcileCooldown } : {}),
      ...(retry !== undefined ? { retry } : {}),
      ...(retryDelay !== undefined ? { retryDelay } : {}),
      ...(reconnectJitter !== undefined ? { reconnectJitter } : {}),
      ...(visibility !== undefined ? { visibility } : {}),
      ...(defaultSort !== undefined ? { defaultSort } : {}),
    })
    this.#unregisterDevtools = registerDevtoolsInstance(this)
  }

  /** Release this instance after unmounting its readers. Registered writes finish normally. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const prefetch of this.#prefetches.values()) {
      prefetch.timer.cancel()
      prefetch.release()
    }
    this.#prefetches.clear()
    for (const ref of this.#windowQueryCache.values()) ref.dispose()
    for (const ref of this.#relationalQueryCache.values()) ref.dispose()
    this.#windowQueryCache.clear()
    this.#relationalQueryCache.clear()
    for (const queues of this.#keyedMutationQueues.values()) {
      for (const entry of queues.values()) {
        if (entry.evictionTimer) entry.evictionTimer.cancel()
        entry.unsubscribe()
      }
    }
    this.#keyedMutationQueues.clear()
    for (const queue of this.#mutationQueues) queue.detach()
    this.#mutationQueues.clear()
    this.#unregisterDevtools()
    this.queryStore.dispose()
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
   * Returns the entire internal state map keyed by service name — including cached
   * entities that are not part of a current query result. Debug-grade: internal
   * shapes may change between versions; prefer `inspect()` for anything built to
   * last.
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
   * const data = useQuery(issues)
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
   * `useQuery`. Accepts a builder, a bound request, or an argumentless definition. The returned
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
   * // Bound request form — same cache entry as useQuery(issueDetail({ id: 42 }))
   * const ref = figbird.query(issueDetail({ id: 42 }))
   * ```
   */
  query<Args, B extends AnyQueryBuilder<S>>(
    queryOrBuilder: QueryInput<B, Args>,
  ): RelationalQueryRef<
    QueryBuilderResult<B>,
    S,
    AdapterParams<A>,
    AdapterFindMeta<A>,
    AdapterQuery<A>
  > {
    this.queryStore.assertActive()
    type T = QueryBuilderResult<B>
    if (!this.schema) {
      throw new Error(
        'Cannot use relational queries without a schema. ' +
          'Pass schema to Figbird constructor: new Figbird({ schema, adapter })',
      )
    }
    const { builder, name } = resolveQueryInput(queryOrBuilder)
    if (!queryBuilderUsesSchema(builder, this.schema)) {
      throw new Error('The query builder uses a different schema from this Figbird instance')
    }
    const hash = builder.hash()
    const cached = this.#relationalQueryCache.get(hash)
    let ref = cached as
      | RelationalQueryRef<T, S, AdapterParams<A>, AdapterFindMeta<A>, AdapterQuery<A>>
      | undefined
    if (ref) {
      this.#relationalQueryCache.delete(hash)
      this.#relationalQueryCache.set(hash, ref)
      trimAbandonedReads(this.#relationalQueryCache, ref)
    } else {
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
        {
          defaultStaleTime: this.#staleTime,
          onIdle: () => trimAbandonedReads(this.#relationalQueryCache, ref),
        },
      )
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
      this.#relationalQueryCache.set(hash, ref as RelationalQueryRef<any, S, any, any, any>)
      trimAbandonedReads(this.#relationalQueryCache, ref)
    }
    ref.setDisplayName(name)
    return ref
  }

  /**
   * Materialize a viewport-indexed relational query. The builder describes list
   * identity (filters, ordering, relations); the hook supplies each reader's range.
   * Offset services address blocks directly, while native cursor services retain
   * index checkpoints and advance only as far as required.
   */
  window<Args, B extends AnyWindowQueryBuilder<S>>(
    queryOrBuilder: QueryInput<B, Args>,
    config: WindowQueryConfig,
  ): WindowQueryRef<QueryBuilderItem<B>, S, AdapterParams<A>, AdapterFindMeta<A>, AdapterQuery<A>> {
    this.queryStore.assertActive()
    type T = QueryBuilderItem<B>
    if (!this.schema) {
      throw new Error(
        'Cannot use window queries without a schema. ' +
          'Pass schema to Figbird constructor: new Figbird({ schema, adapter })',
      )
    }
    const { builder, name } = resolveQueryInput(queryOrBuilder)
    if (!queryBuilderUsesSchema(builder, this.schema)) {
      throw new Error('The query builder uses a different schema from this Figbird instance')
    }
    const ast = builder.toAST()
    if (ast.kind !== 'find' || ast.cardinality !== 'many') {
      throw new Error('useWindowQuery() requires a list-producing find builder')
    }
    if (ast.query.$limit !== undefined || ast.query.$skip !== undefined) {
      throw new Error('useWindowQuery() owns $limit/$skip; remove .limit() and .skip()')
    }

    const hash = hashObject({ ast, window: config })
    const cached = this.#windowQueryCache.get(hash)
    let ref = cached as
      | WindowQueryRef<T, S, AdapterParams<A>, AdapterFindMeta<A>, AdapterQuery<A>>
      | undefined
    if (ref) {
      // Map insertion order is the LRU order. A Suspense retry therefore protects
      // the ref it is actively trying to commit.
      this.#windowQueryCache.delete(hash)
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
      this.#windowQueryCache.set(hash, ref as WindowQueryRef<any, S, any, any, any>)
      trimAbandonedReads(this.#windowQueryCache, ref)
    } else {
      ref = new WindowQueryRef<T, S, AdapterParams<A>, AdapterFindMeta<A>, AdapterQuery<A>>(
        this,
        ast,
        this.schema,
        config,
        {
          defaultStaleTime: this.#staleTime,
          onEvict: () => {
            if (this.#windowQueryCache.get(hash) === ref) this.#windowQueryCache.delete(hash)
          },
          onIdle: () => trimAbandonedReads(this.#windowQueryCache, ref),
        },
      )
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
      this.#windowQueryCache.set(hash, ref as WindowQueryRef<any, S, any, any, any>)
      trimAbandonedReads(this.#windowQueryCache, ref)
    }
    ref.setDisplayName(name)
    return ref
  }

  /**
   * Pre-warm a query before any component reads it. Returns a `PreparedQuery` handle whose
   * `promise` resolves when the same `useQuery(request)` would have data ready and
   * rejects with the error a Suspense read would throw. Holds the cache entry alive until
   * `release()` is called or the underlying ref's last subscriber unmounts.
   *
   * Designed for router preparation, hover prefetch, and parents that can see child needs
   * earlier than the child itself. The component still reads via `useQuery(request)` —
   * preparation is an earlier read, not a different read. Keep the handle active through
   * the destination's first subscriber commit. That subscriber wave adopts the prepared
   * result without revalidation; retaining the handle longer only keeps the query pinned.
   * An active prefetch can be adopted by one preparation, even with a zero instance
   * staleTime. An explicit preparation staleTime overrides this handover.
   *
   * @example
   * ```ts
   * // routes.ts — router metadata (like a priority) is attached by the app
   * defineRoute({
   *   path: '/issues/:id',
   *   resolver: () => import('./pages/IssueDetail/screen'),
   *   prepare: ({ figbird, params }) => [
   *     { ...figbird.prepare(issueDetail({ id: Number(params.id) })), priority: 'route' },
   *   ],
   * })
   * ```
   */
  prepare<Args, B extends AnyQueryBuilder<S>>(
    query: QueryInput<B, Args>,
    options?: { staleTime?: number },
  ): PreparedQuery {
    const staleTime =
      options?.staleTime === undefined
        ? undefined
        : validateStaleTime(options.staleTime, 'prepare(): staleTime')
    const ref = this.query(query)
    // No-op listener — purely a pin. The promise drives readiness; release() drops the pin.
    // While pinned, subsequent useQuery subscribers join the same ref. When everyone has
    // released and unsubscribed, RelationalQueryRef cleans up and evicts the cache entry.
    // A staleTime skips the SWR revalidation when the data is already fresh enough.
    const release = ref.subscribe(() => {}, {
      ...(staleTime === undefined ? {} : { staleTime }),
      source: 'prepare',
    })
    return {
      key: ref.hash(),
      promise: ref.suspensePromise(),
      release,
    }
  }

  // Active speculative pins, keyed by query hash (see prefetch()).
  #prefetches: Map<string, { at: number; release: () => void; timer: ClockTimer }> = new Map()

  /**
   * Speculatively warm a query — the idempotent, fire-and-forget sibling of `prepare()`.
   *
   * Safe to call at any frequency (hover, viewport entry, likely-next): if the same
   * query was prefetched within `staleTime`, the call is a no-op. Otherwise the query
   * is materialized and held alive by an internal pin that auto-releases after
   * `staleTime` — the fetched data stays in the QueryStore either way, so a later
   * `useQuery` gets a warm synchronous read. If a component subscribes in the
   * meantime, its own subscription keeps the query alive past the pin.
   * Because the pin must release itself, `staleTime` must be finite for prefetches.
   *
   * Use `prepare()` instead when you need to await readiness or control the lease
   * explicitly (router navigation).
   *
   * @example
   * ```ts
   * <Row onMouseEnter={() => figbird.prefetch(issueDetail({ id: issue.id }))} />
   * ```
   */
  prefetch<Args, B extends AnyQueryBuilder<S>>(
    query: QueryInput<B, Args>,
    options?: { staleTime?: number },
  ): void {
    const staleTime = validatePrefetchStaleTime(options?.staleTime ?? 30_000)
    const ref = this.query(query)
    const hash = ref.hash()

    const now = this.clock.now()
    const existing = this.#prefetches.get(hash)
    if (existing && isWithinStaleTime(existing.at, staleTime, now)) return
    if (existing) {
      existing.timer.cancel()
      existing.release()
      this.#prefetches.delete(hash)
    }

    // The pin also carries the staleTime so a warm-in-store read within the window
    // skips the SWR revalidation instead of re-fetching.
    const release = ref.subscribe(() => {}, { staleTime, source: 'prefetch' })
    const timer = this.clock.setTimeout(() => {
      this.#prefetches.delete(hash)
      release()
    }, staleTime)
    // Never keep a Node process alive for a speculative pin (browsers ignore this).
    timer.unref()
    this.#prefetches.set(hash, { at: now, release, timer })
  }

  // Descriptor layer — the primitive the relational engine (and the deprecated
  // useFind/useGet path) is built on. Speaks plain `{ serviceName, method }`
  // descriptors in the transport-path namespace and requires no schema.
  // Prefer `figbird.query(builder)` in app code.

  // Strongly-typed overloads for inference from serviceName and method
  /** Create a typed `find` query reference from a descriptor. */
  queryDesc<P extends ServicePaths<S>>(
    desc: { serviceName: P; method: 'find'; params?: ParamsWithServiceQuery<S, P, A> },
    config?: QueryConfig<
      ServiceDefinitionByPath<S, P>['item'][],
      ServiceDefinitionByPath<S, P>['query']
    >,
  ): QueryRef<
    ServiceDefinitionByPath<S, P>['item'][],
    ServiceDefinitionByPath<S, P>['query'],
    AdapterFindMeta<A>
  >
  /** Create a typed `get` query reference from a descriptor. */
  queryDesc<P extends ServicePaths<S>>(
    desc: {
      serviceName: P
      method: 'get'
      resourceId: string | number
      params?: ParamsWithServiceQuery<S, P, A>
    },
    config?: QueryConfig<
      ServiceDefinitionByPath<S, P>['item'],
      ServiceDefinitionByPath<S, P>['query']
    >,
  ): QueryRef<
    ServiceDefinitionByPath<S, P>['item'],
    ServiceDefinitionByPath<S, P>['query'],
    AdapterFindMeta<A>
  >
  // Generic fallback overload (for dynamic descriptors)
  queryDesc<D extends QueryDescriptor>(
    desc: D,
    config?: QueryConfig<InferQueryData<S, D>, AdapterQuery<A>>,
  ): QueryRef<InferQueryData<S, D>, AdapterQuery<A>, AdapterFindMeta<A>>
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
    return new QueryRef<unknown, unknown, AdapterFindMeta<A>>({
      desc: desc as QueryDescriptor,
      config: normalizeQueryConfig(config),
      queryStore: this.queryStore,
    })
  }

  // Descriptor layer, write side — the primitive `m` is built on. Speaks plain
  // `{ serviceName, method, id, data }` descriptors and requires no schema.
  // Prefer `figbird.m` in app code.

  // Strongly-typed mutation overloads

  /** Create a single new item. */
  mutateDesc<P extends ServicePaths<S>>(desc: {
    serviceName: P
    method: 'create'
    data: ServiceDefinitionByPath<S, P>['create']
    params?: AdapterParams<A>
    optimistic?: boolean | ServiceDefinitionByPath<S, P>['item']
  }): Promise<ServiceDefinitionByPath<S, P>['item']>

  /** Create multiple new items (batch). */
  mutateDesc<P extends ServicePaths<S>>(desc: {
    serviceName: P
    method: 'create'
    data: ServiceDefinitionByPath<S, P>['create'][]
    params?: AdapterParams<A>
    optimistic?: boolean | ServiceDefinitionByPath<S, P>['item'][]
  }): Promise<ServiceDefinitionByPath<S, P>['item'][]>

  /** Update an existing item by ID (full replacement). */
  mutateDesc<P extends ServicePaths<S>>(
    desc: {
      serviceName: P
      method: 'update'
      id: string | number
      data: ServiceDefinitionByPath<S, P>['update']
      params?: AdapterParams<A>
    } & DescriptorWriteProjection<ServiceDefinitionByPath<S, P>['item']>,
  ): Promise<ServiceDefinitionByPath<S, P>['item']>

  /** Patch an existing item by ID (partial update). */
  mutateDesc<P extends ServicePaths<S>>(
    desc: {
      serviceName: P
      method: 'patch'
      id: string | number
      data: ServiceDefinitionByPath<S, P>['patch']
      params?: AdapterParams<A>
    } & DescriptorWriteProjection<ServiceDefinitionByPath<S, P>['item']>,
  ): Promise<ServiceDefinitionByPath<S, P>['item']>

  /** Remove an item by ID. */
  mutateDesc<P extends ServicePaths<S>>(desc: {
    serviceName: P
    method: 'remove'
    id: string | number
    params?: AdapterParams<A>
    optimistic?: boolean
  }): Promise<ServiceDefinitionByPath<S, P>['item']>

  // Implementation
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  mutateDesc(desc: MutationDescriptor): Promise<any> {
    return this.queryStore.mutate(desc)
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
  call(servicePath: string, method: string, ...args: unknown[]): Promise<unknown> {
    return this.queryStore.call(servicePath, method, args)
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
   * Atomically commit several typed CRUD mutations through the configured
   * adapter. The callback is a synchronous collector: its calls project as one
   * cache update, wait for affected record lanes, and execute in collection
   * order within one server transaction. Generate create ids before collecting.
   * No sequential-request fallback is provided.
   */
  transaction(collect: (transaction: TransactionContext<S>) => undefined): Promise<void> {
    if (!this.queryStore.supportsTransactions) {
      throw new Error('figbird: the configured adapter does not support transactions')
    }
    const transaction = createTransactionContext<S>()
    let returned: unknown
    try {
      returned = collect(transaction.context)
    } catch (error) {
      // Close on failure too, so a leaked handle cannot append work later.
      transaction.close()
      throw error
    }
    if (
      returned !== null &&
      (typeof returned === 'object' || typeof returned === 'function') &&
      'then' in returned &&
      typeof (returned as { then?: unknown }).then === 'function'
    ) {
      transaction.close()
      // The callback may continue after its first await and hit the closed
      // collector. Observe that misuse promise so it cannot become unhandled.
      void Promise.resolve(returned).catch(() => {})
      throw new Error('figbird: transaction callbacks must be synchronous')
    }
    const descs = transaction.close().map(desc => ({
      ...desc,
      serviceName: resolveServicePath(this.schema, desc.serviceName),
    }))
    return this.queryStore.transaction(descs)
  }

  /**
   * Create an explicitly owned serial mutation queue. Calls made through the
   * queue's `m` proxy project immediately, preserve queue order across records,
   * and still share Figbird's global per-record mutation lanes with ordinary
   * `figbird.m` calls.
   */
  createMutationQueue(config: MutationQueueConfig = {}): MutationQueue<S> {
    return this.#createMutationQueue(config)
  }

  #createMutationQueue(config: MutationQueueConfig): MutationQueue<S> {
    this.queryStore.assertActive()
    const host: MutationQueueHost = {
      registerMutation: (desc, control) => {
        const resolve = (value: MutationDescriptor): MutationDescriptor => ({
          ...value,
          serviceName: resolveServicePath(this.schema, value.serviceName),
        })
        const registration = this.queryStore.registerMutation(resolve(desc), control)
        return {
          promise: registration.promise,
          tryUpdate: next => registration.tryUpdate(resolve(next)),
          cancel: error => registration.cancel(error),
        }
      },
      registerCall: (serviceName, method, args, control) =>
        this.queryStore.registerCall(
          resolveServicePath(this.schema, serviceName),
          method,
          args,
          control,
        ),
    }
    const queue = new MutationQueue<S>(host, config, this.clock)
    queue.subscribe(() => {
      if (queue.pending > 0 && !this.#disposed) this.#mutationQueues.add(queue)
      else this.#mutationQueues.delete(queue)
    })
    return queue
  }

  /** Return one reconnectable instance of an immutable queue definition. @internal */
  getMutationQueue(definition: MutationQueueDefinition, key: string): MutationQueue<S> {
    this.queryStore.assertActive()
    if (key.length === 0) throw new Error('figbird: mutation queue key must not be empty')
    let queues = this.#keyedMutationQueues.get(definition)
    const existing = queues?.get(key)
    if (existing) return existing.queue

    const queue = this.createMutationQueue(mutationQueueDefinitionConfig(definition))
    const entry = {
      queue,
      owners: 0,
      evictionTimer: null as ClockTimer | null,
      unsubscribe: () => {},
    }
    entry.unsubscribe = queue.subscribe(() => {
      if (entry.owners === 0 && queue.status === 'idle') {
        this.#evictMutationQueue(definition, key, entry)
      }
    })
    if (!queues) {
      queues = new Map()
      this.#keyedMutationQueues.set(definition, queues)
    }
    queues.set(key, entry)
    this.#scheduleMutationQueueEviction(definition, key, entry)
    return queue
  }

  /** Retain a keyed queue for one committed React owner. @internal */
  retainMutationQueue(
    definition: MutationQueueDefinition,
    key: string,
    queue: MutationQueue<S>,
  ): () => void {
    const entry = this.#keyedMutationQueues.get(definition)?.get(key)
    if (!entry || entry.queue !== queue) {
      throw new Error(`figbird: mutation queue "${key}" is no longer registered`)
    }
    entry.owners += 1
    if (entry.evictionTimer) entry.evictionTimer.cancel()
    entry.evictionTimer = null

    let released = false
    return () => {
      if (released) return
      released = true
      entry.owners = Math.max(0, entry.owners - 1)
      queueMicrotask(() => {
        if (entry.owners > 0 || this.#keyedMutationQueues.get(definition)?.get(key) !== entry)
          return
        if (entry.queue.status === 'idle') this.#evictMutationQueue(definition, key, entry)
        else this.#scheduleMutationQueueEviction(definition, key, entry)
      })
    }
  }

  #scheduleMutationQueueEviction(
    definition: MutationQueueDefinition,
    key: string,
    entry: KeyedMutationQueueEntry<S>,
  ): void {
    if (entry.evictionTimer) entry.evictionTimer.cancel()
    entry.evictionTimer = this.clock.setTimeout(
      () => this.#evictMutationQueue(definition, key, entry),
      KEYED_MUTATION_QUEUE_RETENTION_MS,
    )
    entry.evictionTimer.unref()
  }

  #evictMutationQueue(
    definition: MutationQueueDefinition,
    key: string,
    entry: KeyedMutationQueueEntry<S>,
  ): void {
    const queues = this.#keyedMutationQueues.get(definition)
    if (entry.owners > 0 || queues?.get(key) !== entry) return
    if (entry.evictionTimer) entry.evictionTimer.cancel()
    entry.unsubscribe()
    queues.delete(key)
    if (queues.size === 0) this.#keyedMutationQueues.delete(definition)
    if (entry.queue.status !== 'idle') entry.queue.detach()
  }

  /**
   * Live view of active mutations, including scheduled queue work (CRUD and
   * custom methods). Synchronously maintained — correct even for subscribers — and
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
  explain<Args, B extends AnyQueryBuilder<S>>(queryOrBuilder: QueryInput<B, Args>): ExplainReport {
    // Resolved without interning — explain never materializes a query. The walk
    // itself consumes the compiled relation plan used by query execution.
    const { builder } = resolveQueryInput(queryOrBuilder)
    const nodes = explainQuery(
      builder.toAST(),
      this.schema ?? { services: {} },
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
        const explanation =
          query.desc.method === 'find'
            ? explainQueryNode(q, {
                server: query.config.server,
                allPages: 'allPages' in query.config && query.config.allPages === true,
                localOperators: locallySupportedOperators(this.adapter, serviceName),
                snapshot: query.config.realtime === 'disabled',
              })
            : null
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
          classification: query.maintenance.classification,
          classificationReasons: explanation?.reasons ?? [],
          realtimeStrategy:
            query.config.realtime === 'disabled'
              ? 'manual'
              : query.config.realtime === 'refetch' ||
                  isServerMaintained(query.maintenance.classification)
                ? 'refetch'
                : 'merge',
          skipped: query.config.skip === true,
          status: query.state.status,
          isFetching: query.state.isFetching,
          data: query.state.data,
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
          fetchHistory: stats?.history ?? [],
        })
      }
    }
    return rows
  }

  /** Read-only normalized entity-cache projection for attached devtools. */
  inspectCache(): InspectedCacheService[] {
    return [...this.queryStore.getState()].map(([serviceName, service]) => ({
      serviceName,
      ...(service.materialized ? { materialized: service.materialized } : {}),
      entities: [...service.entities].map(([id, value]) => ({
        id,
        value,
        queryIds: [...(service.itemQueryIndex.get(id) ?? [])],
      })),
    }))
  }

  /** @internal Browser-devtools command; changes only the in-memory cache. */
  editCacheEntity(
    serviceName: string,
    itemId: string | number,
    item: unknown,
  ): DevtoolsCacheEditResult {
    return this.queryStore.editCacheEntity(serviceName, itemId, item)
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
  classificationReasons?: ClassificationReason[]
  realtimeStrategy?: 'merge' | 'refetch' | 'manual'
  /** True when this entry was materialized with `skip: true`. */
  skipped?: boolean
  status: 'loading' | 'success' | 'error'
  isFetching: boolean
  /** Current result for this query. Debug-only and safe to inspect, not mutate. */
  data?: unknown
  itemCount: number
  fetchedAt: number | undefined
  subscriberCount: number
  fetchCount: number
  errorCount: number
  lastDurationMs?: number
  totalDurationMs: number
  /** Bounded, payload-free latency history used by attached developer tools. */
  fetchHistory?: readonly QueryFetchHistoryEntry[]
}

export interface InspectedCacheEntity {
  id: string
  value: unknown
  queryIds: string[]
}

export interface InspectedCacheService {
  serviceName: string
  materialized?: { queryId: string; fetchedAt: number }
  entities: InspectedCacheEntity[]
}
