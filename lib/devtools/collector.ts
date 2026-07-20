import type {
  DevtoolsControl,
  FigbirdEvent,
  FigbirdEvents,
  InspectedQuery,
  InspectedRelationalQuery,
  MutationActivity,
} from '../core/figbird.js'

export interface FigbirdLikeForDevtools {
  devtools?: DevtoolsControl
  events: FigbirdEvents
  mutating?: MutationActivity
  inspect(): InspectedQuery[]
  inspectRelational?(): InspectedRelationalQuery[]
  subscribeToStateChanges?(fn: (state: unknown) => void): () => void
}

export interface CollectorOptions {
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

export interface QueryRecord extends InspectedQuery {
  fetchCount: number
  errorCount: number
  lastDurationMs?: number
  totalDurationMs: number
  spans: QuerySpan[]
  realtimeSeen: number
  reconciles: number
  lastError?: { message: string; at: number }
}

export interface DevtoolsEvent {
  at: number
  wallAt?: number
  event: FigbirdEvent
}

export interface PreparationSpan {
  key: string
  kind: 'prepare' | 'prefetch'
  startAt: number
  endAt?: number
  name?: string
  durationMs?: number
}

export interface WriteRecord {
  id: string
  type: 'action' | 'mutation'
  status: 'in-flight' | 'success' | 'error' | 'rollback'
  startedAt: number
  startedWallAt?: number
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
  writes: WriteRecord[]
  inFlightWrites: number
  preparations: PreparationSpan[]
}

export interface Collector {
  start(): void
  stop(): void
  subscribe(fn: () => void): () => void
  getSnapshot(): DevtoolsSnapshot
  clearEvents(): void
  clearTimeline(): void
  clearWrites(): void
}

interface InternalQueryRecord extends QueryRecord {
  lastObservedAt: number
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
  writes: [],
  inFlightWrites: 0,
  preparations: [],
}

function now(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

function snapshotValue<T>(value: T): T {
  if (typeof structuredClone !== 'function') return value
  try {
    return structuredClone(value)
  } catch {
    return value
  }
}

function pushCapped<T>(items: T[], item: T, limit: number): void {
  items.push(item)
  if (items.length > limit) {
    items.splice(0, items.length - limit)
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

function makeQueryRecord(
  row: InspectedQuery,
  serviceRealtimeBaseline: number,
  observedAt: number,
): InternalQueryRecord {
  return {
    ...row,
    fetchCount: row.fetchCount ?? 0,
    errorCount: row.errorCount ?? 0,
    totalDurationMs: row.totalDurationMs ?? 0,
    spans: [],
    realtimeSeen: 0,
    reconciles: 0,
    lastObservedAt: observedAt,
    serviceRealtimeBaseline,
  }
}

function makePlaceholderQueryRecord(
  queryId: string,
  serviceName: string,
  method: 'find' | 'get',
  serviceRealtimeBaseline: number,
  resourceId?: string | number,
): InternalQueryRecord {
  return makeQueryRecord(
    {
      queryId,
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
    },
    serviceRealtimeBaseline,
    now(),
  )
}

function toPublicQueryRecord(record: InternalQueryRecord): QueryRecord {
  return {
    queryId: record.queryId,
    serviceName: record.serviceName,
    method: record.method,
    ...(record.resourceId !== undefined ? { resourceId: record.resourceId } : {}),
    query: record.query,
    classification: record.classification,
    status: record.status,
    isFetching: record.isFetching,
    itemCount: record.itemCount,
    fetchedAt: record.fetchedAt,
    subscriberCount: record.subscriberCount,
    fetchCount: record.fetchCount,
    errorCount: record.errorCount,
    totalDurationMs: record.totalDurationMs,
    spans: [...record.spans],
    realtimeSeen: record.realtimeSeen,
    reconciles: record.reconciles,
    ...(record.lastDurationMs !== undefined ? { lastDurationMs: record.lastDurationMs } : {}),
    ...(record.lastError ? { lastError: record.lastError } : {}),
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

class FigbirdCollector implements Collector {
  #figbird: FigbirdLikeForDevtools
  #eventLimit: number
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
  #events: DevtoolsEvent[] = []
  #fetchStarts: Map<string, number> = new Map()
  #realtimeByService: Map<string, number> = new Map()
  #writes: Map<string, WriteRecord> = new Map()
  #preparationStarts: Map<string, PreparationSpan> = new Map()
  #preparations: PreparationSpan[] = []

  constructor(figbird: FigbirdLikeForDevtools, options: Required<CollectorOptions>) {
    this.#figbird = figbird
    this.#eventLimit = options.eventLimit
    this.#heartbeatMs = options.heartbeatMs
    this.#queryHistoryLimit = options.queryHistoryLimit
    this.#spanLimit = options.spanLimit
    this.#writeLimit = options.writeLimit
  }

  start(): void {
    if (this.#started) return
    this.#started = true
    this.#refreshQueries(true)
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
      events: [...this.#events],
      writes,
      inFlightWrites: this.#figbird.mutating?.getSnapshot().length ?? 0,
      preparations: [...this.#preparations],
    }
    this.#dirty = false
    return this.#snapshot
  }

  clearEvents(): void {
    this.#events = []
    this.#scheduleNotify()
  }

  clearTimeline(): void {
    this.#events = []
    this.#preparationStarts.clear()
    this.#preparations = []
    this.#fetchStarts.clear()
    for (const record of this.#queries.values()) {
      record.spans = []
      record.realtimeSeen = 0
      record.reconciles = 0
    }
    this.#relational.clear()
    this.#refreshRelational()
    this.#scheduleNotify()
  }

  clearWrites(): void {
    for (const [id, write] of this.#writes) {
      if (write.status !== 'in-flight') this.#writes.delete(id)
    }
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
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(flush)
    } else {
      setTimeout(flush, 50)
    }
  }

  #recordEvent(event: FigbirdEvent): void {
    const at = now()
    pushCapped(this.#events, { at, wallAt: Date.now(), event }, this.#eventLimit)

    switch (event.kind) {
      case 'fetch:start':
        this.#fetchStarts.set(event.queryId, at)
        this.#getQuery(event.queryId, event.serviceName, event.method, event.resourceId)
        break
      case 'fetch:end':
        this.#finishFetch(
          event.queryId,
          event.serviceName,
          event.method,
          at,
          true,
          event.durationMs,
        )
        break
      case 'fetch:error':
        this.#finishFetch(
          event.queryId,
          event.serviceName,
          event.method,
          at,
          false,
          event.durationMs,
        )
        this.#getQuery(event.queryId, event.serviceName, event.method).lastError = {
          message: errorMessage(event.error),
          at,
        }
        break
      case 'realtime':
        this.#realtimeByService.set(
          event.serviceName,
          (this.#realtimeByService.get(event.serviceName) ?? 0) + 1,
        )
        break
      case 'reconcile:scheduled':
        this.#getQuery(event.queryId, event.serviceName, 'find').reconciles++
        break
      case 'mutate:start':
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
      case 'prepare:start':
      case 'prefetch:start':
      case 'prepare:end':
      case 'prefetch:end':
        this.#recordPreparation(event, at)
        break
      case 'reconcile:deferred':
        break
    }
  }

  #refreshQueries(hydrateStats = false): void {
    const observedAt = now()
    const observedQueryIds = new Set<string>()
    for (const row of this.#figbird.inspect()) {
      observedQueryIds.add(row.queryId)
      const serviceRealtime = this.#realtimeByService.get(row.serviceName) ?? 0
      const existing = this.#queries.get(row.queryId)
      const record = existing ?? makeQueryRecord(row, serviceRealtime, observedAt)

      if (row.subscriberCount > 0) {
        record.realtimeSeen += Math.max(0, serviceRealtime - record.serviceRealtimeBaseline)
      }
      record.lastObservedAt = observedAt
      record.serviceRealtimeBaseline = serviceRealtime
      record.serviceName = row.serviceName
      record.method = row.method
      if (row.resourceId === undefined) {
        delete record.resourceId
      } else {
        record.resourceId = row.resourceId
      }
      record.query = row.query
      record.classification = row.classification
      record.status = row.status
      record.isFetching = row.isFetching
      record.itemCount = row.itemCount
      record.fetchedAt = row.fetchedAt
      record.subscriberCount = row.subscriberCount
      if (!existing || hydrateStats) {
        record.fetchCount = Math.max(record.fetchCount, row.fetchCount ?? 0)
        record.errorCount = Math.max(record.errorCount, row.errorCount ?? 0)
        record.totalDurationMs = Math.max(record.totalDurationMs, row.totalDurationMs ?? 0)
        if (row.lastDurationMs !== undefined) {
          record.lastDurationMs = row.lastDurationMs
        }
      }
      this.#queries.set(row.queryId, record)
    }
    this.#trimQueries(observedQueryIds)
  }

  #trimQueries(observedQueryIds: ReadonlySet<string>): void {
    if (this.#queries.size <= this.#queryHistoryLimit) return
    const removable = [...this.#queries.values()]
      .filter(
        record => !observedQueryIds.has(record.queryId) && !this.#fetchStarts.has(record.queryId),
      )
      .sort((a, b) => a.lastObservedAt - b.lastObservedAt)
    for (const record of removable) {
      if (this.#queries.size <= this.#queryHistoryLimit) break
      this.#queries.delete(record.queryId)
    }
  }

  #refreshRelational(): void {
    const observedAt = now()
    const current = this.#figbird.inspectRelational?.() ?? []
    const observedKeys = new Set<string>()
    for (const inspected of current) {
      observedKeys.add(inspected.key)
      this.#relational.set(inspected.key, { inspected, lastObservedAt: observedAt })
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

  #getQuery(
    queryId: string,
    serviceName: string,
    method: 'find' | 'get',
    resourceId?: string | number,
  ): InternalQueryRecord {
    const serviceRealtime = this.#realtimeByService.get(serviceName) ?? 0
    const existing = this.#queries.get(queryId)
    if (existing) {
      if (resourceId !== undefined) existing.resourceId = resourceId
      return existing
    }
    const record = makePlaceholderQueryRecord(
      queryId,
      serviceName,
      method,
      serviceRealtime,
      resourceId,
    )
    this.#queries.set(queryId, record)
    return record
  }

  #finishFetch(
    queryId: string,
    serviceName: string,
    method: 'find' | 'get',
    at: number,
    ok: boolean,
    durationMs: number,
  ): void {
    const record = this.#getQuery(queryId, serviceName, method)
    const startAt = this.#fetchStarts.get(queryId) ?? at - durationMs
    this.#fetchStarts.delete(queryId)
    record.fetchCount++
    record.lastDurationMs = durationMs
    record.totalDurationMs += durationMs
    if (!ok) record.errorCount++
    pushCapped(record.spans, { startAt, endAt: at, ok }, this.#spanLimit)
  }

  #recordMutation(
    event: Extract<
      FigbirdEvent,
      { kind: 'mutate:start' | 'mutate:end' | 'mutate:error' | 'mutate:rollback' }
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
        ...('args' in event ? { args: snapshotValue(event.args) } : {}),
      } satisfies WriteRecord)

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
        ...('args' in event ? { args: snapshotValue(event.args) } : {}),
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

  #recordPreparation(
    event: Extract<
      FigbirdEvent,
      { kind: 'prepare:start' | 'prefetch:start' | 'prepare:end' | 'prefetch:end' }
    >,
    at: number,
  ): void {
    const kind = event.kind.startsWith('prepare') ? 'prepare' : 'prefetch'
    const id = `${kind}:${event.key}`
    if (event.kind === 'prepare:start' || event.kind === 'prefetch:start') {
      this.#preparationStarts.set(id, {
        key: event.key,
        kind,
        startAt: at,
        ...(event.name ? { name: event.name } : {}),
      })
      return
    }
    if (event.kind === 'prepare:end' || event.kind === 'prefetch:end') {
      const span = this.#preparationStarts.get(id) ?? { key: event.key, kind, startAt: at }
      this.#preparationStarts.delete(id)
      pushCapped(
        this.#preparations,
        { ...span, endAt: at, durationMs: event.durationMs },
        this.#eventLimit,
      )
    }
  }
}
