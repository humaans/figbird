import { ReconcileScheduler } from './reconcileScheduler.js'
import { commitQuery, deleteQuery } from './queryResults.js'
import { QueryRetention } from './queryRetention.js'
import {
  locallySupportedOperators,
  type Adapter,
  type AdapterTransactionOperation,
  type PageResponse,
  type QueryResponse,
} from '../adapters/adapter.js'
import type { AnySchema, Schema } from './schema.js'
import type { QueryRef } from './queryRef.js'
import { isEphemeralQuery } from './queryIdentity.js'
import { type FigbirdEventEmitter, type FetchReason, type TraceCause } from './events.js'
import { QueryTelemetry } from './queryTelemetry.js'
import { MutationTracker } from './mutationTracker.js'
import { GatedMutationAttempt } from './gatedMutationAttempt.js'
import {
  MutationSupersededError,
  type RegisteredMutation,
  type ScheduledMutationControl,
} from './mutationQueue.js'
import { sortRowsLocally } from './sort.js'
import {
  FetchEventJournal,
  planFetchRebase,
  rebaseResponseData,
  type FetchResponseMode,
} from './fetchRebase.js'
import {
  ABSENT,
  MUTATION_EVENT_TYPE,
  MutationLanes,
  type LaneSettlement,
  type MutationLane,
  type MutationOutcome,
  type ProjectionChange,
} from './mutationLanes.js'
import {
  applyEventsToService,
  applyVisibleEventToQuery,
  createServiceState,
  diffCompleteSet,
  groupEventsByService,
  isUnfilteredFindQuery,
  replayFetchedQueryFromEvents,
  reapplyQueryFromEntities,
  splitWindow,
  updateQueriesFromEvents,
} from './windowMaintenance.js'
import {
  classifyStoredQuery,
  isProjectionQuery,
  isServerMaintained,
  type StoredQueryClass,
} from './queryClassification.js'
import {
  entityKey,
  queryOfParams,
  type ElementType,
  type CreateMutationDescriptor,
  type Event,
  type FindQueryConfig,
  type GetQueryConfig,
  type InferMutationData,
  type ItemId,
  type ItemMatcher,
  type MutationDescriptor,
  type ProcessedProjectionEvent,
  type ProcessedCacheEvent,
  type Query,
  type QueryConfig,
  type QueryDescriptor,
  type QueryExecutionOptions,
  type QueryGraphRef,
  type QueryState,
  type QueuedEvent,
  type ServiceState,
} from './queryTypes.js'
import { defaultRetryDelay, resolveRetryDelay } from './retryDelay.js'
import { normalizeError } from './errors.js'
import { isWithinStaleTime } from './staleTime.js'
import { sameValue } from './valueEquality.js'

/**
 * Where the store learns whether the tab is visible. Injectable for tests and
 * non-browser environments; the default reads `document.visibilityState`.
 */
export interface VisibilitySource {
  isHidden(): boolean
  /** Notify on visibility changes. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void
}

/** Random reconnect delay in ms. A number means `[0, number]`; `0` disables jitter. */
export type ReconnectJitter = number | readonly [number, number]

/** Delay before a retry. `attempt` is one-based: 1 is the first retry. */
export type RetryDelay = number | ((attempt: number, error: Error) => number)

type FetchAttemptOutcome =
  | { kind: 'completed' }
  | { kind: 'stale' }
  | { kind: 'failed'; error: Error }

const DEFAULT_RETRIES = 3

type StoreResponse<TMeta> =
  | QueryResponse<unknown, TMeta | undefined>
  | PageResponse<unknown[], TMeta>

type MutationTraceCause = Extract<TraceCause, { kind: 'mutation' }> & { mutationId: number }

interface MutationTrackingContext {
  mutationId: number
  cause?: MutationTraceCause
}

function resolveCreateOptimisticItem(desc: CreateMutationDescriptor): unknown {
  const { optimistic } = desc
  return optimistic == null || typeof optimistic === 'boolean' ? desc.data : optimistic
}

interface MutationTrackingEntry {
  serviceName: string
  method: string
  id?: string | number
  optimistic: boolean
  args: readonly unknown[]
}

interface MutationTrackingHooks<T> {
  onSuccess?: (result: T, context: MutationTrackingContext) => void
  onError?: (error: Error, context: MutationTrackingContext) => void
}

interface TrackedMutation<T> {
  mutationId: number
  cause?: MutationTraceCause
  promise: Promise<T>
}

interface QueuedMutation {
  desc: MutationDescriptor
  args: unknown[]
  optimistic: boolean
  attempt: GatedMutationAttempt
  cause?: MutationTraceCause
  transaction?: QueuedTransaction
}

interface QueuedTransaction {
  entries: Array<{ lane: MutationLane; entry: QueuedMutation }>
  readyLaneKeys: Set<string>
  status: 'waiting' | 'running' | 'settled' | 'aborted'
}

interface AppliedEventEffect {
  event: ProcessedCacheEvent
  reconcileQueryIds: Set<string>
  queryEffects?: Map<string, 'merged' | 'reconcile'>
}

interface PublishedEventEffects {
  reconcileQueryIds: Set<string>
  reconcileCauses: Map<string, TraceCause[]>
}

interface FetchContext {
  reason: Exclude<FetchReason, 'retry'>
  causes?: TraceCause[]
  graph?: QueryGraphRef[]
}

type LaneAuthoritativeAcceptance =
  | { handled: false }
  | { handled: true; projection: ProjectionChange | null }

export interface QueryFetchStats {
  fetchCount: number
  errorCount: number
  lastDurationMs?: number
  totalDurationMs: number
  history: QueryFetchHistoryEntry[]
}

export interface QueryFetchHistoryEntry {
  fetchId: number
  startedAt: number
  durationMs: number
  ok: boolean
  reason: FetchReason
}

export const QUERY_FETCH_HISTORY_LIMIT = 50
export const DEFAULT_STALE_TIME = 5 * 60_000
export const DEFAULT_GC_TIME = 30 * 60_000

export interface DevtoolsCacheEditResult {
  ok: boolean
  error?: string
  traceId?: number
}

function documentVisibility(): VisibilitySource {
  return {
    isHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
    onChange: listener => {
      if (typeof document === 'undefined') return () => {}
      document.addEventListener('visibilitychange', listener)
      return () => document.removeEventListener('visibilitychange', listener)
    },
  }
}

/**
 * Internal query store managing entities, queries, and subscriptions.
 */
export class QueryStore<
  S extends Schema = AnySchema,
  TParams = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TQuery = Record<string, unknown>,
> {
  #adapter: Adapter<TParams, TMeta, TQuery>
  #telemetry: QueryTelemetry
  #mutations: MutationTracker

  #realtime = new Map<string, () => void>()
  #connectionUnsub: (() => void) | undefined
  #visibilityUnsub: () => void
  #retention: QueryRetention
  #disposed = false
  #retryWaits = new Set<() => void>()
  #dependencyOwners = new Map<string, number>()
  #listeners: Map<string, Set<(state: QueryState<unknown, TMeta>) => void>> = new Map()
  #globalListeners: Set<(state: Map<string, ServiceState<TMeta>>) => void> = new Set()
  #processedEventListeners: Set<(event: ProcessedCacheEvent) => void> = new Set()
  #projectionSettlementListeners: Set<(event: ProcessedProjectionEvent) => void> = new Set()

  #state: Map<string, ServiceState<TMeta>> = new Map()
  #serviceNamesByQueryId: Map<string, string> = new Map()
  #queryGenerations: Map<string, number> = new Map()
  #queryStats: Map<string, QueryFetchStats> = new Map()
  #nextQueryGeneration = 1
  #followupFetchContexts = new Map<string, FetchContext>()

  #fetchEventJournal = new FetchEventJournal()
  #mutationLanes: MutationLanes<QueuedMutation>

  // Scheduling owns pending work; query snapshots retain its diagnostic pending flag.
  #reconciliation: ReconcileScheduler
  #staleTime: number
  #visibility: VisibilitySource
  #hiddenAt: number | null

  #defaultSort: Record<string, number> | undefined
  #retry: number | false
  #retryDelay: RetryDelay
  #reconnectJitter: readonly [number, number]
  #reconnectSweepTimer: ReturnType<typeof setTimeout> | null = null
  #reconnectQueryIds: Set<string> = new Set()
  #warnedMissingIdServices: Set<string> = new Set()

  #eventQueue: QueuedEvent[] = []
  // Lane bases already contain these acknowledgements; only query publication remains.
  #appliedEventQueue: ProcessedCacheEvent[] = []
  #eventBatchProcessingTimer: ReturnType<typeof setTimeout> | null = null
  #eventBatchInterval: number | undefined = 100
  #processingEventQueue = false
  // Query ids whose listener notification has been deferred to the next microtask
  // (see #scheduleDeferredNotify). Null when nothing is scheduled.
  #deferredNotifyQueryIds: Set<string> | null = null

  constructor({
    adapter,
    eventBatchInterval = 100,
    staleTime = DEFAULT_STALE_TIME,
    gcTime = DEFAULT_GC_TIME,
    reconcileCooldown = 2000,
    retry = DEFAULT_RETRIES,
    retryDelay = defaultRetryDelay,
    reconnectJitter = [0, 3000],
    visibility,
    defaultSort,
  }: {
    adapter: Adapter<TParams, TMeta, TQuery>
    eventBatchInterval?: number | undefined
    /** Default age (ms) for skipping mount-time revalidation. */
    staleTime?: number
    gcTime?: number
    /**
     * Minimum interval (ms) between event-driven refetches of one query — burst
     * safety for server-window/server-authoritative reconciliation. The first
     * event refetches immediately (leading edge); further events within the
     * window coalesce into one guaranteed trailing refetch. `0` disables.
     */
    reconcileCooldown?: number
    /** Failed fetches to retry. Defaults to 3; `false` disables retries. */
    retry?: number | false
    /** Fixed or computed delay before each retry. Defaults to 1s, 2s, 4s, capped at 30s. */
    retryDelay?: RetryDelay
    /** Random delay before reconnect sweeps. A number means `[0, number]`; `0` disables. */
    reconnectJitter?: ReconnectJitter
    /** Visibility source for hidden-tab gating. Defaults to `document`. */
    visibility?: VisibilitySource
    /**
     * The backend's implicit ordering for queries without `$sort` (e.g.
     * `{ createdAt: -1, id: -1 }`). Lets window maintenance place realtime items
     * into unsorted windows locally instead of refetching. Must mirror the
     * server's actual default order — divergence shows up as misplaced rows
     * until the next fetch.
     */
    defaultSort?: Record<string, number>
  }) {
    this.#retention = new QueryRetention(gcTime, queryId => {
      const serviceName = this.#serviceNamesByQueryId.get(queryId)
      if (
        this.#listenerCount(queryId) > 0 ||
        (serviceName !== undefined &&
          this.#state.get(serviceName)?.materialized?.queryId === queryId)
      )
        return
      this.#vacuum({ queryId })
    })
    this.#adapter = adapter
    this.#mutationLanes = new MutationLanes(item => this.#peekId(item))
    this.#defaultSort = defaultSort
    this.#eventBatchInterval = eventBatchInterval
    this.#telemetry = new QueryTelemetry()
    this.#mutations = new MutationTracker()
    this.#reconciliation = new ReconcileScheduler(reconcileCooldown, {
      prepare: (queryId, force) => this.#prepareReconcile(queryId, force),
      fetch: (queryId, causes) => {
        this.#emitReconcileStarted(queryId, causes)
        this.refetch(queryId, { reason: 'reconcile', ...(causes ? { causes: [...causes] } : {}) })
      },
      pendingChanged: (queryId, pending) => {
        this.#transactOverService(queryId, (service, query) => {
          if (query) commitQuery(service, { ...query, pending })
        })
      },
      decision: (queryId, decision, causes) =>
        this.#emitReconcileDecision(queryId, decision, causes),
      merge: (left, right) => this.#telemetry.merge(left, right),
    })
    this.#staleTime = staleTime
    this.#retry = this.#normalizeRetry(retry)
    this.#retryDelay = retryDelay
    this.#reconnectJitter = this.#normalizeReconnectJitter(reconnectJitter)
    this.#visibility = visibility ?? documentVisibility()
    this.#hiddenAt = this.#visibility.isHidden() ? Date.now() : null
    this.#visibilityUnsub = this.#visibility.onChange(() => this.#visibilityChanged())
    if (this.#adapter.subscribeToConnectionEvents) {
      this.#connectionUnsub = this.#adapter.subscribeToConnectionEvents(event => {
        const traceId = this.#telemetry.nextTraceId()
        switch (event.type) {
          case 'connected':
            this.#telemetry.emit({
              kind: 'connection:connected',
              ...(traceId === undefined ? {} : { traceId }),
              ...(event.transport ? { transport: event.transport } : {}),
              ...(event.connectionId ? { connectionId: event.connectionId } : {}),
            })
            break
          case 'disconnected':
            this.#telemetry.emit({
              kind: 'connection:disconnected',
              ...(traceId === undefined ? {} : { traceId }),
              ...(event.reason ? { reason: event.reason } : {}),
              reconnecting: event.reconnecting,
            })
            break
          case 'reconnected':
            this.#telemetry.emit({
              kind: 'connection:reconnected',
              ...(traceId === undefined ? {} : { traceId }),
              ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
              ...(event.transport ? { transport: event.transport } : {}),
              ...(event.connectionId ? { connectionId: event.connectionId } : {}),
            })
            this.#scheduleReconnectSweep(traceId)
            break
          case 'error':
            this.#telemetry.emit({
              kind: 'connection:error',
              ...(traceId === undefined ? {} : { traceId }),
              phase: event.phase,
              error: event.error,
            })
            break
          case 'reconnect-failed':
            this.#telemetry.emit({
              kind: 'connection:reconnect-failed',
              ...(traceId === undefined ? {} : { traceId }),
              ...(event.error ? { error: event.error } : {}),
            })
            break
        }
      })
    } else {
      this.#connectionUnsub = this.#adapter.subscribeToReconnect?.(() =>
        this.#scheduleReconnectSweep(this.#telemetry.nextTraceId()),
      )
    }
  }

  assertActive(): void {
    if (this.#disposed) throw new Error('figbird: instance has been disposed')
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#retention.dispose()
    this.#visibilityUnsub()
    this.#connectionUnsub?.()
    for (const unsubscribe of this.#realtime.values()) unsubscribe()
    this.#realtime.clear()
    this.#reconciliation.dispose()
    if (this.#reconnectSweepTimer) clearTimeout(this.#reconnectSweepTimer)
    if (this.#eventBatchProcessingTimer) clearTimeout(this.#eventBatchProcessingTimer)
    for (const cancel of this.#retryWaits) cancel()
    this.#state.clear()
    this.#serviceNamesByQueryId.clear()
    this.#queryGenerations.clear()
    this.#queryStats.clear()
    this.#followupFetchContexts.clear()
    this.#reconnectQueryIds.clear()
    this.#dependencyOwners.clear()
    this.#eventQueue = []
    this.#appliedEventQueue = []
    this.#listeners.clear()
    this.#globalListeners.clear()
    this.#processedEventListeners.clear()
    this.#projectionSettlementListeners.clear()
    this.#fetchEventJournal.clear()
    this.#telemetry.dispose()
    this.#mutations.dispose()
  }

  // Public store API
  /** The instance's observability event emitter — the store is its single owner. */
  get events(): FigbirdEventEmitter {
    return this.#telemetry.events
  }

  /** The instance's active mutation tracker — the store is its single owner. */
  get mutations(): MutationTracker {
    return this.#mutations
  }

  /** Whether an observability consumer is currently attached. @internal */
  isObservabilityActive(): boolean {
    return this.#telemetry.active
  }

  /** Returns the entire store state map keyed by service name. */
  getState(): Map<string, ServiceState<TMeta>> {
    return this.#state
  }

  /** Returns the state for a specific service by name. */
  getServiceState(serviceName: string): ServiceState<TMeta> | undefined {
    return this.#state.get(serviceName)
  }

  /** Apply an in-memory entity edit from an attached devtool without touching the server. */
  editCacheEntity(serviceName: string, itemId: ItemId, item: unknown): DevtoolsCacheEditResult {
    const service = this.#state.get(serviceName)
    const key = entityKey(itemId)
    const previousItem = service?.entities.get(key)
    if (!service || previousItem === undefined) {
      return { ok: false, error: `Entity ${serviceName} #${String(itemId)} is not cached` }
    }
    const nextId = this.#peekId(item)
    if (nextId === undefined || entityKey(nextId) !== key) {
      return { ok: false, error: 'Edited JSON must retain the entity ID' }
    }

    const cause = this.#telemetry.cause('manual')
    const traceId = cause?.traceId
    const queryEffects = this.#telemetry.active
      ? new Map<string, 'merged' | 'reconcile'>()
      : undefined
    const event: ProcessedCacheEvent = {
      mode: 'local',
      ...(cause === undefined ? {} : { cause }),
      serviceName,
      type: 'patched',
      item,
      previousItem,
      itemId: key,
    }
    const touched = this.#transactOverServiceByName(serviceName, (current, touch) => {
      current.entities.set(key, item)
      const getId = this.#getIdReader(serviceName)
      for (const queryId of current.queries.keys()) {
        const result = reapplyQueryFromEntities({
          service: current,
          queryId,
          touch,
          getId,
          itemAdded: meta => this.#adapter.itemAdded(meta),
          itemRemoved: meta => this.#adapter.itemRemoved(meta),
          defaultSort: this.#defaultSort,
        })
        if (result === 'applied') {
          queryEffects?.set(queryId, 'merged')
          continue
        }
        if (
          applyVisibleEventToQuery({
            service: current,
            queryId,
            event,
            touch,
            getId,
            itemRemoved: meta => this.#adapter.itemRemoved(meta),
          })
        ) {
          queryEffects?.set(queryId, 'merged')
        }
      }
    })
    if (touched.size > 0) this.#notify(touched)
    else this.#invokeGlobalListeners()
    // Let relational queries recompute filters and assembled values from the edit.
    // Consumers distinguish this source from authoritative server events, so this
    // remains a purely local operation and never schedules a reconciliation fetch.
    this.#emitProcessedEvent(event)
    this.#telemetry.emit({
      kind: 'cache:updated',
      ...(traceId === undefined ? {} : { traceId }),
      source: 'devtools',
      serviceName,
      type: 'patched',
      itemId,
      item,
      previousItem,
      queryEffects: [...(queryEffects ?? [])].map(([queryId, outcome]) => ({ queryId, outcome })),
    })
    return { ok: true, ...(traceId === undefined ? {} : { traceId }) }
  }

  /** Returns the current state for a query by id, if present. */
  getQueryState<T>(queryId: string): QueryState<T, TMeta> | undefined {
    return this.#getQuery(queryId)?.state as QueryState<T, TMeta> | undefined
  }

  getQueryStats(queryId: string): QueryFetchStats | undefined {
    const stats = this.#queryStats.get(queryId)
    if (!stats) return undefined
    return { ...stats, history: [...stats.history] }
  }

  getQueryGeneration(queryId: string): number | undefined {
    return this.#queryGenerations.get(queryId)
  }

  /**
   * Ensures that backing state exists for the given QueryRef by creating
   * service/query structures on first use.
   */
  materialize<T, TQueryType>(queryRef: QueryRef<T, TQueryType, S, TParams, TMeta, TQuery>): void {
    this.assertActive()
    const { queryId, desc, config } = queryRef.details()

    if (!this.#getQuery(queryId)) {
      this.#retention.retain(queryId)
      this.#serviceNamesByQueryId.set(queryId, desc.serviceName)
      this.#queryGenerations.set(queryId, this.#nextQueryGeneration++)

      const classification = classifyStoredQuery(desc.method, queryOfParams(desc.params), {
        server: (config as { server?: boolean }).server,
        allPages: (config as { allPages?: boolean }).allPages,
        localOperators: locallySupportedOperators(this.#adapter, desc.serviceName),
      })

      if (!config.skip) this.#reconciliation.markPending(queryId)
      this.#transactOverService(queryId, service => {
        commitQuery(service, {
          queryId,
          desc,
          config: config as QueryConfig<unknown, unknown>,
          classification,
          pending: this.#reconciliation.isPending(queryId),
          dirty: false,
          filterItem: this.#createItemFilter<unknown, unknown>(
            desc,
            config as QueryConfig<unknown, unknown>,
            classification,
          ) as (item: unknown) => boolean,
          state: {
            status: 'loading' as const,
            data: null,
            meta: this.#adapter.emptyMeta(),
            isFetching: !config.skip,
            error: null,
          },
        })
      })
    }
  }

  /**
   * Subscribe to a query state by id. Triggers fetches if needed.
   * Returns an unsubscribe function.
   */
  subscribe<T>(
    queryId: string,
    fn: (state: QueryState<T, TMeta>) => void,
    options: QueryExecutionOptions = {},
  ): () => void {
    const q = this.#getQuery(queryId)
    if (!q) return () => {}

    this.#retention.cancel(queryId)
    this.ensureFresh(queryId, options)

    const removeListener = this.#addListener(queryId, fn)

    this.#subscribeToRealtime(queryId)

    const shouldVacuum = isEphemeralQuery(q.config)
    return () => {
      removeListener()
      if (this.#listenerCount(queryId) === 0) {
        if (shouldVacuum) this.#vacuum({ queryId })
        else this.#retention.retain(queryId)
      }
    }
  }

  /** Subscribe to any store state changes across all services. */
  subscribeToStateChanges(fn: (state: Map<string, ServiceState<TMeta>>) => void): () => void {
    return this.#addGlobalListener(fn)
  }

  /**
   * Subscribe to realtime events after they've been applied to the entity cache.
   * Used internally for relational-filter invalidation; each event carries the
   * previous entity so listeners can detect which fields changed.
   */
  subscribeToProcessedEvents(fn: (event: ProcessedCacheEvent) => void): () => void {
    this.#processedEventListeners.add(fn)
    return () => {
      this.#processedEventListeners.delete(fn)
    }
  }

  /** Subscribe to cumulative optimistic transitions after their record lane drains. */
  subscribeToProjectionSettlements(fn: (event: ProcessedProjectionEvent) => void): () => void {
    this.#projectionSettlementListeners.add(fn)
    return () => {
      this.#projectionSettlementListeners.delete(fn)
    }
  }

  /** Re-evaluate one cached query after projected relational dependencies changed. */
  reapplyQuery(queryId: string, mutationLaneKeys: ReadonlySet<string>): void {
    const serviceName = this.#serviceNamesByQueryId.get(queryId)
    if (!serviceName) return
    const reapply = { result: 'ignored' as 'applied' | 'reconcile' | 'ignored' }
    const modified = this.#transactOverServiceByName(serviceName, (service, touch) => {
      reapply.result = reapplyQueryFromEntities({
        service,
        queryId,
        touch,
        getId: this.#getIdReader(serviceName),
        itemAdded: meta => this.#adapter.itemAdded(meta),
        itemRemoved: meta => this.#adapter.itemRemoved(meta),
        defaultSort: this.#defaultSort,
      })
    })
    for (const modifiedQueryId of modified) this.#invokeListeners(modifiedQueryId)
    if (modified.size > 0) this.#invokeGlobalListeners()
    if (reapply.result !== 'reconcile') return

    let deferred = false
    for (const laneKey of mutationLaneKeys) {
      deferred = this.#mutationLanes.deferQueryIds(laneKey, [queryId]) || deferred
    }
    if (!deferred) this.#reconciliation.request(queryId)
  }

  /**
   * Ensure a realtime subscription exists for a service even before any query
   * against it is subscribed. Used by relational-filter invalidation, which needs
   * events from dependency services the consumer never queries directly.
   */
  ensureRealtimeSubscription(serviceName: string): () => void {
    this.assertActive()
    this.#dependencyOwners.set(serviceName, (this.#dependencyOwners.get(serviceName) ?? 0) + 1)
    this.#subscribeToRealtimeService(serviceName)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = (this.#dependencyOwners.get(serviceName) ?? 1) - 1
      if (count > 0) this.#dependencyOwners.set(serviceName, count)
      else this.#dependencyOwners.delete(serviceName)
      this.#pruneService(serviceName)
    }
  }

  /** Number of active subscribers for a query — powers figbird.inspect(). */
  getSubscriberCount(queryId: string): number {
    return this.#listenerCount(queryId)
  }

  /**
   * Ensure a materialized query satisfies a subscriber's freshness tolerance.
   * `staleTime` is not part of query identity: a later, stricter subscriber must be
   * able to revalidate an already-live query without rebuilding its subscription.
   */
  ensureFresh(queryId: string, options: QueryExecutionOptions = {}): void {
    const q = this.#getQuery(queryId)
    if (!q) return

    if (q.state.isFetching && options.graph) {
      this.#telemetry.attachGraph(queryId, options.graph)
    }

    const staleTime = options.staleTime ?? this.#staleTime
    const isFresh = isWithinStaleTime(q.fetchedAt, staleTime)
    if (
      this.#reconciliation.isPending(queryId) ||
      (q.state.status === 'success' &&
        q.config.fetchPolicy === 'swr' &&
        !q.state.isFetching &&
        !isFresh) ||
      (q.state.status === 'error' && !q.state.isFetching)
    ) {
      this.#queue(queryId, {
        reason: 'subscription',
        ...this.#causeContext('subscription'),
        ...(options.graph ? { graph: [options.graph] } : {}),
      })
    }
  }

  /** Refetch a specific query by id. */
  refetch(
    queryId: string,
    context?: FetchContext,
    options: Omit<QueryExecutionOptions, 'staleTime'> = {},
  ): void {
    const q = this.#getQuery(queryId)
    if (!q) return
    const fetchContext = context ?? {
      reason: 'manual' as const,
      ...this.#causeContext('manual'),
      ...(options.graph ? { graph: [options.graph] } : {}),
    }

    if (!q.state.isFetching) {
      this.#queue(queryId, fetchContext)
    } else {
      // Mark as dirty to refetch after current fetch completes
      this.#transactOverService(queryId, (service, query) => {
        commitQuery(service, {
          ...query!,
          dirty: true,
        })
      })
      this.#followupFetchContexts.set(queryId, fetchContext)
    }
  }

  /** Route an event-driven refetch through cooldown and visibility handling. @internal */
  reconcile(queryId: string): void {
    this.#reconciliation.request(queryId)
  }

  /** Replace/remove a row already visible in one query without changing membership. @internal */
  applyVisibleEvent(queryId: string, event: ProcessedCacheEvent): void {
    const serviceName = this.#serviceNamesByQueryId.get(queryId)
    if (!serviceName) return
    const getId = this.#getIdReader(serviceName)
    const touched = this.#transactOverServiceByName(serviceName, (service, touch) => {
      applyVisibleEventToQuery({
        service,
        queryId,
        event,
        touch,
        getId,
        itemRemoved: meta => this.#adapter.itemRemoved(meta),
      })
    })
    this.#notify(touched)
  }

  /** Keep a composite query's sentinel in the reconnect sweep while events are controller-owned. */
  registerReconnectQuery(queryId: string): () => void {
    this.#reconnectQueryIds.add(queryId)
    return () => this.#reconnectQueryIds.delete(queryId)
  }

  /** Perform a service mutation and update the store from the result. */
  mutate<D extends MutationDescriptor>(desc: D): Promise<InferMutationData<S, D>> {
    return this.registerMutation(desc).promise as Promise<InferMutationData<S, D>>
  }

  /** Whether the configured adapter promises atomic multi-mutation commits. */
  get supportsTransactions(): boolean {
    return this.#adapter.transaction !== undefined
  }

  /** Commit several keyed CRUD mutations through the adapter's atomic capability. */
  transaction(descs: readonly MutationDescriptor[]): Promise<void> {
    this.assertActive()
    if (!this.#adapter.transaction) {
      throw new Error('figbird: the configured adapter does not support transactions')
    }
    if (descs.length === 0) return Promise.resolve()

    const keys = new Set<string>()
    const planned = descs.map(desc => {
      if (desc.method === 'create' && Array.isArray(desc.data)) {
        throw new Error(
          'figbird: transaction create calls accept one item; collect multiple create calls instead',
        )
      }
      const id = desc.method === 'create' ? this.#peekId(desc.data) : desc.id
      if (id === undefined || id === null) {
        throw new Error(
          `figbird: transaction ${desc.method} on "${desc.serviceName}" requires a stable entity id`,
        )
      }
      if (desc.method === 'create') {
        const optimisticId = this.#peekId(resolveCreateOptimisticItem(desc))
        if (optimisticId === undefined || entityKey(optimisticId) !== entityKey(id)) {
          throw new Error(
            `figbird: transaction create on "${desc.serviceName}" must preserve its payload id in the optimistic item`,
          )
        }
      }
      const key = JSON.stringify([desc.serviceName, entityKey(id)])
      if (keys.has(key)) {
        throw new Error(
          `figbird: a transaction can mutate "${desc.serviceName}"/${String(id)} only once`,
        )
      }
      keys.add(key)
      return {
        desc,
        id,
        args: this.#buildMutationArgs(desc),
        optimistic: desc.optimistic != null && desc.optimistic !== false,
      }
    })

    const transaction: QueuedTransaction = {
      entries: [],
      readyLaneKeys: new Set(),
      status: 'waiting',
    }
    const promises: Promise<unknown>[] = []

    for (const operation of planned) {
      const lane = this.#mutationLanes.ensure(
        operation.desc.serviceName,
        operation.id,
        this.#getEntity(operation.desc.serviceName, operation.id),
      )
      const entry: QueuedMutation = {
        desc: operation.desc,
        args: operation.args,
        optimistic: operation.optimistic,
        attempt: new GatedMutationAttempt(),
        transaction,
      }
      transaction.entries.push({ lane, entry })
      const tracked = this.#trackMutation(
        {
          serviceName: operation.desc.serviceName,
          method: operation.desc.method,
          id: operation.id,
          optimistic: operation.optimistic,
          args: operation.args,
        },
        () => entry.attempt.promise,
        {
          onError: (_error, { mutationId, cause }) => {
            if (!operation.optimistic) return
            this.#telemetry.emit({
              kind: 'mutate:rollback',
              mutationId,
              ...(cause ? { traceId: cause.traceId } : {}),
              serviceName: operation.desc.serviceName,
              method: operation.desc.method,
              id: operation.id,
            })
          },
        },
      )
      if (tracked.cause) entry.cause = tracked.cause
      promises.push(tracked.promise)
      this.#applyProjection(this.#mutationLanes.enqueue(lane, entry), false, tracked.cause)
    }

    // All affected services are projected before observers are notified.
    this.#processQueuedEvents()
    for (const { lane } of transaction.entries) this.#drainMutationLane(lane)

    return Promise.all(promises).then(() => undefined)
  }

  /**
   * Run one confirmed mutation without record-lane scheduling. This preserves the
   * transport behavior of deprecated `useMutation`: a caller may time out a hung
   * request and start another request for the same record. @internal
   */
  mutateConfirmedDirect<D extends MutationDescriptor>(desc: D): Promise<InferMutationData<S, D>> {
    this.assertActive()
    const { serviceName, method } = desc
    const id = method === 'create' ? this.#peekId(desc.data) : desc.id
    const args = this.#buildMutationArgs(desc)
    const registration = this.#registerUnkeyedMutation({
      tracking: {
        serviceName,
        method,
        ...(id !== undefined ? { id } : {}),
        optimistic: false,
        args,
      },
      control: undefined,
      run: () => this.#adapter.mutate(serviceName, method, [...args]),
      hooks: {
        onSuccess: (item, { cause }) =>
          this.#processEvent(serviceName, { type: MUTATION_EVENT_TYPE[method], item }, cause),
      },
    })
    return registration.promise as Promise<InferMutationData<S, D>>
  }

  /** Register a mutation with an optional transport scheduler. @internal */
  registerMutation(
    desc: MutationDescriptor,
    control?: ScheduledMutationControl,
  ): RegisteredMutation {
    this.assertActive()
    const { serviceName, method, optimistic } = desc
    const optimisticItem = method === 'create' ? resolveCreateOptimisticItem(desc) : undefined
    // For creates, track by the client-generated id — this is what lets
    // `useMutating({ id })` cover the create→navigate→act-before-ack window.
    const id = method !== 'create' ? desc.id : this.#peekId(optimisticItem)
    const isOptimistic = optimistic != null && optimistic !== false

    // The id contract: an optimistic create must carry a client-generated id the
    // server will accept. Identity is what everything downstream is built on —
    // React keys, realtime echo dedup, navigation, child-row foreign keys — and
    // an optimistic item without a real id has none. Confirmed creates
    // (non-optimistic) are the mode for server-assigned ids: await the create,
    // the server's item carries its identity.
    if (isOptimistic && method === 'create') {
      const items: unknown[] = Array.isArray(optimisticItem) ? optimisticItem : [optimisticItem]
      if (items.some(item => this.#peekId(item) === undefined)) {
        throw new Error(
          `figbird: optimistic creates on "${serviceName}" need a client-generated id the ` +
            'server will accept (e.g. crypto.randomUUID()) — provide one in the data, or use ' +
            'a confirmed create to wait for the server-assigned id.',
        )
      }
    }

    const args = this.#buildMutationArgs(desc)

    // A stable id is the serialization key. Id-less confirmed creates and batch
    // creates keep the direct path because one request cannot belong to one entity
    // lane without a multi-key transaction primitive.
    if (id !== undefined && id !== null && !(method === 'create' && Array.isArray(desc.data))) {
      return this.#enqueueMutation(desc, id, isOptimistic, args, control)
    }

    // Every update, patch, and remove has an id and therefore took the lane path.
    // What remains is an id-less confirmed create or a batch create, neither of
    // which can be represented by one entity lane.
    if (method === 'create') return this.#mutateUnkeyedCreate(desc, args, isOptimistic, control)
    if (id === null) return this.#mutateUnkeyedCrud(desc, args, isOptimistic, control)
    throw new Error(`figbird: ${method} mutation is missing its entity id`)
  }

  #mutateUnkeyedCreate(
    desc: CreateMutationDescriptor,
    args: unknown[],
    optimistic: boolean,
    control?: ScheduledMutationControl,
  ): RegisteredMutation {
    const optimisticItem = resolveCreateOptimisticItem(desc)
    return this.#registerUnkeyedMutation({
      tracking: {
        serviceName: desc.serviceName,
        method: desc.method,
        optimistic,
        args,
      },
      control,
      ...(optimistic
        ? {
            project: (cause?: MutationTraceCause) =>
              this.#processEvent(
                desc.serviceName,
                { type: 'created', item: optimisticItem },
                cause,
              ),
          }
        : {}),
      run: () => this.#adapter.mutate(desc.serviceName, desc.method, [...args]),
      hooks: {
        // Apply the cache update before ending the tracker entry, so by the time a
        // `useMutating` subscriber sees "not busy" the data is already in the cache.
        onSuccess: (item, { cause }) =>
          this.#processEvent(desc.serviceName, { type: 'created', item }, cause),
        onError: (_error, { mutationId, cause }) => {
          if (!optimistic) return
          this.#processEvent(desc.serviceName, { type: 'removed', item: optimisticItem }, cause)
          this.#telemetry.emit({
            kind: 'mutate:rollback',
            mutationId,
            ...(cause ? { traceId: cause.traceId } : {}),
            serviceName: desc.serviceName,
            method: desc.method,
          })
        },
      },
    })
  }

  #mutateUnkeyedCrud(
    desc: MutationDescriptor,
    args: unknown[],
    optimistic: boolean,
    control?: ScheduledMutationControl,
  ): RegisteredMutation {
    return this.#registerUnkeyedMutation({
      tracking: {
        serviceName: desc.serviceName,
        method: desc.method,
        optimistic,
        args,
      },
      control,
      run: () => this.#adapter.mutate(desc.serviceName, desc.method, [...args]),
      hooks: {
        onSuccess: (item, { cause }) =>
          this.#processEvent(
            desc.serviceName,
            {
              type: MUTATION_EVENT_TYPE[desc.method],
              item,
            },
            cause,
          ),
      },
    })
  }

  /** Queue one keyed CRUD call behind earlier calls for the same service entity. */
  #enqueueMutation(
    desc: MutationDescriptor,
    id: ItemId,
    optimistic: boolean,
    args: unknown[],
    control?: ScheduledMutationControl,
  ): RegisteredMutation {
    const lane = this.#mutationLanes.ensure(
      desc.serviceName,
      id,
      this.#getEntity(desc.serviceName, id),
    )

    const entry: QueuedMutation = {
      desc,
      args,
      optimistic,
      attempt: new GatedMutationAttempt(control),
    }

    const tracked = this.#trackMutation(
      {
        serviceName: desc.serviceName,
        method: desc.method,
        id,
        optimistic,
        args,
      },
      () => entry.attempt.promise,
      {
        onSuccess: (item, { cause }) =>
          this.#settleQueuedMutation(lane, entry, { ok: true, item }, cause),
        onError: (error, { mutationId, cause }) => {
          this.#settleQueuedMutation(lane, entry, { ok: false, error }, cause)
          if (optimistic) {
            this.#telemetry.emit({
              kind: 'mutate:rollback',
              mutationId,
              ...(cause ? { traceId: cause.traceId } : {}),
              serviceName: desc.serviceName,
              method: desc.method,
              id,
            })
          }
        },
      },
    )

    if (tracked.cause) entry.cause = tracked.cause
    this.#applyProjection(this.#mutationLanes.enqueue(lane, entry), true, tracked.cause)
    entry.attempt.whenReady(() => {
      this.#expediteMutationPredecessors(lane, entry)
      this.#drainMutationLane(lane)
    })
    this.#drainMutationLane(lane)
    return {
      promise: tracked.promise,
      tryUpdate: next => {
        if (!entry.attempt.pending) return false
        const projection = this.#mutationLanes.replaceTail(lane, entry, next)
        if (!projection) return false
        entry.args = this.#buildMutationArgs(next)
        this.#applyProjection(projection, true, tracked.cause)
        this.#telemetry.emit({
          kind: 'mutate:update',
          mutationId: tracked.mutationId,
          ...(tracked.cause ? { traceId: tracked.cause.traceId } : {}),
          serviceName: next.serviceName,
          method: next.method,
          id,
          optimistic,
          args: entry.args,
        })
        return true
      },
      cancel: error => this.#cancelQueuedMutation(lane, entry, error, tracked.cause),
    }
  }

  #drainMutationLane(lane: MutationLane): void {
    const pending = this.#mutationLanes.peekNext(lane)
    if (pending && !pending.attempt.ready) return

    const entry = this.#mutationLanes.takeNext(lane)
    if (!entry) {
      this.#releaseMutationLane(lane)
      return
    }
    if (entry.transaction) {
      entry.transaction.readyLaneKeys.add(lane.key)
      if (entry.transaction.readyLaneKeys.size === entry.transaction.entries.length) {
        this.#startTransaction(entry.transaction)
      }
      return
    }
    entry.attempt.start(() =>
      this.#runControlledAttempt(entry.attempt.control, () =>
        this.#adapter.mutate(lane.serviceName, entry.desc.method, [...entry.args]),
      ),
    )
  }

  #startTransaction(transaction: QueuedTransaction): void {
    if (transaction.status !== 'waiting') return
    transaction.status = 'running'

    const operations: AdapterTransactionOperation[] = transaction.entries.map(
      ({ lane, entry }) => ({
        serviceName: lane.serviceName,
        method: entry.desc.method,
        args: [...entry.args],
      }),
    )
    let transport: Promise<readonly unknown[]>
    try {
      transport = Promise.resolve(this.#adapter.transaction!(operations))
    } catch (error) {
      transport = Promise.reject(error)
    }

    const checked = transport.then(results => {
      if (!Array.isArray(results) || results.length !== transaction.entries.length) {
        throw new Error(
          `figbird: adapter transaction returned ${Array.isArray(results) ? results.length : 'an invalid number of'} results for ${transaction.entries.length} operations`,
        )
      }
      return results
    })
    const settled = checked.then(
      results => {
        this.#settleTransaction(transaction, { ok: true, results })
        return results
      },
      (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err))
        this.#settleTransaction(transaction, { ok: false, error })
        throw error
      },
    )

    transaction.entries.forEach(({ entry }, index) => {
      entry.attempt.start(() => settled.then(results => results[index]))
    })
  }

  #abortTransaction(transaction: QueuedTransaction, error: Error, lanes: Set<MutationLane>): void {
    if (transaction.status !== 'waiting') return
    transaction.status = 'aborted'

    for (const { lane, entry } of transaction.entries) {
      const outcome = { ok: false, error } as const
      const settlement = this.#mutationLanes.abort(lane, entry, error)
      if (settlement) {
        this.#applyLaneSettlement(lane, entry, outcome, settlement, lanes)
      }
      entry.attempt.cancel(error)
    }
  }

  #settleTransaction(
    transaction: QueuedTransaction,
    outcome: { ok: true; results: readonly unknown[] } | { ok: false; error: Error },
  ): void {
    if (transaction.status !== 'running') return
    transaction.status = 'settled'
    const lanes = new Set<MutationLane>()
    transaction.entries.forEach(({ lane, entry }, index) => {
      const entryOutcome = outcome.ok
        ? ({ ok: true, item: outcome.results[index] } as const)
        : ({ ok: false, error: outcome.error } as const)
      const settlement = this.#mutationLanes.settle(lane, entry, entryOutcome)
      if (!settlement) return
      this.#applyLaneSettlement(lane, entry, entryOutcome, settlement, lanes)
    })

    // Success and rollback are each one observer-visible cache transition across services.
    this.#finishLaneSettlements(lanes)
  }

  #expediteMutationPredecessors(lane: MutationLane, entry: QueuedMutation): void {
    for (const predecessor of this.#mutationLanes.predecessors(lane, entry)) {
      const control = predecessor.attempt.control
      if (predecessor.attempt.pending && control && !control.isReady()) control.expedite()
    }
  }

  async #runControlledAttempt(
    control: ScheduledMutationControl | undefined,
    run: () => Promise<unknown>,
  ): Promise<unknown> {
    let attempt = 0
    while (true) {
      attempt += 1
      control?.onAttemptStart()
      try {
        return await run()
      } catch (error) {
        const normalized = normalizeError(error)
        if (!control || (await control.onAttemptFailure(normalized, attempt)) === 'discard') {
          throw normalized
        }
      }
    }
  }

  #cancelQueuedMutation(
    lane: MutationLane,
    entry: QueuedMutation,
    error: Error,
    cause?: TraceCause,
  ): void {
    if (!entry.attempt.cancel(error)) return
    const projection = this.#mutationLanes.cancel(lane, entry)
    if (projection) this.#applyProjection(projection, true, cause)
    this.#drainMutationLane(lane)
  }

  #settleQueuedMutation(
    lane: MutationLane,
    entry: QueuedMutation,
    outcome: { ok: true; item: unknown } | { ok: false; error: Error },
    cause?: TraceCause,
  ): void {
    const settlement = this.#mutationLanes.settle(lane, entry, outcome)
    if (!settlement) return

    const lanes = new Set<MutationLane>()
    this.#applyLaneSettlement(lane, entry, outcome, settlement, lanes, cause)
    this.#finishLaneSettlements(lanes)
  }

  #applyLaneSettlement(
    lane: MutationLane,
    entry: QueuedMutation,
    outcome: MutationOutcome,
    settlement: LaneSettlement<QueuedMutation>,
    lanes: Set<MutationLane>,
    cause: TraceCause | undefined = entry.cause,
  ): void {
    lanes.add(lane)

    // A mutation acknowledgement is authoritative even when remaining overlays
    // keep the visible projection unchanged. Recording it protects fetches that
    // began before the acknowledgement from replacing the newer server state.
    if (settlement.authoritativeEvent) {
      this.#fetchEventJournal.record([settlement.authoritativeEvent])
    }

    const projected = this.#applyProjection(settlement.projection, false, cause)
    if (!projected && settlement.authoritativeEvent && !this.#mutationLanes.peekNext(lane)) {
      this.#appliedEventQueue.push(settlement.authoritativeEvent)
    }

    this.#cancelSettledDependants(lane, entry, outcome, settlement.cancelled, lanes)
  }

  #finishLaneSettlements(lanes: ReadonlySet<MutationLane>): void {
    this.#processQueuedEvents()
    for (const lane of lanes) this.#drainMutationLane(lane)
  }

  #cancelSettledDependants(
    lane: MutationLane,
    entry: QueuedMutation,
    outcome: { ok: true; item: unknown } | { ok: false; error: Error },
    cancelled: readonly QueuedMutation[],
    lanes: Set<MutationLane>,
  ): void {
    if (cancelled.length === 0) return
    const reason = outcome.ok
      ? 'because the record was removed'
      : entry.desc.method === 'create'
        ? 'because its create mutation failed'
        : 'because the preceding remove mutation failed'
    for (const queued of cancelled) {
      if (queued.transaction) {
        this.#abortTransaction(
          queued.transaction,
          new MutationSupersededError(
            `figbird: cancelled transaction for "${lane.serviceName}"/${String(lane.id)} ${reason}`,
          ),
          lanes,
        )
        continue
      }
      queued.attempt.cancel(
        new MutationSupersededError(
          `figbird: cancelled queued mutations for "${lane.serviceName}"/${String(lane.id)} ${reason}`,
        ),
      )
    }
  }

  #applyProjection(change: ProjectionChange, immediate: boolean, cause?: TraceCause): boolean {
    if (this.#disposed) return false
    const event = this.#queuedProjectionEvent(change, cause)
    if (!event) return false
    this.#eventQueue.push(event)
    if (immediate) this.#processQueuedEvents()
    return true
  }

  #projectionEvent(change: ProjectionChange): Event | null {
    const { previous, next } = change
    if (previous === ABSENT && next === ABSENT) return null
    if (previous === ABSENT) {
      return { type: 'created', item: next }
    }
    if (next === ABSENT) return { type: 'removed', item: previous }
    return previous === next ? null : { type: 'patched', item: next }
  }

  #releaseMutationLane(lane: MutationLane): void {
    const effects = this.#mutationLanes.release(lane)
    if (!effects) return

    if (effects.projection) this.#emitProjectionSettlement(effects.projection)
    for (const queryId of effects.queryIds) this.#reconciliation.request(queryId)
  }

  /** Active optimistic projections must survive fetches that started after them. */
  #activeMutationOverlayEvents(serviceName: string): ProcessedProjectionEvent[] {
    return this.#mutationLanes.overlayEvents(serviceName)
  }

  /**
   * Call a custom (non-CRUD) service method — the mutation path for everything
   * beyond create/update/patch/remove (`archive`, `sendReminder`, ...). The result
   * shape is unknown to figbird, so no cache update is applied; the call still
   * flows through the mutation tracker and the `mutate:*` observability events so
   * `useMutating` and devtools see it. No `id` is recorded — custom method args
   * are positional and opaque.
   */
  call(serviceName: string, method: string, args: unknown[]): Promise<unknown> {
    return this.registerCall(serviceName, method, args).promise
  }

  /** Register a custom method call with an optional transport scheduler. @internal */
  registerCall(
    serviceName: string,
    method: string,
    args: unknown[],
    control?: ScheduledMutationControl,
  ): RegisteredMutation {
    return this.#registerUnkeyedMutation({
      tracking: { serviceName, method, optimistic: false, args },
      control,
      run: () => this.#adapter.mutate(serviceName, method, args),
    })
  }

  #registerUnkeyedMutation({
    tracking,
    control,
    project,
    run,
    hooks,
  }: {
    tracking: MutationTrackingEntry
    control: ScheduledMutationControl | undefined
    project?: (cause?: MutationTraceCause) => void
    run: () => Promise<unknown>
    hooks?: MutationTrackingHooks<unknown>
  }): RegisteredMutation {
    const attempt = new GatedMutationAttempt(control)
    const tracked = this.#trackMutation(
      tracking,
      ({ cause }) => {
        project?.(cause)
        return attempt.promise
      },
      hooks,
    )

    const start = () => {
      attempt.start(() => this.#runControlledAttempt(control, run))
    }
    attempt.whenReady(start)

    return {
      promise: tracked.promise,
      tryUpdate: () => false,
      cancel: error => void attempt.cancel(error),
    }
  }

  /**
   * Shared mutation tracking around a promise that owns projection and transport.
   * The tracker entry is
   * registered synchronously — not via the deferred events channel — so
   * `figbird.mutating` snapshots are correct at any moment (see MutationTracker),
   * and it registers *before* `run()` so an optimistic apply never notifies
   * subscribers while the tracker still reads "not busy". On settle, the
   * `onSuccess`/`onError` hooks fire before the tracker entry ends, so by the time
   * a `useMutating` subscriber sees "not busy" the cache already reflects the
   * outcome. Errors are normalized to `Error` and rethrown.
   */
  #trackMutation<T>(
    entry: MutationTrackingEntry,
    run: (context: MutationTrackingContext) => Promise<T>,
    hooks?: MutationTrackingHooks<T>,
  ): TrackedMutation<T> {
    this.assertActive()
    const { serviceName, method, id, optimistic, args } = entry
    const idField = id !== undefined ? { id } : {}
    const startedAt = Date.now()
    const mutationId = this.#mutations.start({ serviceName, method, ...idField })
    const cause = this.#telemetry.mutationCause(mutationId) as MutationTraceCause | undefined
    const context: MutationTrackingContext = { mutationId, ...(cause ? { cause } : {}) }
    this.#telemetry.emit({
      kind: 'mutate:start',
      mutationId,
      ...(cause ? { traceId: cause.traceId } : {}),
      serviceName,
      method,
      ...idField,
      optimistic,
      args,
    })
    const promise = run(context).then(
      result => {
        hooks?.onSuccess?.(result, context)
        this.#pruneService(serviceName)
        this.#mutations.end(mutationId)
        this.#telemetry.emit({
          kind: 'mutate:end',
          mutationId,
          ...(cause ? { traceId: cause.traceId } : {}),
          serviceName,
          method,
          durationMs: Date.now() - startedAt,
          ...idField,
          optimistic,
        })
        return result
      },
      (err: unknown) => {
        const error = normalizeError(err)
        hooks?.onError?.(error, context)
        this.#pruneService(serviceName)
        this.#mutations.end(mutationId)
        this.#telemetry.emit({
          kind: 'mutate:error',
          mutationId,
          ...(cause ? { traceId: cause.traceId } : {}),
          serviceName,
          method,
          durationMs: Date.now() - startedAt,
          error,
          ...idField,
          optimistic,
        })
        throw error
      },
    )
    return { mutationId, ...(cause ? { cause } : {}), promise }
  }

  // Query lifecycle
  async #queue(queryId: string, context?: FetchContext): Promise<void> {
    const fetchContext = context ?? {
      reason: 'subscription' as const,
      ...this.#causeContext('subscription'),
    }
    const graph = this.#telemetry.beginGraph(queryId, fetchContext.graph)
    this.#fetching({ queryId })
    const generation = this.#queryGenerations.get(queryId)
    if (generation === undefined) {
      this.#telemetry.finishGraph(queryId, graph)
      return
    }

    try {
      let retryAttempt = 0
      while (true) {
        const outcome = await this.#runFetchAttempt(
          queryId,
          generation,
          {
            reason: retryAttempt === 0 ? fetchContext.reason : 'retry',
            attempt: retryAttempt,
            ...(fetchContext.causes ? { causes: fetchContext.causes } : {}),
          },
          graph,
        )
        if (outcome.kind !== 'failed') return

        const query = this.#getQuery(queryId)
        if (
          !query ||
          this.#queryGenerations.get(queryId) !== generation ||
          !this.#hasRetryOwner(queryId) ||
          !this.#shouldRetry(query, retryAttempt, outcome.error)
        ) {
          if (query && this.#queryGenerations.get(queryId) === generation) {
            this.#fetchFailed({ queryId, error: outcome.error })
          }
          return
        }

        retryAttempt++
        const configuredDelay = query.config.retryDelay ?? this.#retryDelay
        const delay = this.#resolveRetryDelay(configuredDelay, retryAttempt, outcome.error)
        await new Promise<void>(resolve => {
          const cancel = () => {
            clearTimeout(timer)
            this.#retryWaits.delete(cancel)
            resolve()
          }
          const timer = setTimeout(cancel, delay)
          this.#retryWaits.add(cancel)
        })

        if (this.#queryGenerations.get(queryId) !== generation) return
        if (!this.#hasRetryOwner(queryId)) {
          this.#fetchFailed({ queryId, error: outcome.error })
          return
        }
      }
    } finally {
      this.#telemetry.finishGraph(queryId, graph)
    }
  }

  async #runFetchAttempt(
    queryId: string,
    generation: number,
    context: { reason: FetchReason; attempt: number; causes?: TraceCause[] },
    graphRefs: ReadonlyMap<string, QueryGraphRef>,
  ): Promise<FetchAttemptOutcome> {
    const query = this.#getQuery(queryId)
    if (!query || this.#queryGenerations.get(queryId) !== generation) {
      return { kind: 'stale' }
    }

    const startedAt = Date.now()
    const fetchId = this.#telemetry.nextFetchId()
    const trace = {
      generation,
      serviceName: query.desc.serviceName,
      method: query.desc.method,
      ...(query.desc.method === 'get' ? { resourceId: query.desc.resourceId } : {}),
      params: query.desc.params,
    }
    const journalCursor = this.#fetchEventJournal.begin(trace.serviceName)
    const graph = [...graphRefs.values()]
    this.#telemetry.emit({
      kind: 'fetch:start',
      timestamp: startedAt,
      serviceName: trace.serviceName,
      method: trace.method,
      queryId,
      generation,
      fetchId,
      reason: context.reason,
      attempt: context.attempt,
      ...(context.causes ? { causes: context.causes } : {}),
      ...(graph.length > 0 ? { graph } : {}),
      ...('resourceId' in trace ? { resourceId: trace.resourceId } : {}),
      params: trace.params,
    })

    try {
      const result = await this.#fetch(queryId)
      const endedAt = Date.now()
      const durationMs = endedAt - startedAt
      const current = this.#getQuery(queryId)
      if (current && this.#queryGenerations.get(queryId) === generation) {
        const journal = this.#fetchEventJournal.read(journalCursor)
        if (journal.overflowed) {
          this.#discardFetchedResponse(queryId)
        } else {
          const cacheCause = context.causes?.[0]
          this.#fetched({
            queryId,
            result,
            journalEvents: journal.events,
            ...(cacheCause === undefined ? {} : { cause: cacheCause }),
          })
        }
        this.#recordFetchStats(queryId, {
          fetchId,
          startedAt,
          durationMs,
          ok: true,
          reason: context.reason,
        })
      }

      const data = result.data
      const itemCount = Array.isArray(data) ? data.length : data ? 1 : 0
      this.#telemetry.emit({
        kind: 'fetch:end',
        timestamp: endedAt,
        serviceName: trace.serviceName,
        method: trace.method,
        queryId,
        generation,
        fetchId,
        durationMs,
        itemCount,
        ...(graphRefs.size > 0 ? { graph: [...graphRefs.values()] } : {}),
      })
      return { kind: 'completed' }
    } catch (err) {
      const error = normalizeError(err)
      const endedAt = Date.now()
      const durationMs = endedAt - startedAt
      const current = this.#getQuery(queryId)
      const isCurrent = Boolean(current && this.#queryGenerations.get(queryId) === generation)
      if (isCurrent) {
        this.#recordFetchStats(queryId, {
          fetchId,
          startedAt,
          durationMs,
          ok: false,
          reason: context.reason,
        })
      }

      this.#telemetry.emit({
        kind: 'fetch:error',
        timestamp: endedAt,
        serviceName: trace.serviceName,
        method: trace.method,
        queryId,
        generation,
        fetchId,
        durationMs,
        error,
        ...(graphRefs.size > 0 ? { graph: [...graphRefs.values()] } : {}),
      })
      return isCurrent ? { kind: 'failed', error } : { kind: 'stale' }
    } finally {
      this.#fetchEventJournal.end(journalCursor)
    }
  }

  #shouldRetry(query: Query<unknown, TMeta, unknown>, retryAttempt: number, error: Error): boolean {
    const retry = this.#normalizeRetry(query.config.retry ?? this.#retry)
    return (
      retry !== false && retryAttempt < retry && (this.#adapter.isRetryableError?.(error) ?? true)
    )
  }

  #normalizeRetry(retry: number | false): number | false {
    if (retry === false || !Number.isFinite(retry) || retry <= 0) return false
    return Math.floor(retry)
  }

  #hasRetryOwner(queryId: string): boolean {
    if (this.#listenerCount(queryId) > 0) return true
    const serviceName = this.#serviceNamesByQueryId.get(queryId)
    return (
      serviceName !== undefined && this.#state.get(serviceName)?.materialized?.queryId === queryId
    )
  }

  #takeFollowupFetchContext(queryId: string): FetchContext {
    const context = this.#followupFetchContexts.get(queryId) ?? {
      reason: 'follow-up' as const,
      ...this.#causeContext('fetch-rebase'),
    }
    this.#followupFetchContexts.delete(queryId)
    return context
  }

  #resolveRetryDelay(delay: RetryDelay, attempt: number, error: Error): number {
    return resolveRetryDelay(
      () => (typeof delay === 'function' ? delay(attempt, error) : delay),
      defaultRetryDelay(attempt),
    )
  }

  #fetch(queryId: string): Promise<StoreResponse<TMeta>> {
    const query = this.#getQuery(queryId)
    if (!query) {
      return Promise.reject(new Error('Query not found'))
    }

    const { desc, config } = query

    if (desc.method === 'get') {
      const local = this.#tryLocalGet(query)
      if (local) return Promise.resolve(local)
      return this.#adapter.get(desc.serviceName, desc.resourceId, desc.params as TParams)
    } else {
      if (desc.page) {
        const pageSource = this.#adapter.pageSource?.(desc.serviceName)
        if (!pageSource) {
          return Promise.reject(
            new Error(`Adapter does not support native pagination for "${desc.serviceName}"`),
          )
        }
        return pageSource.find(desc.params as TParams, desc.page)
      }
      const local = this.#selectMaterializedFind(query)
      if (local) return Promise.resolve(local)
      const findConfig = config as FindQueryConfig<unknown, unknown>
      return findConfig.allPages
        ? this.#adapter.findAll(desc.serviceName, desc.params as TParams)
        : this.#adapter.find(desc.serviceName, desc.params as TParams)
    }
  }

  /**
   * Answer a get locally when the service is fully materialized (an `.all()` query
   * succeeded): the entity cache is the complete row set, so a present entity is
   * the answer with no roundtrip — realtime events, the reconnect sweep, and
   * complete-set fetch diffs keep it fresh, the same soundness argument local finds
   * rely on. Conditions (`.get(id).where(...)`) evaluate locally too when they're
   * locally decidable — same matcher, same custom-operator registry as finds.
   *
   * Falls through to the server whenever the local answer would be an *error*: a
   * missing entity or a present entity failing the predicate. Completeness makes a
   * local not-found sound in principle, but those cases are rare, a roundtrip there
   * is cheap, and the server's error carries the adapter's real error shape (which
   * apps match on) rather than a synthesized one. Non-local conditions (`$regex`),
   * `network-only`, and `.server()` reads always go out.
   */
  #tryLocalGet(
    query: Query<unknown, TMeta, unknown>,
  ): QueryResponse<unknown, TMeta | undefined> | null {
    const desc = query.desc
    if (desc.method !== 'get') return null
    // Gets with non-local conditions stored as 'server-authoritative' at
    // materialize time (see classifyStoredQuery) — never answered locally.
    if (query.classification !== 'get') return null
    const service = this.#state.get(desc.serviceName)
    if (!service?.materialized) return null

    const config = query.config as GetQueryConfig<unknown, unknown>
    if (config.server) return null
    if (config.fetchPolicy === 'network-only') return null

    const entity = service.entities.get(entityKey(desc.resourceId))
    if (entity === undefined) return null

    const q = queryOfParams(desc.params)
    if (q && Object.keys(q).length > 0) {
      // classification === 'get' guarantees the conditions are locally evaluable.
      if (!this.#resolveMatcher(desc.serviceName, config, q)(entity)) return null
    }

    return { data: entity } as QueryResponse<unknown, TMeta | undefined>
  }

  /** Select a deterministically ordered find from a complete local service. */
  #selectMaterializedFind(
    query: Query<unknown, TMeta, unknown>,
  ): { data: unknown[]; meta: TMeta } | null {
    if (query.desc.method !== 'find' || query.desc.page) return null
    const service = this.#state.get(query.desc.serviceName)
    if (!service?.materialized) return null
    if (service.materialized.queryId === query.queryId) return null

    const config = query.config as FindQueryConfig<unknown, unknown>
    // Honor the documented fetchPolicy contract ("always fetch on mount"), same
    // as #tryLocalGet — a materialized cache doesn't override an explicit opt-out.
    if (config.fetchPolicy === 'network-only') return null
    // Stored classification is the single source of truth: authoritative reasons
    // ($select, $regex, custom operators, .server()) survive allPages-neutralization,
    // while window filters don't — windows are computed locally below. So
    // 'server-authoritative' is exactly "not locally answerable".
    if (query.classification === 'server-authoritative') return null

    const q = queryOfParams(query.desc.params)
    const { filters, sort, ...window } = splitWindow(q)
    const limit = config.allPages ? undefined : window.limit
    const skip = config.allPages ? 0 : window.skip
    const effectiveSort = sort ?? this.#defaultSort
    // A complete entity set proves membership, but it does not reveal the
    // backend's implicit order. Without an explicit or configured sort, serving
    // insertion order from the cache would be permanently approximate.
    if (!effectiveSort) return null
    const match = this.#resolveMatcher(query.desc.serviceName, config, filters)
    let rows = [...service.entities.values()].filter(match)
    rows = sortRowsLocally(rows, effectiveSort)
    const total = rows.length
    const data = rows.slice(skip, limit !== undefined ? skip + limit : undefined)
    // The adapter owns the meta envelope — the store only knows the window numbers.
    return {
      data,
      meta: this.#adapter.findMeta({ total, limit: limit ?? total, skip }),
    }
  }

  #reapplyMaterializedFind(
    service: ServiceState<TMeta>,
    query: Query<unknown, TMeta>,
  ): 'unavailable' | 'unchanged' | 'changed' {
    if (query.config.realtime !== 'merge' || query.state.status !== 'success') return 'unavailable'
    const local = this.#selectMaterializedFind(query)
    if (!local) return 'unavailable'
    const previous = query.state.data
    if (
      Array.isArray(previous) &&
      previous.length === local.data.length &&
      previous.every((row, index) => row === local.data[index]) &&
      sameValue(query.state.meta, local.meta)
    )
      return 'unchanged'
    commitQuery(service, {
      ...query,
      state: { ...query.state, data: local.data, meta: local.meta },
    })
    return 'changed'
  }

  #fetching({ queryId }: { queryId: string }): void {
    this.#reconciliation.settle(queryId)
    // This is the only listener-notifying transition reachable synchronously from
    // a React render (useQuery → suspensePromise → root/relation setup → subscribe
    // → #queue → here); everything past `await #fetch` is already async. Deferring
    // the notification (not the state write — the fetch still starts synchronously
    // and warm reads are unaffected) keeps other subscribed components from being
    // updated mid-render.
    this.#scheduleDeferredNotify(
      this.#transactOverService(queryId, (service, query) => {
        if (!query) return

        commitQuery(service, {
          ...query,
          dirty: false,
          // error and loading states both restart as a clean loading state.
          state:
            query.state.status === 'success'
              ? { ...query.state, isFetching: true }
              : {
                  status: 'loading' as const,
                  data: null,
                  meta: query.state.meta,
                  isFetching: true,
                  error: null,
                },
        })
      }),
    )
  }

  #fetched({
    queryId,
    result,
    journalEvents,
    cause,
  }: {
    queryId: string
    result: StoreResponse<TMeta>
    journalEvents: readonly ProcessedCacheEvent[]
    cause?: TraceCause
  }): void {
    let shouldRefetch = false
    let hadEffectiveJournalEvents = false
    const eventEffects: AppliedEventEffect[] = []

    const serviceName = this.#serviceNamesByQueryId.get(queryId)
    const touched = this.#transactOverServiceByName(serviceName ?? '', (service, touch) => {
      const query = service.queries.get(queryId)
      if (!query) return
      touch(queryId)

      const getId = this.#getIdReader(query.desc.serviceName)
      const data = result.data
      const responseItems = Array.isArray(data) ? data : data == null ? [] : [data]
      const isProjection = isProjectionQuery(queryOfParams(query.desc.params))
      const responseMode: FetchResponseMode =
        query.config.realtime === 'disabled' ? 'snapshot' : isProjection ? 'projection' : 'entity'
      const rebasePlan = planFetchRebase({
        responseItems,
        journalEvents,
        getId,
        isItemStale: (current, next) => this.#adapter.isItemStale(current, next),
      })
      const fetchedProjectionEvents: QueuedEvent[] = []
      if (responseMode === 'entity') {
        for (const item of responseItems) {
          const itemId = getId(item)
          if (itemId === undefined || rebasePlan.itemIds.has(entityKey(itemId))) continue
          const accepted = this.#acceptLaneAuthoritative(
            query.desc.serviceName,
            'updated',
            item,
            'fetch',
            cause,
          )
          if (!accepted.handled || !accepted.projection) continue
          const projectionEvent = this.#queuedProjectionEvent(accepted.projection, cause)
          if (projectionEvent) fetchedProjectionEvents.push(projectionEvent)
        }
      }

      if (fetchedProjectionEvents.length > 0) {
        eventEffects.push(
          ...this.#applyServiceEvents({
            service,
            serviceName: query.desc.serviceName,
            events: fetchedProjectionEvents,
            touch,
            excludeQueryId: queryId,
          }),
        )
      }

      const activeOverlayEvents = this.#activeMutationOverlayEvents(query.desc.serviceName)
      const overlayEvents = query.config.realtime === 'disabled' ? [] : activeOverlayEvents
      const effectiveJournalEvents = [...rebasePlan.events, ...overlayEvents]
      hadEffectiveJournalEvents = rebasePlan.events.length > 0
      const latestEventById = new Map(rebasePlan.latestEventById)
      const journaledItemIds = new Set(rebasePlan.itemIds)
      for (const event of overlayEvents) {
        latestEventById.set(event.itemId, event)
        this.#mutationLanes.deferQueryIds(event.mutationLaneKey, [queryId])
      }
      for (const event of activeOverlayEvents) journaledItemIds.add(event.itemId)

      const findConfig = query.config as FindQueryConfig<unknown, unknown>
      const isCompleteSet =
        query.desc.method === 'find' &&
        Boolean(findConfig.allPages) &&
        isUnfilteredFindQuery(query.desc.params)
      const previousEntities = isCompleteSet ? new Map(service.entities) : null
      const meta = (result as { meta?: TMeta }).meta
      const pageInfo = 'pageInfo' in result ? result.pageInfo : undefined
      const rebasedResponse = rebaseResponseData({
        data,
        mode: responseMode,
        latestEventById,
        entities: service.entities,
        getId,
        isItemStale: (current, next) => this.#adapter.isItemStale(current, next),
        canKeepCurrentItem: item =>
          !(
            query.desc.method === 'find' &&
            query.config.realtime === 'merge' &&
            !isServerMaintained(query.classification) &&
            !query.filterItem(item)
          ),
      })
      const nextItemIds = new Set(rebasedResponse.itemIds)

      // Projected (`$select`) rows are correct for this query's own result but are
      // not full entities — never write them to the entity cache, which must hold
      // only complete rows for the materialized local-answer paths to be sound
      // (isItemStale can't catch a projection: same updatedAt as the row it shadows).
      const fetchedEvents: ProcessedCacheEvent[] = []
      const fetchedRows: QueuedEvent[] = []
      if (!isProjection) {
        for (const item of rebasedResponse.items) {
          const id = getId(item)
          if (id === undefined || journaledItemIds.has(entityKey(id))) continue
          fetchedRows.push({
            mode: 'server',
            source: 'fetch',
            serviceName: query.desc.serviceName,
            type: service.entities.has(entityKey(id)) ? 'updated' : 'created',
            item,
            ...(cause === undefined ? {} : { cause }),
          })
        }
      }
      applyEventsToService({
        service,
        serviceName: query.desc.serviceName,
        events: fetchedRows,
        getId,
        isItemStale: (current, next) => this.#adapter.isItemStale(current, next),
        processedEvents: fetchedEvents,
      })

      // `nextItemIds` is also the complete-set diff input. Rebase its membership
      // to the last in-flight event so a stale root response cannot delete a
      // created row or resurrect a removed one service-wide.
      for (const [itemId, event] of latestEventById) {
        if (event.type === 'removed') {
          nextItemIds.delete(itemId)
        } else if (isCompleteSet) {
          nextItemIds.add(itemId)
        }
      }

      shouldRefetch = query.dirty

      // A successful unfiltered allPages fetch (`.all()` with no filters) means the
      // complete row set is now local: mark the service materialized so matcher-
      // decidable finds are answered from the cache (see #selectMaterializedFind). A *filtered*
      // allPages fetch is complete only for its own filter — it must not materialize
      // the service.
      if (isCompleteSet) {
        const previousRoot = service.materialized?.queryId
        if (previousRoot && previousRoot !== queryId && this.#listenerCount(previousRoot) === 0) {
          this.#retention.retain(previousRoot)
        }
        service.materialized = { queryId, fetchedAt: Date.now() }
      }

      commitQuery(service, {
        ...query,
        fetchedAt: Date.now(),
        state: {
          status: 'success' as const,
          data: rebasedResponse.data,
          meta: meta || this.#adapter.emptyMeta(),
          ...(pageInfo ? { pageInfo } : {}),
          isFetching: false,
          error: null,
        },
      })

      const changes = previousEntities
        ? diffCompleteSet({
            service,
            serviceName: query.desc.serviceName,
            previousEntities,
            nextItemIds,
            ignoredItemIds: journaledItemIds,
          })
        : fetchedEvents
      eventEffects.push(
        ...this.#updateQueriesForEvents({
          service,
          serviceName: query.desc.serviceName,
          processedEvents: changes.map(event =>
            cause === undefined ? event : { ...event, cause },
          ),
          touch,
          excludeQueryId: queryId,
        }),
      )

      if (effectiveJournalEvents.length > 0 && responseMode === 'entity') {
        replayFetchedQueryFromEvents({
          service,
          queryId,
          events: effectiveJournalEvents,
          touch,
          getId,
          itemAdded: meta => this.#adapter.itemAdded(meta),
          itemRemoved: meta => this.#adapter.itemRemoved(meta),
          defaultSort: this.#defaultSort,
        })
      }
    })
    // Discovering a row in another query does not establish that it was created
    // during this fetch. Only revisions of already-known entities belong in replay.
    this.#fetchEventJournal.record(
      eventEffects
        .map(({ event }) => event)
        .filter(
          event =>
            !(event.mode === 'server' && event.source === 'fetch' && event.previousItem === null),
        ),
    )
    this.#notify(touched)

    // Fetch diffs share event publication with realtime, except they cannot
    // trigger refetch-mode queries: a refetch-on-diff would cycle.
    const publishedEffects = this.#publishServiceEventEffects(
      serviceName ?? '',
      eventEffects,
      'none',
    )
    const serverMaintainedQueriesToRefetch = publishedEffects.reconcileQueryIds

    const query = this.#getQuery(queryId)
    const service = serviceName === undefined ? undefined : this.#state.get(serviceName)
    const isMaterializedRoot = service?.materialized?.queryId === queryId
    const shouldRunFollowup = this.#listenerCount(queryId) > 0 || isMaterializedRoot

    if (shouldRefetch && shouldRunFollowup) {
      serverMaintainedQueriesToRefetch.delete(queryId)
      this.#queue(queryId, this.#takeFollowupFetchContext(queryId))
    } else if (hadEffectiveJournalEvents && query?.config.realtime !== 'disabled') {
      // Even exact replay cannot prove every server-maintained membership/order
      // edge. One gated trailing reconciliation guarantees convergence.
      serverMaintainedQueriesToRefetch.add(queryId)
    }

    for (const id of serverMaintainedQueriesToRefetch) {
      this.#reconciliation.request(id, {
        force: id === service?.materialized?.queryId,
        ...(publishedEffects.reconcileCauses.has(id)
          ? { causes: publishedEffects.reconcileCauses.get(id)! }
          : {}),
      })
    }
  }

  #fetchFailed({ queryId, error }: { queryId: string; error: Error }): void {
    let shouldRefetch = false

    const touched = this.#transactOverService(queryId, (service, query) => {
      if (!query) return

      shouldRefetch = query.dirty

      commitQuery(service, {
        ...query!,
        state: {
          status: 'error' as const,
          data: null,
          meta: this.#adapter.emptyMeta(),
          isFetching: false,
          error,
        },
      })
    })
    this.#notify(touched)

    const serviceName = this.#serviceNamesByQueryId.get(queryId)
    const isMaterializedRoot =
      serviceName !== undefined && this.#state.get(serviceName)?.materialized?.queryId === queryId
    if (shouldRefetch && (this.#listenerCount(queryId) > 0 || isMaterializedRoot)) {
      this.#queue(queryId, this.#takeFollowupFetchContext(queryId))
    }
  }

  /** Discard an unsafe response and reconcile from a fresh journal cursor. */
  #discardFetchedResponse(queryId: string): void {
    const touched = this.#transactOverService(queryId, (service, query) => {
      if (!query) return
      commitQuery(service, {
        ...query,
        state: { ...query.state, isFetching: false },
      })
    })

    const serviceName = this.#serviceNamesByQueryId.get(queryId)
    const isMaterializedRoot =
      serviceName !== undefined && this.#state.get(serviceName)?.materialized?.queryId === queryId
    this.#reconciliation.request(queryId, {
      force: isMaterializedRoot,
      ...this.#causeContext('fetch-rebase'),
    })
    // An immediate reconciliation has already restored isFetching=true; hidden
    // or inactive queries expose the settled state and remain pending instead.
    this.#notify(touched)
  }

  #recordFetchStats(queryId: string, entry: QueryFetchHistoryEntry): void {
    const { ok, durationMs } = entry
    const current = this.#queryStats.get(queryId) ?? {
      fetchCount: 0,
      errorCount: 0,
      totalDurationMs: 0,
      history: [],
    }
    this.#queryStats.set(queryId, {
      fetchCount: current.fetchCount + 1,
      errorCount: current.errorCount + (ok ? 0 : 1),
      totalDurationMs: current.totalDurationMs + durationMs,
      lastDurationMs: durationMs,
      history: [...current.history.slice(-(QUERY_FETCH_HISTORY_LIMIT - 1)), entry],
    })
  }

  // Realtime event handling
  #subscribeToRealtime(queryId: string): void {
    const query = this.#getQuery(queryId)
    if (!query) return

    this.#subscribeToRealtimeService(query.desc.serviceName)
  }

  #subscribeToRealtimeService(serviceName: string): void {
    // check if already subscribed to the events of this service
    if (this.#disposed || this.#realtime.has(serviceName)) return
    if (!this.#adapter.subscribe) return // Real-time not supported by this adapter

    const created = (item: unknown) => this.#queueEvent(serviceName, { type: 'created', item })
    const updated = (item: unknown) => this.#queueEvent(serviceName, { type: 'updated', item })
    const patched = (item: unknown) => this.#queueEvent(serviceName, { type: 'patched', item })
    const removed = (item: unknown) => this.#queueEvent(serviceName, { type: 'removed', item })

    const unsubscribe = this.#adapter.subscribe(serviceName, {
      created,
      updated,
      patched,
      removed,
    })
    this.#realtime.set(serviceName, unsubscribe)
  }

  #emitRealtime(serviceName: string, type: Event['type'], item: unknown): TraceCause | undefined {
    if (!this.#telemetry.active) return undefined
    const cause = this.#telemetry.cause('realtime')
    this.#telemetry.emit({
      kind: 'realtime',
      ...(cause ? { traceId: cause.traceId } : {}),
      serviceName,
      type,
      itemId: this.#getIdWarn(serviceName, item),
      item,
    })
    return cause
  }

  /** Push an authoritative event onto the atomic queue. */
  #enqueueAuthoritativeEvent(
    serviceName: string,
    event: Event,
    source: 'realtime' | 'mutation',
    cause?: TraceCause,
  ): void {
    this.#eventQueue.push({
      mode: 'server',
      source,
      serviceName,
      type: event.type,
      item: event.item,
      ...(cause ? { cause } : {}),
    })
  }

  #queuedProjectionEvent(change: ProjectionChange, cause?: TraceCause): QueuedEvent | null {
    const event = this.#projectionEvent(change)
    if (!event) return null
    return {
      mode: 'optimistic',
      serviceName: change.lane.serviceName,
      type: event.type,
      item: event.item,
      mutationLaneKey: change.lane.key,
      ...(cause === undefined ? {} : { cause }),
    }
  }

  /** Apply an event immediately — used for mutation results and optimistic writes. */
  #processEvent(serviceName: string, event: Event, cause?: TraceCause): void {
    this.#ingestAuthoritativeEvent(serviceName, event, {
      immediate: true,
      source: 'mutation',
      ...(cause ? { cause } : {}),
    })
  }

  /** Queue a realtime event for batched processing. */
  #queueEvent(serviceName: string, event: Event): void {
    this.#ingestAuthoritativeEvent(serviceName, event, {
      immediate: false,
      source: 'realtime',
    })
  }

  #ingestAuthoritativeEvent(
    serviceName: string,
    event: Event,
    context:
      | { immediate: false; source: 'realtime' }
      | { immediate: true; source: 'mutation'; cause?: TraceCause },
  ): void {
    if (this.#disposed) return
    const items = Array.isArray(event.item) ? event.item : [event.item]
    for (const item of items) {
      const cause =
        context.source === 'realtime'
          ? this.#emitRealtime(serviceName, event.type, item)
          : context.cause
      const accepted = this.#acceptLaneAuthoritative(
        serviceName,
        event.type,
        item,
        context.source,
        cause,
      )
      if (!accepted.handled) {
        this.#enqueueAuthoritativeEvent(
          serviceName,
          { type: event.type, item },
          context.source,
          cause,
        )
        continue
      }
      if (accepted.projection) this.#applyProjection(accepted.projection, false, cause)
    }

    if (this.#eventQueue.length === 0) return

    if (context.immediate) {
      this.#processQueuedEvents()
      return
    }

    if (!this.#eventBatchProcessingTimer && !this.#processingEventQueue) {
      // process all events in a short interval as a batch later
      if (this.#eventBatchInterval) {
        this.#eventBatchProcessingTimer = setTimeout(() => {
          this.#eventBatchProcessingTimer = null
          this.#processQueuedEvents()
        }, this.#eventBatchInterval)
      } else {
        // batching is disabled, process each event immediately
        this.#processQueuedEvents()
      }
    }
  }

  #acceptLaneAuthoritative(
    serviceName: string,
    type: Event['type'],
    item: unknown,
    source: 'realtime' | 'mutation' | 'fetch',
    cause?: TraceCause,
  ): LaneAuthoritativeAcceptance {
    const id = this.#peekId(item)
    const lane = id === undefined ? undefined : this.#mutationLanes.get(serviceName, id)
    if (!lane) return { handled: false }
    const transition = this.#mutationLanes.acceptAuthoritative(lane, type, item, (current, next) =>
      this.#adapter.isItemStale(current, next),
    )
    if (!transition) return { handled: true, projection: null }
    this.#fetchEventJournal.record([
      {
        ...transition.event,
        source,
        ...(cause === undefined ? {} : { cause }),
      },
    ])
    return { handled: true, projection: transition.projection }
  }

  #applyServiceEvents({
    service,
    serviceName,
    events,
    touch,
    excludeQueryId,
  }: {
    service: ServiceState<TMeta>
    serviceName: string
    events: QueuedEvent[]
    touch: (queryId: string) => void
    excludeQueryId?: string
  }): AppliedEventEffect[] {
    const getId = this.#getIdReader(serviceName)
    const processedEvents: ProcessedCacheEvent[] = []
    applyEventsToService({
      service,
      serviceName,
      events,
      getId,
      isItemStale: (current, next) => this.#adapter.isItemStale(current, next),
      processedEvents,
    })
    return this.#updateQueriesForEvents({
      service,
      serviceName,
      processedEvents,
      touch,
      ...(excludeQueryId ? { excludeQueryId } : {}),
    })
  }

  #updateQueriesForEvents({
    service,
    serviceName,
    processedEvents,
    touch,
    excludeQueryId,
  }: {
    service: ServiceState<TMeta>
    serviceName: string
    processedEvents: readonly ProcessedCacheEvent[]
    touch: (queryId: string) => void
    excludeQueryId?: string
  }): AppliedEventEffect[] {
    if (processedEvents.length === 0) return []
    const selectedQueries = new Set<string>()
    const changedQueries = new Set<string>()
    for (const [queryId, query] of service.queries) {
      if (queryId === excludeQueryId) continue
      const result = this.#reapplyMaterializedFind(service, query)
      if (result === 'unavailable') continue
      selectedQueries.add(queryId)
      if (result === 'changed') {
        changedQueries.add(queryId)
        touch(queryId)
      }
    }
    const getId = this.#getIdReader(serviceName)
    return processedEvents.map(event => {
      const reconcileQueryIds = new Set<string>()
      const queryEffects = this.#telemetry.active
        ? new Map<string, 'merged' | 'reconcile'>(
            [...changedQueries].map(queryId => [queryId, 'merged']),
          )
        : undefined
      updateQueriesFromEvents({
        service,
        appliedItems: [event],
        excludeQueryIds: selectedQueries,
        touch,
        getId,
        itemAdded: meta => this.#adapter.itemAdded(meta),
        itemRemoved: meta => this.#adapter.itemRemoved(meta),
        serverMaintainedQueriesToRefetch: reconcileQueryIds,
        ...(queryEffects
          ? {
              onEffect: (queryId: string, effect: 'merged' | 'reconcile') =>
                queryEffects.set(queryId, effect),
            }
          : {}),
        ...(excludeQueryId ? { excludeQueryId } : {}),
        defaultSort: this.#defaultSort,
      })
      return { event, reconcileQueryIds, ...(queryEffects ? { queryEffects } : {}) }
    })
  }

  #publishServiceEventEffects(
    serviceName: string,
    effects: readonly AppliedEventEffect[],
    refetchPolicy: 'realtime' | 'none',
  ): PublishedEventEffects {
    const immediateReconciles = new Set<string>()
    const reconcileCauses = new Map<string, TraceCause[]>()
    const fallbackCauses = this.#telemetry.active
      ? new Map<ProcessedCacheEvent, TraceCause | undefined>()
      : undefined
    const causeFor = (event: ProcessedCacheEvent): TraceCause | undefined => {
      if (event.cause) return event.cause
      if (!fallbackCauses) return undefined
      if (!fallbackCauses.has(event)) {
        fallbackCauses.set(event, this.#telemetry.fallbackCause(event))
      }
      return fallbackCauses.get(event)
    }
    const hasAuthoritative =
      refetchPolicy === 'realtime' && effects.some(effect => effect.event.mode === 'server')
    const addReconcile = (queryId: string, cause?: TraceCause) => {
      immediateReconciles.add(queryId)
      if (!cause) return
      const merged = this.#telemetry.merge(reconcileCauses.get(queryId), [cause])
      if (merged) reconcileCauses.set(queryId, merged)
    }

    for (const { event, reconcileQueryIds, queryEffects } of effects) {
      const cause = causeFor(event)
      const deferred =
        event.mode === 'optimistic' &&
        this.#mutationLanes.deferQueryIds(event.mutationLaneKey, reconcileQueryIds)
      if (!deferred) {
        for (const queryId of reconcileQueryIds) addReconcile(queryId, cause)
      }

      // Relational filters need projected dependency changes immediately so
      // they can recompute locally. Their listener distinguishes projections
      // from authoritative events and only the latter may trigger a refetch.
      const projectionSettled =
        event.mode === 'optimistic' &&
        !this.#mutationLanes.deferProjection(event.mutationLaneKey, event)
      this.#emitProcessedEvent(event)
      if (projectionSettled) this.#emitProjectionSettlement(event)

      if (refetchPolicy === 'realtime') {
        const refetchableQueryIds = this.#refetchableQueryIds(serviceName)
        if (event.mode === 'server') {
          for (const queryId of refetchableQueryIds) {
            queryEffects?.set(queryId, 'reconcile')
            addReconcile(queryId, cause)
          }
        } else if (event.mode === 'optimistic' && !hasAuthoritative) {
          const deferred = this.#mutationLanes.deferQueryIds(
            event.mutationLaneKey,
            refetchableQueryIds,
          )
          if (!deferred) {
            for (const queryId of refetchableQueryIds) {
              queryEffects?.set(queryId, 'reconcile')
              addReconcile(queryId, cause)
            }
          }
        }
      }
    }

    for (const { event, queryEffects } of effects) {
      if (!this.#telemetry.active) break
      const cause = causeFor(event)
      this.#telemetry.emit({
        kind: 'cache:updated',
        ...(cause ? { traceId: cause.traceId } : {}),
        source: this.#cacheEventSource(event),
        serviceName: event.serviceName,
        type: event.type,
        itemId: event.itemId,
        item: event.item,
        previousItem: event.previousItem,
        queryEffects: [...(queryEffects ?? [])].map(([queryId, outcome]) => ({ queryId, outcome })),
      })
    }

    return { reconcileQueryIds: immediateReconciles, reconcileCauses }
  }

  #cacheEventSource(
    event: ProcessedCacheEvent,
  ): 'realtime' | 'mutation' | 'fetch' | 'optimistic' | 'devtools' {
    if (event.mode === 'optimistic') return 'optimistic'
    if (event.mode === 'local') return 'devtools'
    return event.source
  }

  #causeContext(kind: TraceCause['kind']): { causes?: TraceCause[] } {
    const cause = this.#telemetry.cause(kind)
    return cause ? { causes: [cause] } : {}
  }

  #processQueuedEvents(): void {
    if (
      this.#processingEventQueue ||
      (this.#eventQueue.length === 0 && this.#appliedEventQueue.length === 0)
    ) {
      return
    }

    this.#processingEventQueue = true
    try {
      while (this.#eventQueue.length > 0 || this.#appliedEventQueue.length > 0) {
        const eventsByService = groupEventsByService(this.#eventQueue)
        const appliedEventsByService = groupEventsByService(this.#appliedEventQueue)
        this.#eventQueue = []
        this.#appliedEventQueue = []

        const touchedQueryIds = new Set<string>()
        const followups: Array<{
          serviceName: string
          effects: AppliedEventEffect[]
        }> = []

        // Apply every service's events before notifying anyone — the batch is the
        // atomicity unit for observers. Notifying per service would let a relational
        // query spanning services A and B compute a wasted intermediate snapshot
        // after A's events but before B's, and non-React subscribers would observe
        // the intermediate state.
        const serviceNames = new Set([
          ...Object.keys(eventsByService),
          ...Object.keys(appliedEventsByService),
        ])
        for (const serviceName of serviceNames) {
          const events = eventsByService[serviceName] ?? []
          const appliedEvents = appliedEventsByService[serviceName] ?? []
          let effects: AppliedEventEffect[] = []
          let appliedEffects: AppliedEventEffect[] = []

          const modifiedQueries = this.#transactOverServiceByName(serviceName, (service, touch) => {
            if (events.length > 0) {
              effects = this.#applyServiceEvents({
                service,
                serviceName,
                events,
                touch,
              })
            }
            if (appliedEvents.length > 0) {
              appliedEffects = this.#updateQueriesForEvents({
                service,
                serviceName,
                processedEvents: appliedEvents,
                touch,
              })
            }
          })

          // Record only events that actually changed the entity cache. The fetch
          // rebase replays these over any response snapshot dispatched earlier.
          this.#fetchEventJournal.record(effects.map(({ event }) => event))

          for (const queryId of modifiedQueries) {
            touchedQueryIds.add(queryId)
          }
          followups.push({ serviceName, effects: [...effects, ...appliedEffects] })
        }

        // Notify once per batch, after all services have applied.
        for (const queryId of touchedQueryIds) {
          this.#invokeListeners(queryId)
        }
        if (touchedQueryIds.size > 0) {
          this.#invokeGlobalListeners()
        }

        for (const { serviceName, effects } of followups) {
          const publishedEffects = this.#publishServiceEventEffects(
            serviceName,
            effects,
            'realtime',
          )
          // Server-maintained queries can't merge events locally: reconcile active
          // ones through the gate (cooldown + hidden-tab deferral); the gate marks
          // inactive cached ones pending so their next subscription reconciles.
          for (const queryId of publishedEffects.reconcileQueryIds) {
            this.#reconciliation.request(queryId, {
              ...(publishedEffects.reconcileCauses.has(queryId)
                ? { causes: publishedEffects.reconcileCauses.get(queryId)! }
                : {}),
            })
          }
        }
      }
    } finally {
      this.#processingEventQueue = false
    }
  }

  #emitProcessedEvent(event: ProcessedCacheEvent): void {
    for (const listener of this.#processedEventListeners) {
      try {
        listener(event)
      } catch {
        // Internal invalidation listeners should not break the event loop.
      }
    }
  }

  #emitProjectionSettlement(event: ProcessedProjectionEvent): void {
    for (const listener of this.#projectionSettlementListeners) {
      try {
        listener(event)
      } catch {
        // Internal invalidation listeners should not break mutation settlement.
      }
    }
  }

  #refetchableQueryIds(serviceName: string): string[] {
    const service = this.getState().get(serviceName)
    if (!service) return []
    return [...service.queries.values()]
      .filter(
        query => query.config.realtime === 'refetch' && this.#listenerCount(query.queryId) > 0,
      )
      .map(query => query.queryId)
  }

  /**
   * The reconciliation gate. Every EVENT-DRIVEN refetch (server-window /
   * server-authoritative queries reacting to realtime events, `realtime:
   * 'refetch'` queries, and the reconnect sweep) passes through here — manual
   * `refetch()`, first fetches, and SWR revalidation do not.
   *
   * Correctness contract: a reconciliation may be delayed and coalesced, never
   * dropped — the trailing refetch (or the drain-on-visible) always lands on
   * the latest server state after the last relevant event.
   *
   * - Hidden tab → defer: mark the query pending (truthful in `inspect()`) and
   *   reconcile once when the tab becomes visible. Local-exact merges are
   *   unaffected — only network reconciliation pauses.
   * - Cooldown: the first event in a window refetches immediately (leading
   *   edge — isolated changes stay as fast as today); further events within
   *   `reconcileCooldown` coalesce into one guaranteed trailing refetch.
   */
  #prepareReconcile(
    queryId: string,
    force: boolean,
  ): 'missing' | 'inactive' | 'local' | 'hidden' | 'network' {
    if (!this.#getQuery(queryId)) return 'missing'
    if (!force && this.#listenerCount(queryId) === 0) return 'inactive'

    let selected = false
    let changed = false
    const touched = this.#transactOverService(queryId, (service, query) => {
      if (!query) return
      const result = this.#reapplyMaterializedFind(service, query)
      selected = result !== 'unavailable'
      changed = result === 'changed'
    })
    if (selected) {
      if (changed) this.#notify(touched)
      return 'local'
    }
    return this.#visibility.isHidden() ? 'hidden' : 'network'
  }

  #emitReconcileDecision(
    queryId: string,
    decision: 'fetch-now' | 'coalesced' | 'deferred-hidden' | 'inactive',
    causes: readonly TraceCause[] | undefined,
  ): void {
    const serviceName = this.#serviceNamesByQueryId.get(queryId)
    if (serviceName !== undefined) {
      this.#telemetry.emit({
        kind: 'reconcile:decision',
        queryId,
        serviceName,
        decision,
        ...(causes ? { causes } : {}),
      })
    }
  }

  #emitReconcileStarted(queryId: string, causes: readonly TraceCause[] | undefined): void {
    const serviceName = this.#serviceNamesByQueryId.get(queryId)
    if (serviceName !== undefined) {
      this.#telemetry.emit({
        kind: 'reconcile:started',
        queryId,
        serviceName,
        ...(causes ? { causes } : {}),
      })
    }
  }

  #visibilityChanged(): void {
    if (this.#visibility.isHidden()) {
      this.#hiddenAt ??= Date.now()
      return
    }

    const hiddenAt = this.#hiddenAt
    this.#hiddenAt = null
    const now = Date.now()
    const sleptPastStaleTime = hiddenAt !== null && now - hiddenAt >= this.#staleTime
    if (sleptPastStaleTime) {
      this.#markReconciliationPending(
        query => !isWithinStaleTime(query.fetchedAt, this.#staleTime, now),
      )
    }
    const reconciled = this.#reconciliation.drainHidden()
    if (!sleptPastStaleTime) return

    const queries = this.#activePendingReconciliationQueries().filter(
      query => !reconciled.has(query.queryId),
    )
    this.#refetchActiveQueries(queries, this.#telemetry.cause('visibility'))
  }

  /**
   * Manually refetch cached queries — the escape hatch for changes figbird cannot
   * observe: custom methods on services without realtime events, out-of-band writes,
   * eventless integrations. Scoped to one service, or the whole store when called
   * with no argument.
   *
   * Manual intent is never gated: active queries refetch immediately (no reconcile
   * cooldown, no hidden-tab deferral); inactive cached queries are marked pending so
   * their next subscriber refetches; a materialized `.all()` root refetches even
   * with no subscribers, since local reads depend on its completeness.
   */
  refetchQueries(serviceName?: string): void {
    for (const [name, service] of this.getState()) {
      if (serviceName !== undefined && name !== serviceName) continue
      for (const query of service.queries.values()) {
        if (query.config.skip) continue
        const active = this.#listenerCount(query.queryId) > 0
        const isMaterializedRoot = query.queryId === service.materialized?.queryId
        if (active || isMaterializedRoot) {
          // `refetch()` marks an in-flight query dirty, guaranteeing exactly one
          // follow-up instead of dispatching a second fetch in the same generation.
          this.refetch(query.queryId)
        } else {
          this.#reconciliation.markPending(query.queryId)
        }
      }
    }
  }

  #markReconciliationPending(
    shouldMark: (query: Query<unknown, TMeta, unknown>) => boolean = () => true,
  ): void {
    for (const service of this.getState().values()) {
      if (service.materialized) {
        const root = service.queries.get(service.materialized.queryId)
        if (root && shouldMark(root)) this.#reconciliation.markPending(root.queryId)
      }
      for (const query of service.queries.values()) {
        if (query.queryId === service.materialized?.queryId) continue
        if (this.#reconcilesAfterMissedEvents(query) && shouldMark(query)) {
          this.#reconciliation.markPending(query.queryId)
        }
      }
    }
  }

  #reconcilesAfterMissedEvents(query: Query<unknown, TMeta, unknown>): boolean {
    return (
      !query.config.skip &&
      (query.config.realtime !== 'disabled' || this.#reconnectQueryIds.has(query.queryId))
    )
  }

  #activePendingReconciliationQueries(): Array<{ queryId: string; force: boolean }> {
    const queryIds = new Map<string, boolean>()
    for (const service of this.getState().values()) {
      // Materialization roots reconcile even with no subscribers — every local read
      // depends on their completeness, and events may have been missed while offline.
      if (service.materialized) {
        const root = service.queries.get(service.materialized.queryId)
        if (root && this.#reconciliation.isPending(root.queryId)) queryIds.set(root.queryId, true)
      }
      for (const query of service.queries.values()) {
        if (query.queryId === service.materialized?.queryId) continue
        if (
          this.#reconciliation.isPending(query.queryId) &&
          this.#reconcilesAfterMissedEvents(query) &&
          this.#listenerCount(query.queryId) > 0
        ) {
          queryIds.set(query.queryId, false)
        }
      }
    }
    return [...queryIds].map(([queryId, force]) => ({ queryId, force }))
  }

  #refetchActiveQueries(
    queries: readonly { queryId: string; force: boolean }[],
    cause?: TraceCause,
  ): void {
    for (const query of queries) {
      this.#reconciliation.request(query.queryId, {
        force: query.force,
        ...(cause === undefined ? {} : { causes: [cause] }),
      })
    }
  }

  #scheduleReconnectSweep(traceId: number | undefined): void {
    this.#markReconciliationPending()
    if (this.#reconnectSweepTimer) return
    const [min, max] = this.#reconnectJitter
    const delay = min === max ? min : min + Math.floor(Math.random() * (max - min + 1))
    if (delay === 0) {
      const queries = this.#activePendingReconciliationQueries()
      this.#telemetry.emit({
        kind: 'reconnect:sweep',
        ...(traceId === undefined ? {} : { traceId }),
        phase: 'started',
        delayMs: 0,
        queryCount: queries.length,
      })
      this.#refetchActiveQueries(
        queries,
        traceId === undefined ? undefined : { kind: 'reconnect', traceId },
      )
      return
    }

    this.#telemetry.emit({
      kind: 'reconnect:sweep',
      ...(traceId === undefined ? {} : { traceId }),
      phase: 'scheduled',
      delayMs: delay,
    })

    const timer = setTimeout(() => {
      this.#reconnectSweepTimer = null
      const queries = this.#activePendingReconciliationQueries()
      this.#telemetry.emit({
        kind: 'reconnect:sweep',
        ...(traceId === undefined ? {} : { traceId }),
        phase: 'started',
        delayMs: delay,
        queryCount: queries.length,
      })
      this.#refetchActiveQueries(
        queries,
        traceId === undefined ? undefined : { kind: 'reconnect', traceId },
      )
    }, delay)
    ;(timer as { unref?: () => void }).unref?.()
    this.#reconnectSweepTimer = timer
  }

  #normalizeReconnectJitter(value: ReconnectJitter): readonly [number, number] {
    if (typeof value === 'number') {
      return [0, Math.max(0, value)]
    }
    const first = Math.max(0, value[0])
    const second = Math.max(0, value[1])
    return first <= second ? [first, second] : [second, first]
  }

  // Optimistic mutation support
  #getEntity(serviceName: string, id: string | number): unknown {
    const service = this.#state.get(serviceName)
    if (!service) return null
    return service.entities.get(entityKey(id)) ?? null
  }

  /**
   * Id read for event and fetch paths, where a missing id means data figbird can't
   * track — warn so the integration bug is visible. Presence checks use #peekId.
   */
  #getIdWarn(serviceName: string, item: unknown): string | number | undefined {
    const id = this.#adapter.getId(item)
    if (id === undefined && !this.#warnedMissingIdServices.has(serviceName)) {
      this.#warnedMissingIdServices.add(serviceName)
      console.warn(`An item has been received without any ID from "${serviceName}"`, item)
    }
    return id
  }

  #getIdReader(serviceName: string): (item: unknown) => ItemId | undefined {
    return item => this.#getIdWarn(serviceName, item)
  }

  /** Warn-free id read — presence checks on payloads that may lack ids. */
  #peekId(item: unknown): string | number | undefined {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined
    return this.#adapter.getId(item)
  }

  // State management
  #getQuery(queryId: string): Query<unknown, TMeta, unknown> | undefined {
    const serviceName = this.#serviceNamesByQueryId.get(queryId)
    if (serviceName) {
      const service = this.getState().get(serviceName)
      if (service) {
        return service.queries.get(queryId)
      }
    }
    return undefined
  }

  /** Notify listeners of the touched queries synchronously, then global listeners. */
  #notify(queryIds: Set<string>): void {
    if (queryIds.size === 0) return
    for (const queryId of queryIds) {
      this.#invokeListeners(queryId)
    }
    this.#invokeGlobalListeners()
  }

  /**
   * Invoke listeners on the next microtask instead of synchronously, coalescing
   * repeated schedules. Used for transitions that can happen while React is
   * rendering: subscribing to a query can start a fetch synchronously (including
   * from `suspensePromise()` during render), and the resulting isFetching
   * transition must not fire other components' `onStoreChange` mid-render —
   * React warns with "Cannot update a component while rendering a different
   * component". Listeners read the *current* state when invoked, so deferring
   * never delivers a stale snapshot.
   */
  #scheduleDeferredNotify(queryIds: Set<string>): void {
    if (this.#deferredNotifyQueryIds) {
      for (const queryId of queryIds) {
        this.#deferredNotifyQueryIds.add(queryId)
      }
      return
    }
    this.#deferredNotifyQueryIds = new Set(queryIds)
    queueMicrotask(() => {
      const ids = this.#deferredNotifyQueryIds
      this.#deferredNotifyQueryIds = null
      if (!ids || ids.size === 0) return
      for (const queryId of ids) {
        this.#invokeListeners(queryId)
      }
      this.#invokeGlobalListeners()
    })
  }

  /**
   * Run `fn` over a query's service state, collecting touched query ids. Transactions
   * never notify — notification is an explicit follow-up at the call site
   * (`#notify` for synchronous delivery, `#scheduleDeferredNotify` for render-safe
   * deferral), so the policy is readable where it applies.
   */
  #transactOverService(
    queryId: string,
    fn: (service: ServiceState<TMeta>, query?: Query<unknown, TMeta, unknown>) => void,
  ): Set<string> {
    const serviceName = this.#serviceNamesByQueryId.get(queryId)
    if (!serviceName) return new Set()

    return this.#transactOverServiceByName(serviceName, (service, touch) => {
      fn(service, service.queries.get(queryId))
      touch(queryId)
    })
  }

  /** See #transactOverService — same contract, keyed by service name. */
  #transactOverServiceByName(
    serviceName: string,
    fn: (service: ServiceState<TMeta>, touch: (queryId: string) => void) => void,
  ): Set<string> {
    if (this.#disposed || !serviceName) return new Set()

    // initialise the service structure if needed
    if (!this.getState().get(serviceName)) {
      this.getState().set(serviceName, createServiceState(this.#getIdReader(serviceName)))
    }

    const modifiedQueries = new Set<string>()
    const touch = (queryId: string) => modifiedQueries.add(queryId)
    const service = this.#state.get(serviceName)
    if (service) {
      fn(service, touch)
    }
    return modifiedQueries
  }

  #vacuum({ queryId }: { queryId: string }): void {
    const serviceName = this.#serviceNamesByQueryId.get(queryId)
    this.#retention.cancel(queryId)
    this.#followupFetchContexts.delete(queryId)
    this.#reconciliation.forget(queryId)
    this.#transactOverService(queryId, (service, query) => {
      if (query) {
        deleteQuery(service, queryId)
        this.#serviceNamesByQueryId.delete(queryId)
        this.#queryGenerations.delete(queryId)
        this.#queryStats.delete(queryId)
        if (service.materialized?.queryId === queryId) {
          delete service.materialized
        }
      }
    })
    if (serviceName) this.#pruneService(serviceName)
  }

  #pruneService(serviceName: string): void {
    const service = this.#state.get(serviceName)
    if (service?.materialized || this.#dependencyOwners.has(serviceName)) return
    if (service) {
      for (const key of service.entities.keys()) {
        if (!service.itemQueryIndex.has(key) && !this.#mutationLanes.get(serviceName, key)) {
          service.entities.delete(key)
        }
      }
      if (service.queries.size > 0 || service.entities.size > 0) return
      this.#state.delete(serviceName)
    }
    this.#realtime.get(serviceName)?.()
    this.#realtime.delete(serviceName)
  }

  // Internal helpers
  #createItemFilter<T, TQueryType>(
    desc: QueryDescriptor,
    config: QueryConfig<T, TQueryType>,
    classification: StoredQueryClass,
  ): ItemMatcher<ElementType<T>> {
    // if this query is not using the realtime mode
    // we will never be merging events into the cache
    // and will never call the matcher, so to avoid
    // the issue where custom query filters or operators
    // cause the default matcher to throw an error without
    // additional configuration, let's avoid creating a matcher
    // altogether
    if (config.realtime !== 'merge') {
      return () => false
    }

    // Server-authoritative queries never merge events locally — they refetch, and
    // their predicates ($regex, unknown operators) would throw in the default
    // matcher anyway. Server-window predicates are locally evaluable by
    // construction (anything non-local classifies authoritative), and window
    // maintenance needs them to judge event membership — build the real matcher.
    if (classification === 'server-authoritative') {
      return () => false
    }

    return this.#resolveMatcher(
      desc.serviceName,
      config as QueryConfig<unknown, unknown>,
      queryOfParams(desc.params),
    )
  }

  /**
   * The effective matcher for a query: the per-query `matcher` factory from config
   * wins, else the adapter's. The casts across the typed-factory/unknown-item
   * boundary live here and nowhere else.
   */
  #resolveMatcher(
    serviceName: string,
    config: QueryConfig<unknown, unknown>,
    filters: Record<string, unknown> | undefined,
  ): (item: unknown) => boolean {
    return config.matcher
      ? (config.matcher(filters as never) as (item: unknown) => boolean)
      : (this.#adapter.matcher(filters as TQuery | undefined, undefined, {
          serviceName,
        }) as (item: unknown) => boolean)
  }

  /** Convert mutation descriptor to args array for adapter */
  #buildMutationArgs(desc: MutationDescriptor): unknown[] {
    switch (desc.method) {
      case 'create':
        return desc.params !== undefined ? [desc.data, desc.params] : [desc.data]
      case 'update':
      case 'patch':
        return desc.params !== undefined ? [desc.id, desc.data, desc.params] : [desc.id, desc.data]
      case 'remove':
        return desc.params !== undefined ? [desc.id, desc.params] : [desc.id]
    }
  }

  #addListener<T>(queryId: string, fn: (state: QueryState<T, TMeta>) => void): () => void {
    if (!this.#listeners.has(queryId)) {
      this.#listeners.set(queryId, new Set())
    }
    this.#listeners.get(queryId)!.add(fn as (state: QueryState<unknown, TMeta>) => void)
    return () => {
      const listeners = this.#listeners.get(queryId)
      if (listeners) {
        listeners.delete(fn as (state: QueryState<unknown, TMeta>) => void)
        if (listeners.size === 0) {
          this.#listeners.delete(queryId)
        }
      }
    }
  }

  #invokeListeners(queryId: string): void {
    const listeners = this.#listeners.get(queryId)
    if (listeners) {
      const state = this.getQueryState(queryId)
      if (state) {
        for (const listener of listeners) {
          try {
            listener(state)
          } catch (error) {
            this.#reportListenerError('query', error)
          }
        }
      }
    }
  }

  #addGlobalListener(fn: (state: Map<string, ServiceState<TMeta>>) => void): () => void {
    this.#globalListeners.add(fn)
    return () => {
      this.#globalListeners.delete(fn)
    }
  }

  #invokeGlobalListeners(): void {
    const state = this.getState()
    for (const listener of this.#globalListeners) {
      try {
        listener(state)
      } catch (error) {
        this.#reportListenerError('global', error)
      }
    }
  }

  #reportListenerError(kind: 'query' | 'global', error: unknown): void {
    try {
      console.error(`figbird: ${kind} listener threw`, error)
    } catch {
      // Error reporting must never re-enter or abort the store's update loop.
    }
  }

  #listenerCount(queryId: string): number {
    return this.#listeners.get(queryId)?.size || 0
  }
}
