import type { Adapter, AdapterTransactionOperation } from '../adapters/adapter.js'
import { normalizeError } from './errors.js'
import { GatedMutationAttempt } from './gatedMutationAttempt.js'
import {
  MutationLanes,
  MUTATION_EVENT_TYPE,
  type MutationLane,
  type MutationOutcome,
  type LaneSettlement,
  type ProjectionChange,
  type ReleasedLaneEffects,
  type AuthoritativeTransition,
} from './mutationLanes.js'
import { MutationTracker, type MutationActivity } from './mutationTracker.js'
import {
  MutationSupersededError,
  type RegisteredMutation,
  type ScheduledMutationControl,
} from './mutationQueue.js'
import type { QueryTelemetry } from './queryTelemetry.js'
import {
  entityKey,
  type ItemId,
  type MutationDescriptor,
  type CreateMutationDescriptor,
  type Event,
  type TraceCause,
  type ProcessedProjectionEvent,
} from './queryTypes.js'

type MutationAdapter = Pick<Adapter, 'mutate' | 'transaction' | 'getId' | 'isItemStale'>

/** Cache effects are applied by the store at its atomic event boundary. */
export interface MutationCache {
  getEntity(serviceName: string, id: ItemId): unknown
  ingest(serviceName: string, event: Event, cause?: TraceCause): void
  project(change: ProjectionChange, immediate: boolean, cause?: TraceCause): boolean
  settle(
    settlement: Pick<LaneSettlement<QueuedMutation>, 'authoritativeEvent' | 'projection'>,
    publishAuthoritative: boolean,
    cause?: TraceCause,
  ): void
  flush(): void
  release(effects: ReleasedLaneEffects): void
  prune(serviceName: string): void
}

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

/** Owns mutation attempts, per-record ordering, transactions, and activity tracking. */
export class MutationExecutor {
  #adapter: MutationAdapter
  #cache: MutationCache
  #telemetry: Pick<QueryTelemetry, 'emit' | 'mutationCause'>
  #mutationLanes: MutationLanes<QueuedMutation>
  #mutations = new MutationTracker()
  #disposed = false

  constructor({
    adapter,
    cache,
    telemetry,
  }: {
    adapter: MutationAdapter
    cache: MutationCache
    telemetry: Pick<QueryTelemetry, 'emit' | 'mutationCause'>
  }) {
    this.#adapter = adapter
    this.#cache = cache
    this.#telemetry = telemetry
    this.#mutationLanes = new MutationLanes(item => this.#peekId(item))
  }

  get activity(): MutationActivity {
    return this.#mutations
  }

  dispose(): void {
    this.#disposed = true
    this.#mutations.dispose()
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('figbird: instance has been disposed')
  }

  hasPending(serviceName: string, id: ItemId): boolean {
    return this.#mutationLanes.get(serviceName, id) !== undefined
  }

  hasOptimisticCreate(serviceName: string, id: ItemId): boolean {
    return this.#mutationLanes.hasOptimisticCreate(serviceName, id)
  }

  acceptAuthoritative(
    serviceName: string,
    type: Event['type'],
    item: unknown,
  ): { handled: false } | { handled: true; transition: AuthoritativeTransition | null } {
    const id = this.#peekId(item)
    const lane = id === undefined ? undefined : this.#mutationLanes.get(serviceName, id)
    if (!lane) return { handled: false }
    return {
      handled: true,
      transition: this.#mutationLanes.acceptAuthoritative(lane, type, item, (current, next) =>
        this.#adapter.isItemStale(current, next),
      ),
    }
  }

  overlayEvents(serviceName: string): ProcessedProjectionEvent[] {
    return this.#mutationLanes.overlayEvents(serviceName)
  }

  deferQueryIds(laneKey: string, queryIds: Iterable<string>): boolean {
    return this.#mutationLanes.deferQueryIds(laneKey, queryIds)
  }

  deferProjection(laneKey: string, event: ProcessedProjectionEvent): boolean {
    return this.#mutationLanes.deferProjection(laneKey, event)
  }

  /** Whether the configured adapter promises atomic multi-mutation commits. */
  get supportsTransactions(): boolean {
    return this.#adapter.transaction !== undefined
  }

  /** Commit several keyed CRUD mutations through the adapter's atomic capability. */
  transaction(descs: readonly MutationDescriptor[]): Promise<void> {
    this.#assertActive()
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
        this.#cache.getEntity(operation.desc.serviceName, operation.id),
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
      this.#cache.project(this.#mutationLanes.enqueue(lane, entry), false, tracked.cause)
    }

    // All affected services are projected before observers are notified.
    this.#cache.flush()
    for (const { lane } of transaction.entries) this.#drainMutationLane(lane)

    return Promise.all(promises).then(() => undefined)
  }

  /**
   * Run one confirmed mutation without record-lane scheduling. This preserves the
   * transport behavior of deprecated `useMutation`: a caller may time out a hung
   * request and start another request for the same record. @internal
   */
  mutateConfirmedDirect(desc: MutationDescriptor): Promise<unknown> {
    this.#assertActive()
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
          this.#cache.ingest(serviceName, { type: MUTATION_EVENT_TYPE[method], item }, cause),
      },
    })
    return registration.promise
  }

  /** Register a mutation with an optional transport scheduler. @internal */
  registerMutation(
    desc: MutationDescriptor,
    control?: ScheduledMutationControl,
  ): RegisteredMutation {
    this.#assertActive()
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
              this.#cache.ingest(
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
          this.#cache.ingest(desc.serviceName, { type: 'created', item }, cause),
        onError: (_error, { mutationId, cause }) => {
          if (!optimistic) return
          this.#cache.ingest(desc.serviceName, { type: 'removed', item: optimisticItem }, cause)
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
          this.#cache.ingest(
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
      this.#cache.getEntity(desc.serviceName, id),
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
    this.#cache.project(this.#mutationLanes.enqueue(lane, entry), true, tracked.cause)
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
        this.#cache.project(projection, true, tracked.cause)
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
    if (projection) this.#cache.project(projection, true, cause)
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

    this.#cache.settle(settlement, !this.#mutationLanes.peekNext(lane), cause)

    this.#cancelSettledDependants(lane, entry, outcome, settlement.cancelled, lanes)
  }

  #finishLaneSettlements(lanes: ReadonlySet<MutationLane>): void {
    this.#cache.flush()
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

  #releaseMutationLane(lane: MutationLane): void {
    const effects = this.#mutationLanes.release(lane)
    if (!effects) return

    this.#cache.release(effects)
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
    this.#assertActive()
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
        this.#cache.prune(serviceName)
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
        this.#cache.prune(serviceName)
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

  /** Warn-free id read — presence checks on payloads that may lack ids. */
  #peekId(item: unknown): string | number | undefined {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined
    return this.#adapter.getId(item)
  }

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
}
