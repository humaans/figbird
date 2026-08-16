import type {
  FigbirdEvent,
  FigbirdEvents,
  InspectedQuery,
  InspectedCacheService,
  InspectedRelationalQuery,
  MutationActivity,
} from '../core/figbird.js'
import { CappedBuffer } from '../core/cappedBuffer.js'
import { now } from './format.js'
import { PayloadRetention, type PayloadHandle } from './payloadRetention.js'

export interface FigbirdLikeForDevtools {
  events: FigbirdEvents
  mutating?: MutationActivity
  inspect(): InspectedQuery[]
  inspectCache?(): InspectedCacheService[]
  inspectRelational?(): InspectedRelationalQuery[]
  subscribeToStateChanges?(fn: (state: unknown) => void): () => void
}

interface CollectorOptions {
  eventLimit?: number
  heartbeatMs?: number
  payloadLimit?: number
  payloadNodeLimit?: number
  queryHistoryLimit?: number
  snapshotValues?: boolean
  spanLimit?: number
  timelineLimit?: number
  writeLimit?: number
}

export type PayloadRetentionState = 'retained' | 'evicted'

export interface QuerySpan {
  startAt: number
  endAt?: number
  ok?: boolean
  fetchId?: number
  reason?: string
  traceIds?: number[]
  params?: unknown
  paramsState?: PayloadRetentionState
  result?: unknown
  resultState?: PayloadRetentionState
}

export interface QueryRecord extends Omit<
  InspectedQuery,
  'errorCount' | 'fetchCount' | 'lastDurationMs' | 'totalDurationMs'
> {
  /** False when this row is retained history rather than a live store entry. */
  present: boolean
  /** Session total, seeded from the store when collection starts. */
  fetchCount: number
  /** Session total, seeded from the store when collection starts. */
  errorCount: number
  /** Duration of the most recently completed fetch observed in this session. */
  lastDurationMs?: number
  /** Session total, seeded from the store when collection starts. */
  totalDurationMs: number
  spans: QuerySpan[]
  realtimeSeen: number
  reconciles: number
  lastError?: { message: string; at: number; generation: number }
}

export interface DevtoolsEvent {
  id: number
  at: number
  wallAt: number
  event: FigbirdEvent
  payloadState?: PayloadRetentionState
}

export interface TimelineRealtimeEvent {
  at: number
  serviceName: string
  traceId?: number
  type?: Extract<FigbirdEvent, { kind: 'realtime' }>['type']
  itemId?: string | number
  payload?: unknown
  payloadState?: PayloadRetentionState
}

type ConnectionFigbirdEvent = Extract<
  FigbirdEvent,
  {
    kind:
      | 'connection:connected'
      | 'connection:disconnected'
      | 'connection:reconnected'
      | 'connection:error'
      | 'connection:reconnect-failed'
  }
>

export interface TimelineConnectionEvent {
  at: number
  event: ConnectionFigbirdEvent
}

export interface DevtoolsTimeline {
  startedAt: number
  /** Kept for protocol compatibility; the current table no longer needs lane state. */
  laneOrder: string[]
  realtime: TimelineRealtimeEvent[]
  connection: TimelineConnectionEvent[]
  evictedCount?: number
  payloadsEvicted?: number
}

export interface WriteRecord {
  id: string
  type: 'action' | 'mutation'
  status: 'in-flight' | 'success' | 'error' | 'rollback'
  startedAt: number
  startedWallAt: number
  endedAt?: number
  durationMs?: number
  name?: string
  serviceName?: string
  method?: string
  itemId?: string | number
  optimistic?: boolean
  rolledBack?: boolean
  error?: string
  args?: readonly unknown[]
  argsState?: PayloadRetentionState
  traceId?: number
}

export interface DevtoolsSnapshot {
  cache?: DevtoolsCacheService[]
  queries: QueryRecord[]
  relational: InspectedRelationalQuery[]
  events: DevtoolsEvent[]
  timeline: DevtoolsTimeline
  writes: WriteRecord[]
}

export interface DevtoolsCacheEntity {
  id: string
  value: unknown
  queryIds: string[]
  lastChange?: {
    at: number
    wallAt: number
    source: 'realtime' | 'mutation' | 'fetch' | 'optimistic' | 'devtools'
    traceId: number
    type: 'created' | 'updated' | 'patched' | 'removed'
  }
}

export interface DevtoolsCacheService {
  serviceName: string
  materialized?: { queryId: string; fetchedAt: number }
  entities: DevtoolsCacheEntity[]
}

export interface Collector {
  readonly eventLimit: number
  start(): void
  stop(): void
  subscribe(fn: () => void): () => void
  getSnapshot(): DevtoolsSnapshot
  clearEvents(): void
  clearTimeline(): void
  reset(): void
}

type CapturedQueryState = Omit<
  InspectedQuery,
  'errorCount' | 'fetchCount' | 'lastDurationMs' | 'totalDurationMs'
>

interface QueryMetrics {
  activeSpans: Map<number, QuerySpan>
  errorCount: number
  fetchCount: number
  lastDurationMs?: number
  lastError?: QueryRecord['lastError']
  reconciles: number
  realtimeSeen: number
  spans: CappedBuffer<QuerySpan>
  totalDurationMs: number
}

interface InternalQueryRecord {
  current: CapturedQueryState | null
  lastObservedAt: number
  lastKnown: CapturedQueryState
  metrics: QueryMetrics
  serviceRealtimeBaseline: number
}

interface InternalRelationalQuery {
  inspected: InspectedRelationalQuery
  lastObservedAt: number
}

const EMPTY_SNAPSHOT: DevtoolsSnapshot = {
  cache: [],
  queries: [],
  relational: [],
  events: [],
  timeline: { startedAt: 0, laneOrder: [], realtime: [], connection: [] },
  writes: [],
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

function payloadForRetention(event: FigbirdEvent): unknown {
  switch (event.kind) {
    case 'fetch:start':
      return event.params
    case 'realtime':
      return event.item
    case 'cache:updated':
      return { item: event.item, previousItem: event.previousItem }
    case 'mutate:start':
    case 'mutate:update':
    case 'action:start':
      return event.args
    default:
      return undefined
  }
}

function eventWithoutPayload(event: FigbirdEvent): FigbirdEvent {
  switch (event.kind) {
    case 'fetch:start': {
      const { params: _params, ...metadata } = event
      void _params
      return metadata
    }
    case 'realtime': {
      const { item: _item, ...metadata } = event
      void _item
      return metadata
    }
    case 'cache:updated':
      return { ...event, item: undefined, previousItem: null }
    case 'mutate:start':
    case 'action:start': {
      const { args: _args, ...metadata } = event
      void _args
      return metadata
    }
    case 'mutate:update':
      return { ...event, args: [] }
    default:
      return event
  }
}

function snapshotValue<T>(value: T): T {
  if (typeof structuredClone !== 'function') return value
  try {
    return structuredClone(value)
  } catch {
    return value
  }
}

function makeQueryRecord(
  row: InspectedQuery,
  serviceRealtimeBaseline: number,
  observedAt: number,
  spanLimit: number,
): InternalQueryRecord {
  const state = queryState(row)
  return {
    current: state,
    lastObservedAt: observedAt,
    lastKnown: state,
    metrics: {
      activeSpans: new Map(),
      fetchCount: row.fetchCount,
      errorCount: row.errorCount,
      ...(row.lastDurationMs !== undefined ? { lastDurationMs: row.lastDurationMs } : {}),
      totalDurationMs: row.totalDurationMs,
      spans: new CappedBuffer(spanLimit),
      realtimeSeen: 0,
      reconciles: 0,
    },
    serviceRealtimeBaseline,
  }
}

function makePlaceholderQueryState(
  queryId: string,
  serviceName: string,
  method: 'find' | 'get',
  generation: number,
  resourceId?: string | number,
): CapturedQueryState {
  return {
    queryId,
    generation,
    serviceName,
    method,
    ...(resourceId !== undefined ? { resourceId } : {}),
    query: undefined,
    classification: method === 'get' ? 'get' : 'server-authoritative',
    status: 'loading',
    isFetching: true,
    itemCount: 0,
    fetchedAt: undefined,
    subscriberCount: 0,
  }
}

function makePlaceholderQueryRecord(
  state: CapturedQueryState,
  serviceRealtimeBaseline: number,
  observedAt: number,
  present: boolean,
  spanLimit: number,
): InternalQueryRecord {
  return {
    current: present ? state : null,
    lastKnown: state,
    lastObservedAt: observedAt,
    metrics: {
      activeSpans: new Map(),
      fetchCount: 0,
      errorCount: 0,
      totalDurationMs: 0,
      spans: new CappedBuffer(spanLimit),
      realtimeSeen: 0,
      reconciles: 0,
    },
    serviceRealtimeBaseline,
  }
}

function queryState({
  errorCount: _errorCount,
  fetchCount: _fetchCount,
  lastDurationMs: _lastDurationMs,
  totalDurationMs: _totalDurationMs,
  ...state
}: InspectedQuery): CapturedQueryState {
  return state
}

function toPublicQueryRecord(record: InternalQueryRecord): QueryRecord {
  const state =
    record.current ??
    ({
      ...record.lastKnown,
      isFetching: false,
      subscriberCount: 0,
    } satisfies CapturedQueryState)
  const { metrics } = record
  return {
    ...state,
    present: record.current !== null,
    fetchCount: metrics.fetchCount,
    errorCount: metrics.errorCount,
    ...(metrics.lastDurationMs !== undefined ? { lastDurationMs: metrics.lastDurationMs } : {}),
    totalDurationMs: metrics.totalDurationMs,
    spans: [...metrics.spans.toArray(), ...metrics.activeSpans.values()]
      .map(span => ({ ...span }))
      .sort((a, b) => a.startAt - b.startAt),
    realtimeSeen: metrics.realtimeSeen,
    reconciles: metrics.reconciles,
    ...(metrics.lastError ? { lastError: metrics.lastError } : {}),
  }
}

export function createCollector(
  figbird: FigbirdLikeForDevtools,
  options: CollectorOptions = {},
): Collector {
  return new FigbirdCollector(figbird, {
    eventLimit: options.eventLimit ?? 500,
    heartbeatMs: options.heartbeatMs ?? 5_000,
    payloadLimit: options.payloadLimit ?? 200,
    payloadNodeLimit: options.payloadNodeLimit ?? 20_000,
    queryHistoryLimit: options.queryHistoryLimit ?? 250,
    snapshotValues: options.snapshotValues ?? true,
    spanLimit: options.spanLimit ?? 50,
    timelineLimit: options.timelineLimit ?? 2_000,
    writeLimit: options.writeLimit ?? 250,
  })
}

interface ResolvedCollectorOptions {
  eventLimit: number
  heartbeatMs: number
  payloadLimit: number
  payloadNodeLimit: number
  queryHistoryLimit: number
  snapshotValues: boolean
  spanLimit: number
  timelineLimit: number
  writeLimit: number
}

type FetchEvent = Extract<FigbirdEvent, { kind: 'fetch:start' | 'fetch:end' | 'fetch:error' }>

type FetchTerminalEvent = Extract<FetchEvent, { kind: 'fetch:end' | 'fetch:error' }>

const MAX_ACTIVE_FETCH_MS = 10 * 60_000

type TimelineEvictionCandidate =
  | { at: number; kind: 'span'; record: InternalQueryRecord }
  | { at: number; kind: 'realtime' }
  | { at: number; kind: 'connection' }
  | { at: number; kind: 'write'; id: string }

class FigbirdCollector implements Collector {
  #figbird: FigbirdLikeForDevtools
  #heartbeatMs: number
  #queryHistoryLimit: number
  #snapshotValues: boolean
  #spanLimit: number
  #timelineLimit: number
  #writeLimit: number
  #started = false
  #dirty = true
  #sourceStateDirty = true
  #notificationScheduled = false
  #eventUnsub: (() => void) | null = null
  #heartbeat: ReturnType<typeof setInterval> | null = null
  #stateUnsub: (() => void) | null = null
  #mutationUnsub: (() => void) | null = null
  #listeners: Set<() => void> = new Set()
  #snapshot: DevtoolsSnapshot = EMPTY_SNAPSHOT

  #queries: Map<string, InternalQueryRecord> = new Map()
  #relational: Map<string, InternalRelationalQuery> = new Map()
  #cache: DevtoolsCacheService[] = []
  #events: CappedBuffer<DevtoolsEvent>
  #timelineRealtime: CappedBuffer<TimelineRealtimeEvent>
  #timelineConnection: CappedBuffer<TimelineConnectionEvent>
  #timelineStartedAt = now()
  #timelineEvictedCount = 0
  #timelinePayloadsEvicted = 0
  #nextEventId = 1
  #realtimeByService: Map<string, number> = new Map()
  #writes: Map<string, WriteRecord> = new Map()
  #cacheProvenance = new Map<string, NonNullable<DevtoolsCacheEntity['lastChange']>>()
  #fetchTraces = new Map<number, { reason?: string; traceIds: number[]; startedAt: number }>()
  #payloads: PayloadRetention
  #eventPayloadHandles = new WeakMap<DevtoolsEvent, PayloadHandle>()
  #realtimePayloadHandles = new WeakMap<TimelineRealtimeEvent, PayloadHandle>()
  #spanPayloadHandles = new WeakMap<QuerySpan, PayloadHandle[]>()
  #writePayloadHandles = new Map<string, PayloadHandle>()

  readonly eventLimit: number

  constructor(figbird: FigbirdLikeForDevtools, options: ResolvedCollectorOptions) {
    this.#figbird = figbird
    this.#heartbeatMs = options.heartbeatMs
    this.#queryHistoryLimit = options.queryHistoryLimit
    this.#snapshotValues = options.snapshotValues
    this.#spanLimit = options.spanLimit
    this.#timelineLimit = options.timelineLimit
    this.#writeLimit = options.writeLimit
    this.eventLimit = options.eventLimit
    this.#events = new CappedBuffer(options.eventLimit)
    this.#timelineRealtime = new CappedBuffer(options.eventLimit)
    this.#timelineConnection = new CappedBuffer(options.eventLimit)
    this.#payloads = new PayloadRetention(options.payloadLimit, options.payloadNodeLimit)
  }

  start(): void {
    if (this.#started) return
    this.#started = true
    this.#refreshQueries()
    this.#refreshRelational()
    this.#refreshCache()
    this.#sourceStateDirty = false
    this.#eventUnsub = this.#figbird.events.subscribe(event => {
      this.#recordEvent(event)
      this.#scheduleNotify()
    })
    this.#stateUnsub =
      this.#figbird.subscribeToStateChanges?.(() => {
        this.#sourceStateDirty = true
        this.#scheduleNotify()
      }) ?? null
    this.#mutationUnsub =
      this.#figbird.mutating?.subscribe(() => {
        this.#scheduleNotify()
      }) ?? null
    if (this.#heartbeatMs > 0) {
      this.#heartbeat = setInterval(() => {
        if (!this.#stateUnsub) this.#sourceStateDirty = true
        this.#scheduleNotify()
      }, this.#heartbeatMs)
    }
    this.#scheduleNotify()
  }

  stop(): void {
    this.#eventUnsub?.()
    this.#stateUnsub?.()
    this.#mutationUnsub?.()
    if (this.#heartbeat) clearInterval(this.#heartbeat)
    this.#eventUnsub = null
    this.#heartbeat = null
    this.#stateUnsub = null
    this.#mutationUnsub = null
    this.#started = false
  }

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn)
    return () => {
      this.#listeners.delete(fn)
    }
  }

  getSnapshot(): DevtoolsSnapshot {
    if (!this.#dirty) return this.#snapshot
    this.#trimTimeline()
    if (this.#sourceStateDirty) {
      this.#refreshQueries()
      this.#refreshRelational()
      this.#refreshCache()
      this.#sourceStateDirty = false
    }
    const queries = Array.from(this.#queries.values())
      .map(record => toPublicQueryRecord(record))
      .sort((a, b) => {
        const active = Number(b.subscriberCount > 0) - Number(a.subscriberCount > 0)
        if (active !== 0) return active
        const subscribers = b.subscriberCount - a.subscriberCount
        if (subscribers !== 0) return subscribers
        return `${a.serviceName}:${a.queryId}`.localeCompare(`${b.serviceName}:${b.queryId}`)
      })
    const writes = Array.from(this.#writes.values()).sort((a, b) => a.startedAt - b.startedAt)
    this.#snapshot = {
      cache: this.#cache,
      queries,
      relational: [...this.#relational.values()].map(record => record.inspected),
      events: this.#events.toArray().map(item => ({ ...item })),
      timeline: {
        startedAt: this.#timelineStartedAt,
        laneOrder: [],
        realtime: this.#timelineRealtime.toArray().map(item => ({ ...item })),
        connection: this.#timelineConnection.toArray(),
        evictedCount: this.#timelineEvictedCount,
        payloadsEvicted: this.#timelinePayloadsEvicted,
      },
      writes,
    }
    this.#dirty = false
    return this.#snapshot
  }

  clearEvents(): void {
    for (const item of this.#events.toArray()) {
      this.#payloads.release(this.#eventPayloadHandles.get(item))
    }
    this.#events.clear()
    this.#scheduleNotify()
  }

  clearTimeline(): void {
    for (const item of this.#timelineRealtime.toArray()) {
      this.#payloads.release(this.#realtimePayloadHandles.get(item))
    }
    this.#timelineRealtime.clear()
    this.#timelineConnection.clear()
    this.#clearSettledWrites()
    this.#timelineStartedAt = now()
    this.#timelineEvictedCount = 0
    this.#timelinePayloadsEvicted = 0
    for (const record of this.#queries.values()) {
      for (const span of record.metrics.spans.toArray()) this.#releaseSpanPayloads(span)
    }
    for (const record of this.#queries.values()) {
      record.metrics.spans.clear()
      for (const span of record.metrics.activeSpans.values()) {
        span.startAt = this.#timelineStartedAt
      }
    }
    this.#scheduleNotify()
  }

  reset(): void {
    this.#queries.clear()
    this.#relational.clear()
    this.#cache = []
    this.#events.clear()
    this.#timelineRealtime.clear()
    this.#timelineConnection.clear()
    this.#timelineStartedAt = now()
    this.#timelineEvictedCount = 0
    this.#timelinePayloadsEvicted = 0
    this.#nextEventId = 1
    this.#realtimeByService.clear()
    this.#writes.clear()
    this.#cacheProvenance.clear()
    this.#fetchTraces.clear()
    this.#sourceStateDirty = true
    this.#payloads.clear()
    this.#writePayloadHandles.clear()
    this.#scheduleNotify()
  }

  #captureValue<T>(value: T): T {
    return this.#snapshotValues ? snapshotValue(value) : value
  }

  #scheduleNotify(): void {
    this.#dirty = true
    if (this.#notificationScheduled) return
    this.#notificationScheduled = true
    const flush = () => {
      this.#notificationScheduled = false
      for (const listener of this.#listeners) {
        listener()
      }
    }
    queueMicrotask(flush)
  }

  #clearSettledWrites(): void {
    for (const [id, write] of this.#writes) {
      if (write.status === 'in-flight') continue
      this.#payloads.release(this.#writePayloadHandles.get(id))
      this.#writePayloadHandles.delete(id)
      this.#writes.delete(id)
    }
  }

  #recordEvent(event: FigbirdEvent): void {
    const at = now()
    const capturedEvent = this.#captureEvent(event)
    const captured: DevtoolsEvent = {
      id: this.#nextEventId++,
      at,
      wallAt: Date.now(),
      event: capturedEvent,
    }
    const evictedEvent = this.#events.push(captured)
    if (evictedEvent) {
      this.#payloads.release(this.#eventPayloadHandles.get(evictedEvent))
    }

    switch (capturedEvent.kind) {
      case 'fetch:start':
        this.#recordFetchStart(capturedEvent, at)
        break
      case 'fetch:end':
      case 'fetch:error':
        this.#finishFetch(capturedEvent, at)
        break
      case 'realtime':
        {
          const timelineItem: TimelineRealtimeEvent = {
            at,
            serviceName: capturedEvent.serviceName,
            type: capturedEvent.type,
            ...(capturedEvent.itemId === undefined ? {} : { itemId: capturedEvent.itemId }),
            ...(capturedEvent.traceId === undefined ? {} : { traceId: capturedEvent.traceId }),
            ...(capturedEvent.item === undefined
              ? {}
              : { payload: capturedEvent.item, payloadState: 'retained' as const }),
          }
          this.#retainRealtimePayload(timelineItem)
          const evictedRealtime = this.#timelineRealtime.push(timelineItem)
          if (evictedRealtime) {
            this.#payloads.release(this.#realtimePayloadHandles.get(evictedRealtime))
            this.#timelineEvictedCount++
          }
        }
        this.#realtimeByService.set(
          capturedEvent.serviceName,
          (this.#realtimeByService.get(capturedEvent.serviceName) ?? 0) + 1,
        )
        break
      case 'connection:connected':
      case 'connection:disconnected':
      case 'connection:reconnected':
      case 'connection:error':
      case 'connection:reconnect-failed':
        if (
          this.#timelineConnection.push({
            at,
            event: this.#captureConnectionEvent(capturedEvent),
          })
        ) {
          this.#timelineEvictedCount++
        }
        break
      case 'cache:updated':
        this.#sourceStateDirty = true
        if (capturedEvent.traceId !== undefined) {
          this.#cacheProvenance.set(
            `${capturedEvent.serviceName}:${String(capturedEvent.itemId)}`,
            {
              at,
              wallAt: Date.now(),
              source: capturedEvent.source,
              traceId: capturedEvent.traceId,
              type: capturedEvent.type,
            },
          )
        }
        break
      case 'reconcile:started':
        {
          const record = this.#queries.get(capturedEvent.queryId)
          if (record) record.metrics.reconciles++
        }
        break
      case 'mutate:start':
      case 'mutate:update':
      case 'mutate:end':
      case 'mutate:error':
      case 'mutate:rollback':
        this.#recordMutation(
          event as Extract<
            FigbirdEvent,
            {
              kind:
                'mutate:start' | 'mutate:update' | 'mutate:end' | 'mutate:error' | 'mutate:rollback'
            }
          >,
          at,
        )
        if (
          (event.kind === 'mutate:start' || event.kind === 'mutate:update') &&
          event.args !== undefined
        ) {
          this.#retainWriteArgs(`mutation:${event.mutationId}`)
        }
        break
      case 'action:start':
      case 'action:end':
      case 'action:error':
        this.#recordAction(
          event as Extract<FigbirdEvent, { kind: 'action:start' | 'action:end' | 'action:error' }>,
          at,
        )
        if (event.kind === 'action:start' && event.args !== undefined) {
          this.#retainWriteArgs(`action:${event.actionId}`)
        }
        break
    }
    this.#retainEventPayload(captured)
    this.#trimTimeline()
  }

  #refreshQueries(): void {
    const observedAt = now()
    const observedQueryIds = new Set<string>()
    for (const row of this.#figbird.inspect()) {
      observedQueryIds.add(row.queryId)
      const serviceRealtime = this.#realtimeByService.get(row.serviceName) ?? 0
      const existing = this.#queries.get(row.queryId)
      const capturedRow = {
        ...row,
        query: this.#captureValue(row.query),
        ...(row.data === undefined ? {} : { data: this.#captureValue(row.data) }),
      }
      const capturedState = queryState(capturedRow)
      const record =
        existing ?? makeQueryRecord(capturedRow, serviceRealtime, observedAt, this.#spanLimit)

      if (existing && existing.lastKnown.generation === row.generation && row.subscriberCount > 0) {
        record.metrics.realtimeSeen += Math.max(0, serviceRealtime - record.serviceRealtimeBaseline)
      }
      record.current = capturedState
      record.lastKnown = capturedState
      record.lastObservedAt = observedAt
      record.serviceRealtimeBaseline = serviceRealtime
      this.#queries.set(row.queryId, record)
    }
    for (const record of this.#queries.values()) {
      if (observedQueryIds.has(record.lastKnown.queryId)) continue
      record.current = null
      if (record.lastKnown.data !== undefined) {
        const { data: _data, ...metadata } = record.lastKnown
        void _data
        record.lastKnown = metadata
      }
      record.serviceRealtimeBaseline =
        this.#realtimeByService.get(record.lastKnown.serviceName) ?? 0
    }
    this.#trimQueries(observedQueryIds)
  }

  #trimQueries(observedQueryIds: ReadonlySet<string>): void {
    if (this.#queries.size <= this.#queryHistoryLimit) return
    const removable = [...this.#queries.values()]
      .filter(record => !observedQueryIds.has(record.lastKnown.queryId))
      .sort((a, b) => a.lastObservedAt - b.lastObservedAt)
    for (const record of removable) {
      if (this.#queries.size <= this.#queryHistoryLimit) break
      for (const span of record.metrics.spans.toArray()) this.#releaseSpanPayloads(span)
      for (const span of record.metrics.activeSpans.values()) this.#releaseSpanPayloads(span)
      this.#queries.delete(record.lastKnown.queryId)
    }
  }

  #refreshRelational(): void {
    const observedAt = now()
    const current = this.#figbird.inspectRelational?.() ?? []
    const observedKeys = new Set<string>()
    for (const inspected of current) {
      observedKeys.add(inspected.key)
      this.#relational.set(inspected.key, {
        inspected: this.#captureValue(inspected),
        lastObservedAt: observedAt,
      })
    }
    for (const record of this.#relational.values()) {
      if (observedKeys.has(record.inspected.key) || record.inspected.data === undefined) continue
      const { data: _data, ...metadata } = record.inspected
      void _data
      record.inspected = metadata
    }
    if (this.#relational.size <= this.#queryHistoryLimit) return
    const removable = [...this.#relational.values()]
      .filter(record => !observedKeys.has(record.inspected.key))
      .sort((a, b) => a.lastObservedAt - b.lastObservedAt)
    for (const record of removable) {
      if (this.#relational.size <= this.#queryHistoryLimit) break
      this.#relational.delete(record.inspected.key)
    }
  }

  #refreshCache(): void {
    const inspectedCache = this.#figbird.inspectCache?.() ?? []
    const liveCacheKeys = new Set<string>()
    this.#cache = inspectedCache.map(service => ({
      ...service,
      entities: service.entities.map(entity => {
        const key = `${service.serviceName}:${entity.id}`
        liveCacheKeys.add(key)
        return {
          ...entity,
          value: this.#captureValue(entity.value),
          ...(this.#cacheProvenance.has(key)
            ? { lastChange: this.#cacheProvenance.get(key)! }
            : {}),
        }
      }),
    }))
    for (const key of this.#cacheProvenance.keys()) {
      if (!liveCacheKeys.has(key)) this.#cacheProvenance.delete(key)
    }
  }

  #recordFetchStart(event: Extract<FetchEvent, { kind: 'fetch:start' }>, at: number): void {
    const record = this.#ensureFetchRecord(event, at, true)
    if (record.current?.generation !== event.generation) return
    if (event.fetchId !== undefined) {
      const traceIds = event.causes?.map(cause => cause.traceId) ?? []
      this.#fetchTraces.set(event.fetchId, {
        ...(event.reason ? { reason: event.reason } : {}),
        traceIds,
        startedAt: at,
      })
      const span: QuerySpan = {
        startAt: Math.max(at, this.#timelineStartedAt),
        fetchId: event.fetchId,
        ...(event.reason ? { reason: event.reason } : {}),
        ...(traceIds.length > 0 ? { traceIds } : {}),
        ...(event.params === undefined
          ? {}
          : { params: event.params, paramsState: 'retained' as const }),
      }
      if (event.params !== undefined) {
        this.#retainSpanPayload(span, event.params, () => {
          span.params = undefined
          span.paramsState = 'evicted'
        })
      }
      const replaced = record.metrics.activeSpans.get(event.fetchId)
      if (replaced) this.#releaseSpanPayloads(replaced)
      record.metrics.activeSpans.set(event.fetchId, span)
    }
    const current = {
      ...record.current,
      status: record.current.status === 'success' ? ('success' as const) : ('loading' as const),
      isFetching: true,
    }
    record.current = current
    record.lastKnown = current
  }

  #ensureFetchRecord(event: FetchEvent, at: number, present: boolean): InternalQueryRecord {
    const existing = this.#queries.get(event.queryId)
    if (existing) {
      existing.lastObservedAt = at
      if (
        event.generation > existing.lastKnown.generation &&
        (present || existing.current === null)
      ) {
        const state = makePlaceholderQueryState(
          event.queryId,
          event.serviceName,
          event.method,
          event.generation,
          'resourceId' in event ? event.resourceId : undefined,
        )
        existing.current = present ? state : null
        existing.lastKnown = state
        existing.serviceRealtimeBaseline = this.#realtimeByService.get(event.serviceName) ?? 0
      } else if (
        present &&
        event.generation === existing.lastKnown.generation &&
        existing.current === null
      ) {
        existing.current = existing.lastKnown
      }
      return existing
    }
    const state = makePlaceholderQueryState(
      event.queryId,
      event.serviceName,
      event.method,
      event.generation,
      'resourceId' in event ? event.resourceId : undefined,
    )
    const record = makePlaceholderQueryRecord(
      state,
      this.#realtimeByService.get(event.serviceName) ?? 0,
      at,
      present,
      this.#spanLimit,
    )
    this.#queries.set(event.queryId, record)
    return record
  }

  #finishFetch(event: FetchTerminalEvent, at: number): void {
    const record = this.#ensureFetchRecord(event, at, false)
    const { metrics } = record
    const ok = event.kind === 'fetch:end'
    metrics.fetchCount++
    metrics.totalDurationMs += event.durationMs
    metrics.lastDurationMs = event.durationMs
    if (!ok) {
      metrics.errorCount++
      metrics.lastError = {
        message: errorMessage(event.error),
        at,
        generation: event.generation,
      }
    }

    const observedStartAt = at - event.durationMs
    const startAt = Math.max(observedStartAt, this.#timelineStartedAt)
    const trace = event.fetchId === undefined ? undefined : this.#fetchTraces.get(event.fetchId)
    const activeSpan =
      event.fetchId === undefined ? undefined : metrics.activeSpans.get(event.fetchId)
    if (event.fetchId !== undefined) metrics.activeSpans.delete(event.fetchId)
    const span: QuerySpan = {
      ...activeSpan,
      startAt,
      endAt: at,
      ok,
      ...(event.fetchId === undefined ? {} : { fetchId: event.fetchId }),
      ...(trace?.reason ? { reason: trace.reason } : {}),
      ...(trace && trace.traceIds.length > 0 ? { traceIds: trace.traceIds } : {}),
    }
    const inspectedResult = ok
      ? this.#figbird
          .inspect()
          .find(query => query.queryId === event.queryId && query.generation === event.generation)
          ?.data
      : undefined
    if (inspectedResult !== undefined) {
      span.result = this.#captureValue(inspectedResult)
      span.resultState = 'retained'
      this.#retainSpanPayload(span, span.result, () => {
        span.result = undefined
        span.resultState = 'evicted'
      })
    }
    const evictedSpan = metrics.spans.push(span)
    if (evictedSpan) {
      this.#releaseSpanPayloads(evictedSpan)
      this.#timelineEvictedCount++
    }
    if (event.fetchId !== undefined) this.#fetchTraces.delete(event.fetchId)

    const currentMatches = record.current?.generation === event.generation
    const retainedMatches =
      record.current === null && record.lastKnown.generation === event.generation
    if (!currentMatches && !retainedMatches) return
    const state = currentMatches ? record.current! : record.lastKnown
    const settled: CapturedQueryState = {
      ...state,
      status: ok ? 'success' : 'error',
      isFetching: false,
      ...(event.kind === 'fetch:end' ? { itemCount: event.itemCount } : {}),
    }
    record.lastKnown = settled
    if (currentMatches) record.current = settled
  }

  #recordMutation(
    event: Extract<
      FigbirdEvent,
      {
        kind: 'mutate:start' | 'mutate:update' | 'mutate:end' | 'mutate:error' | 'mutate:rollback'
      }
    >,
    at: number,
  ): void {
    const id = `mutation:${event.mutationId}`
    const existing = this.#writes.get(id)
    const base: WriteRecord =
      existing ??
      ({
        id,
        type: 'mutation',
        status: 'in-flight',
        startedAt: at,
        startedWallAt: Date.now(),
        serviceName: event.serviceName,
        method: event.method,
        ...(event.id !== undefined ? { itemId: event.id } : {}),
        ...('optimistic' in event ? { optimistic: event.optimistic } : {}),
        ...('args' in event ? { args: this.#captureArgs(event.args) } : {}),
        ...(event.traceId === undefined ? {} : { traceId: event.traceId }),
      } satisfies WriteRecord)

    if (event.kind === 'mutate:update') {
      this.#writes.set(id, {
        ...base,
        optimistic: event.optimistic,
        args: this.#captureArgs(event.args),
      })
      return
    }
    if (event.kind === 'mutate:end') {
      this.#writes.set(id, {
        ...base,
        status: 'success',
        endedAt: at,
        durationMs: event.durationMs,
      })
      this.#trimWrites()
      return
    }
    if (event.kind === 'mutate:error') {
      this.#writes.set(id, {
        ...base,
        status: 'error',
        endedAt: at,
        durationMs: event.durationMs,
        error: errorMessage(event.error),
        ...(base.optimistic || base.rolledBack ? { rolledBack: true } : {}),
      })
      this.#trimWrites()
      return
    }
    if (event.kind === 'mutate:rollback') {
      this.#writes.set(id, { ...base, status: 'rollback', rolledBack: true })
      this.#trimWrites()
      return
    }
    this.#writes.set(id, base)
  }

  #recordAction(
    event: Extract<FigbirdEvent, { kind: 'action:start' | 'action:end' | 'action:error' }>,
    at: number,
  ): void {
    const id = `action:${event.actionId}`
    const existing = this.#writes.get(id)
    const base: WriteRecord =
      existing ??
      ({
        id,
        type: 'action',
        status: 'in-flight',
        startedAt: at,
        startedWallAt: Date.now(),
        ...(event.name ? { name: event.name } : {}),
        ...('args' in event ? { args: this.#captureArgs(event.args) } : {}),
      } satisfies WriteRecord)

    if (event.kind === 'action:end' || event.kind === 'action:error') {
      this.#writes.set(id, {
        ...base,
        status: event.kind === 'action:end' ? 'success' : 'error',
        endedAt: at,
        durationMs: event.durationMs,
        ...(event.kind === 'action:error' ? { error: errorMessage(event.error) } : {}),
      })
      this.#trimWrites()
      return
    }
    this.#writes.set(id, base)
  }

  #captureArgs(args: readonly unknown[]): readonly unknown[] {
    return this.#captureValue(args)
  }

  #captureEvent(event: FigbirdEvent): FigbirdEvent {
    switch (event.kind) {
      case 'fetch:start':
        return {
          ...event,
          ...(event.params === undefined ? {} : { params: this.#captureValue(event.params) }),
        }
      case 'realtime':
        return { ...event, item: this.#captureValue(event.item) }
      case 'cache:updated':
        return {
          ...event,
          item: this.#captureValue(event.item),
          previousItem: this.#captureValue(event.previousItem),
        }
      case 'fetch:error':
      case 'mutate:error':
      case 'action:error':
      case 'connection:error':
        return { ...event, error: new Error(errorMessage(event.error)) }
      case 'mutate:start':
        return {
          kind: event.kind,
          mutationId: event.mutationId,
          ...(event.traceId === undefined ? {} : { traceId: event.traceId }),
          serviceName: event.serviceName,
          method: event.method,
          optimistic: event.optimistic,
          ...(event.id === undefined ? {} : { id: event.id }),
        }
      case 'mutate:update':
        return {
          ...event,
          args: this.#captureArgs(event.args),
        }
      case 'action:start':
        return {
          kind: event.kind,
          actionId: event.actionId,
          ...(event.name ? { name: event.name } : {}),
        }
      default:
        return { ...event }
    }
  }

  #captureConnectionEvent(event: ConnectionFigbirdEvent): ConnectionFigbirdEvent {
    if (event.kind === 'connection:error' || event.kind === 'connection:reconnect-failed') {
      if (!event.error) return { ...event }
      return { ...event, error: new Error(errorMessage(event.error)) }
    }
    return { ...event }
  }

  #retainEventPayload(item: DevtoolsEvent): void {
    const payload = payloadForRetention(item.event)
    if (payload === undefined) return
    item.payloadState = 'retained'
    const handle = this.#payloads.retain(payload, () => {
      item.event = eventWithoutPayload(item.event)
      item.payloadState = 'evicted'
      this.#scheduleNotify()
    })
    this.#eventPayloadHandles.set(item, handle)
  }

  #retainRealtimePayload(item: TimelineRealtimeEvent): void {
    if (item.payload === undefined) return
    const handle = this.#payloads.retain(item.payload, () => {
      item.payload = undefined
      item.payloadState = 'evicted'
      this.#timelinePayloadsEvicted++
      this.#scheduleNotify()
    })
    this.#realtimePayloadHandles.set(item, handle)
  }

  #retainSpanPayload(span: QuerySpan, value: unknown, evict: () => void): void {
    const handle = this.#payloads.retain(value, () => {
      evict()
      this.#timelinePayloadsEvicted++
      this.#scheduleNotify()
    })
    const handles = this.#spanPayloadHandles.get(span) ?? []
    handles.push(handle)
    this.#spanPayloadHandles.set(span, handles)
  }

  #releaseSpanPayloads(span: QuerySpan): void {
    for (const handle of this.#spanPayloadHandles.get(span) ?? []) {
      this.#payloads.release(handle)
    }
    this.#spanPayloadHandles.delete(span)
  }

  #retainWriteArgs(id: string): void {
    const write = this.#writes.get(id)
    if (!write?.args) return
    this.#payloads.release(this.#writePayloadHandles.get(id))
    write.argsState = 'retained'
    const handle = this.#payloads.retain(write.args, () => {
      const current = this.#writes.get(id)
      if (!current) return
      const { args: _args, ...metadata } = current
      void _args
      this.#writes.set(id, { ...metadata, argsState: 'evicted' })
      this.#timelinePayloadsEvicted++
      this.#scheduleNotify()
    })
    this.#writePayloadHandles.set(id, handle)
  }

  #trimTimeline(): void {
    const candidates = (): TimelineEvictionCandidate[] => {
      const result: TimelineEvictionCandidate[] = []
      for (const record of this.#queries.values()) {
        const span = record.metrics.spans.first()
        if (span) result.push({ at: span.startAt, kind: 'span', record })
      }
      const realtime = this.#timelineRealtime.first()
      if (realtime) result.push({ at: realtime.at, kind: 'realtime' })
      const connection = this.#timelineConnection.first()
      if (connection) result.push({ at: connection.at, kind: 'connection' })
      for (const write of this.#writes.values()) {
        if (write.status !== 'in-flight' && write.startedAt >= this.#timelineStartedAt) {
          result.push({ at: write.startedAt, kind: 'write', id: write.id })
        }
      }
      return result
    }

    let retained =
      [...this.#queries.values()].reduce(
        (total, record) => total + record.metrics.spans.length,
        0,
      ) +
      this.#timelineRealtime.length +
      this.#timelineConnection.length +
      [...this.#writes.values()].filter(
        write => write.status !== 'in-flight' && write.startedAt >= this.#timelineStartedAt,
      ).length

    while (retained > this.#timelineLimit) {
      const oldest = candidates().sort((a, b) => a.at - b.at)[0]
      if (!oldest) break
      if (oldest.kind === 'span') {
        const span = oldest.record.metrics.spans.shift()
        if (span) this.#releaseSpanPayloads(span)
      } else if (oldest.kind === 'realtime') {
        const item = this.#timelineRealtime.shift()
        if (item) this.#payloads.release(this.#realtimePayloadHandles.get(item))
      } else if (oldest.kind === 'connection') {
        this.#timelineConnection.shift()
      } else {
        this.#payloads.release(this.#writePayloadHandles.get(oldest.id))
        this.#writePayloadHandles.delete(oldest.id)
        this.#writes.delete(oldest.id)
      }
      retained--
      this.#timelineEvictedCount++
    }

    const cutoff = now() - MAX_ACTIVE_FETCH_MS
    for (const record of this.#queries.values()) {
      for (const [fetchId, span] of record.metrics.activeSpans) {
        if (span.startAt >= cutoff) continue
        this.#releaseSpanPayloads(span)
        record.metrics.activeSpans.delete(fetchId)
        this.#fetchTraces.delete(fetchId)
        this.#timelineEvictedCount++
      }
    }
    for (const [fetchId, trace] of this.#fetchTraces) {
      if (trace.startedAt < cutoff) this.#fetchTraces.delete(fetchId)
    }
  }

  #trimWrites(): void {
    if (this.#writes.size <= this.#writeLimit) return
    const settled = [...this.#writes.values()]
      .filter(write => write.status !== 'in-flight')
      .sort((a, b) => a.startedAt - b.startedAt)
    for (const write of settled) {
      if (this.#writes.size <= this.#writeLimit) break
      this.#payloads.release(this.#writePayloadHandles.get(write.id))
      this.#writePayloadHandles.delete(write.id)
      this.#writes.delete(write.id)
      this.#timelineEvictedCount++
    }
  }
}
