import type {
  FigbirdEvent,
  FigbirdEvents,
  InspectedQuery,
  InspectedRelationalQuery,
  MutationActivity,
} from '../core/figbird.js'
import { CappedBuffer } from '../core/cappedBuffer.js'
import { now } from './format.js'

export interface FigbirdLikeForDevtools {
  events: FigbirdEvents
  mutating?: MutationActivity
  inspect(): InspectedQuery[]
  inspectRelational?(): InspectedRelationalQuery[]
  subscribeToStateChanges?(fn: (state: unknown) => void): () => void
}

interface CollectorOptions {
  eventLimit?: number
  heartbeatMs?: number
  queryHistoryLimit?: number
  spanLimit?: number
  writeLimit?: number
}

export interface QuerySpan {
  startAt: number
  endAt?: number
  ok?: boolean
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
}

export interface TimelineRealtimeEvent {
  at: number
  serviceName: string
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
  laneOrder: string[]
  realtime: TimelineRealtimeEvent[]
  connection: TimelineConnectionEvent[]
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
}

export interface DevtoolsSnapshot {
  queries: QueryRecord[]
  relational: InspectedRelationalQuery[]
  events: DevtoolsEvent[]
  timeline: DevtoolsTimeline
  writes: WriteRecord[]
  inFlightWrites: number
}

export interface Collector {
  readonly eventLimit: number
  start(): void
  stop(): void
  subscribe(fn: () => void): () => void
  getSnapshot(): DevtoolsSnapshot
  clearEvents(): void
  clearTimeline(): void
  clearWrites(): void
  reset(): void
}

type CapturedQueryState = Omit<
  InspectedQuery,
  'errorCount' | 'fetchCount' | 'lastDurationMs' | 'totalDurationMs'
>

interface QueryMetrics {
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
  queries: [],
  relational: [],
  events: [],
  timeline: { startedAt: 0, laneOrder: [], realtime: [], connection: [] },
  writes: [],
  inFlightWrites: 0,
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
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
    spans: metrics.spans.toArray(),
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
    queryHistoryLimit: options.queryHistoryLimit ?? 250,
    spanLimit: options.spanLimit ?? 50,
    writeLimit: options.writeLimit ?? 250,
  })
}

interface ResolvedCollectorOptions {
  eventLimit: number
  heartbeatMs: number
  queryHistoryLimit: number
  spanLimit: number
  writeLimit: number
}

type FetchEvent = Extract<FigbirdEvent, { kind: 'fetch:start' | 'fetch:end' | 'fetch:error' }>

type FetchTerminalEvent = Extract<FetchEvent, { kind: 'fetch:end' | 'fetch:error' }>

class FigbirdCollector implements Collector {
  #figbird: FigbirdLikeForDevtools
  #heartbeatMs: number
  #queryHistoryLimit: number
  #spanLimit: number
  #writeLimit: number
  #started = false
  #dirty = true
  #notificationScheduled = false
  #eventUnsub: (() => void) | null = null
  #heartbeat: ReturnType<typeof setInterval> | null = null
  #stateUnsub: (() => void) | null = null
  #mutationUnsub: (() => void) | null = null
  #listeners: Set<() => void> = new Set()
  #snapshot: DevtoolsSnapshot = EMPTY_SNAPSHOT

  #queries: Map<string, InternalQueryRecord> = new Map()
  #relational: Map<string, InternalRelationalQuery> = new Map()
  #events: CappedBuffer<DevtoolsEvent>
  #timelineRealtime: CappedBuffer<TimelineRealtimeEvent>
  #timelineConnection: CappedBuffer<TimelineConnectionEvent>
  #timelineStartedAt = now()
  #timelineLaneOrder: string[] = []
  #timelineLaneIds = new Set<string>()
  #nextEventId = 1
  #realtimeByService: Map<string, number> = new Map()
  #writes: Map<string, WriteRecord> = new Map()

  readonly eventLimit: number

  constructor(figbird: FigbirdLikeForDevtools, options: ResolvedCollectorOptions) {
    this.#figbird = figbird
    this.#heartbeatMs = options.heartbeatMs
    this.#queryHistoryLimit = options.queryHistoryLimit
    this.#spanLimit = options.spanLimit
    this.#writeLimit = options.writeLimit
    this.eventLimit = options.eventLimit
    this.#events = new CappedBuffer(options.eventLimit)
    this.#timelineRealtime = new CappedBuffer(options.eventLimit)
    this.#timelineConnection = new CappedBuffer(options.eventLimit)
  }

  start(): void {
    if (this.#started) return
    this.#started = true
    this.#refreshQueries()
    this.#eventUnsub = this.#figbird.events.subscribe(event => {
      this.#recordEvent(event)
      this.#scheduleNotify()
    })
    this.#stateUnsub =
      this.#figbird.subscribeToStateChanges?.(() => {
        this.#scheduleNotify()
      }) ?? null
    this.#mutationUnsub =
      this.#figbird.mutating?.subscribe(() => {
        this.#scheduleNotify()
      }) ?? null
    if (this.#heartbeatMs > 0) {
      this.#heartbeat = setInterval(() => this.#scheduleNotify(), this.#heartbeatMs)
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
    this.#refreshQueries()
    this.#refreshRelational()
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
      queries,
      relational: [...this.#relational.values()].map(record => record.inspected),
      events: this.#events.toArray(),
      timeline: {
        startedAt: this.#timelineStartedAt,
        laneOrder: [...this.#timelineLaneOrder],
        realtime: this.#timelineRealtime.toArray(),
        connection: this.#timelineConnection.toArray(),
      },
      writes,
      inFlightWrites: this.#figbird.mutating?.getSnapshot().length ?? 0,
    }
    this.#dirty = false
    return this.#snapshot
  }

  clearEvents(): void {
    this.#events.clear()
    this.#scheduleNotify()
  }

  clearTimeline(): void {
    this.#timelineRealtime.clear()
    this.#timelineConnection.clear()
    this.#timelineStartedAt = now()
    this.#timelineLaneOrder = []
    this.#timelineLaneIds.clear()
    for (const record of this.#queries.values()) {
      record.metrics.spans.clear()
    }
    this.#scheduleNotify()
  }

  clearWrites(): void {
    for (const [id, write] of this.#writes) {
      if (write.status !== 'in-flight') this.#writes.delete(id)
    }
    this.#scheduleNotify()
  }

  reset(): void {
    this.#queries.clear()
    this.#relational.clear()
    this.#events.clear()
    this.#timelineRealtime.clear()
    this.#timelineConnection.clear()
    this.#timelineStartedAt = now()
    this.#timelineLaneOrder = []
    this.#timelineLaneIds.clear()
    this.#nextEventId = 1
    this.#realtimeByService.clear()
    this.#writes.clear()
    this.#scheduleNotify()
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

  #recordEvent(event: FigbirdEvent): void {
    const at = now()
    this.#events.push({
      id: this.#nextEventId++,
      at,
      wallAt: Date.now(),
      event: this.#captureEvent(event),
    })

    switch (event.kind) {
      case 'fetch:start':
        this.#recordTimelineLane(`query:${event.queryId}`)
        this.#recordFetchStart(event, at)
        break
      case 'fetch:end':
      case 'fetch:error':
        this.#recordTimelineLane(`query:${event.queryId}`)
        this.#finishFetch(event, at)
        break
      case 'realtime':
        this.#recordTimelineLane(`realtime:${event.serviceName}`)
        this.#timelineRealtime.push({ at, serviceName: event.serviceName })
        this.#realtimeByService.set(
          event.serviceName,
          (this.#realtimeByService.get(event.serviceName) ?? 0) + 1,
        )
        break
      case 'connection:connected':
      case 'connection:disconnected':
      case 'connection:reconnected':
      case 'connection:error':
      case 'connection:reconnect-failed':
        this.#recordTimelineLane('connection')
        this.#timelineConnection.push({ at, event: this.#captureConnectionEvent(event) })
        break
      case 'reconcile:started':
        {
          const record = this.#queries.get(event.queryId)
          if (record) record.metrics.reconciles++
        }
        break
      case 'mutate:start':
      case 'mutate:update':
      case 'mutate:end':
      case 'mutate:error':
      case 'mutate:rollback':
        this.#recordMutation(event, at)
        break
      case 'action:start':
      case 'action:end':
      case 'action:error':
        this.#recordAction(event, at)
        break
    }
  }

  #recordTimelineLane(id: string): void {
    if (this.#timelineLaneIds.has(id)) return
    this.#timelineLaneIds.add(id)
    this.#timelineLaneOrder.push(id)
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
        query: snapshotValue(row.query),
        ...(row.data === undefined ? {} : { data: snapshotValue(row.data) }),
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
        inspected: snapshotValue(inspected),
        lastObservedAt: observedAt,
      })
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

  #recordFetchStart(event: Extract<FetchEvent, { kind: 'fetch:start' }>, at: number): void {
    const record = this.#ensureFetchRecord(event, at, true)
    if (record.current?.generation !== event.generation) return
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
    metrics.spans.push({ startAt, endAt: at, ok })

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
    return snapshotValue(args)
  }

  #captureEvent(event: FigbirdEvent): FigbirdEvent {
    switch (event.kind) {
      case 'fetch:start':
        return {
          ...event,
          ...(event.params === undefined ? {} : { params: snapshotValue(event.params) }),
        }
      case 'realtime':
        return { ...event, item: snapshotValue(event.item) }
      case 'fetch:error':
      case 'mutate:error':
      case 'action:error':
      case 'connection:error':
        return { ...event, error: new Error(errorMessage(event.error)) }
      case 'mutate:start':
        return {
          kind: event.kind,
          mutationId: event.mutationId,
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

  #trimWrites(): void {
    if (this.#writes.size <= this.#writeLimit) return
    const settled = [...this.#writes.values()]
      .filter(write => write.status !== 'in-flight')
      .sort((a, b) => a.startedAt - b.startedAt)
    for (const write of settled) {
      if (this.#writes.size <= this.#writeLimit) break
      this.#writes.delete(write.id)
    }
  }
}
