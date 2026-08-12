import { createMutationsProxy, type MutationsProxy } from './mutations.js'
import type { Schema } from './schema.js'
import type { MutationDescriptor } from './queryTypes.js'
import { defaultRetryDelay, resolveRetryDelay } from './retryDelay.js'

export type MutationQueueStatus = 'idle' | 'scheduled' | 'saving' | 'retrying' | 'failed'

export interface MutationQueueOperation {
  readonly serviceName: string
  readonly method: string
  readonly id?: string | number
  readonly data?: unknown
  readonly params?: unknown
}

export interface MutationSchedule {
  /** Quiet period before this operation may reach the adapter. */
  wait: number
  /** Maximum time from the first compatible call before it must be sent. */
  maxWait?: number
}

export type MutationQueueRetry =
  number | false | ((error: Error, attempt: number, operation: MutationQueueOperation) => boolean)

export type MutationQueueRetryDelay =
  number | ((attempt: number, error: Error, operation: MutationQueueOperation) => number)

export interface MutationQueueConfig {
  /** Scheduling policy. Omit for an immediate serial queue. */
  schedule?: (operation: MutationQueueOperation) => MutationSchedule
  /** Automatic retries after the first failed attempt. Defaults to false. */
  retry?: MutationQueueRetry
  /** Delay before an automatic retry. Defaults to 0. */
  retryDelay?: MutationQueueRetryDelay
  /** Reject an adapter attempt that has not settled within this many milliseconds. */
  timeout?: number
}

export interface MutationQueueSnapshot {
  readonly status: MutationQueueStatus
  readonly pending: number
  readonly error: Error | null
}

/** A queued mutation intentionally removed before it reached the adapter. */
export class MutationSupersededError extends Error {
  constructor(message = 'figbird: mutation was superseded before it reached the server') {
    super(message)
    this.name = 'MutationSupersededError'
  }
}

/** Pending work discarded after a mutation queue paused on an error. */
export class MutationQueueDiscardedError extends Error {
  constructor(message = 'figbird: pending mutation was discarded with its mutation queue') {
    super(message)
    this.name = 'MutationQueueDiscardedError'
  }
}

export function isMutationSupersededError(error: unknown): error is MutationSupersededError {
  return error instanceof MutationSupersededError
}

/** @internal */
export interface ScheduledMutationControl {
  isReady(): boolean
  subscribeReady(listener: () => void): () => void
  expedite(): void
  onAttemptStart(): void
  onAttemptFailure(error: Error, attempt: number): Promise<'retry' | 'discard'>
  readonly timeout: number | undefined
}

/** @internal */
export interface RegisteredMutation {
  readonly promise: Promise<unknown>
  tryUpdate(desc: MutationDescriptor): boolean
  cancel(error: Error): void
}

/** @internal */
export interface MutationQueueHost {
  registerMutation(desc: MutationDescriptor, control: ScheduledMutationControl): RegisteredMutation
  registerCall(
    serviceName: string,
    method: string,
    args: unknown[],
    control: ScheduledMutationControl,
  ): RegisteredMutation
}

/** Attempt policy captured while an item is still eligible for coalescing. */
interface MutationQueuePolicy {
  retry: MutationQueueRetry
  retryDelay: MutationQueueRetryDelay
  timeout: number | undefined
}

interface QueueItem extends ScheduledMutationControl {
  readonly sequence: number
  readonly enqueuedAt: number
  operation: MutationQueueOperation
  desc: MutationDescriptor | null
  registration: RegisteredMutation | null
  policy: MutationQueuePolicy
  dueAt: number
  maxAt: number
  ready: boolean
  settled: boolean
  timer: ReturnType<typeof setTimeout> | null
  listeners: Set<() => void>
}

/**
 * A long-lived, serial stream of optimistic writes. Every call is registered in
 * Figbird's record lanes immediately; this object controls only transport
 * eligibility, retry policy, and compatible tail-patch coalescing.
 */
export class MutationQueue<S extends Schema> {
  readonly m: MutationsProxy<S>

  readonly #host: MutationQueueHost
  #config: MutationQueueConfig
  readonly #items: QueueItem[] = []
  readonly #listeners = new Set<() => void>()
  #nextSequence = 1
  #snapshot: MutationQueueSnapshot = { status: 'idle', pending: 0, error: null }
  #failedDecision: ((decision: 'retry' | 'discard') => void) | null = null
  #flushThrough = 0
  #detached = false

  constructor(host: MutationQueueHost, config: MutationQueueConfig = {}) {
    this.#host = host
    this.#config = config
    this.m = createMutationsProxy({
      mutate: desc => this.#enqueueMutation(desc),
      call: (serviceName, method, args) => this.#enqueueCall(serviceName, method, args),
    }) as MutationsProxy<S>
  }

  getSnapshot = (): MutationQueueSnapshot => this.#snapshot

  get status(): MutationQueueStatus {
    return this.#snapshot.status
  }

  get pending(): number {
    return this.#snapshot.pending
  }

  get error(): Error | null {
    return this.#snapshot.error
  }

  /** Update the policy used by operations registered after this call. */
  setConfig(config: MutationQueueConfig): void {
    this.#config = config
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Relinquish interactive ownership: flush registered work, then discard from
   * the first terminal failure so no queue can pause without an owner.
   */
  detach(): void {
    if (this.#detached) return
    this.#detached = true
    if (this.#failedDecision) this.discard()
    else this.flush()
  }

  /** Skip debounce delays for everything currently queued. */
  flush(): void {
    const last = this.#items.at(-1)
    if (!last) return
    this.#flushThrough = Math.max(this.#flushThrough, last.sequence)
    this.#armCurrent()
  }

  /** Retry the operation on which this queue is paused. */
  retry(): void {
    if (this.#detached || !this.#failedDecision) return
    const decide = this.#failedDecision
    this.#failedDecision = null
    this.#setSnapshot({ status: 'scheduled', error: null })
    decide('retry')
  }

  /** Roll back the failed operation and every later operation in this queue. */
  discard(): void {
    if (!this.#failedDecision) return
    const current = this.#items[0]
    if (current) this.#discardAfter(current)
    const decide = this.#failedDecision
    this.#failedDecision = null
    decide('discard')
  }

  #enqueueMutation(desc: MutationDescriptor): Promise<unknown> {
    if (this.#detached) throw new Error('figbird: cannot enqueue into a detached mutation queue')
    const tail = this.#items.at(-1)
    if (tail && this.#canCoalesce(tail, desc)) {
      const merged = this.#mergePatches(
        tail.desc as Extract<MutationDescriptor, { method: 'patch' }>,
        desc as Extract<MutationDescriptor, { method: 'patch' }>,
      )
      const operation = this.#operationFromDesc(merged)
      const schedule = this.#schedule(operation)
      const policy = this.#capturePolicy()
      if (tail.registration!.tryUpdate(merged)) {
        tail.desc = merged
        tail.operation = operation
        tail.policy = policy
        tail.dueAt = Date.now() + schedule.wait
        tail.maxAt = Math.min(
          tail.maxAt,
          schedule.maxWait === undefined
            ? Number.POSITIVE_INFINITY
            : tail.enqueuedAt + schedule.maxWait,
        )
        this.#armCurrent()
        return tail.registration!.promise
      }
    }

    const operation = this.#operationFromDesc(desc)
    const item = this.#createItem(operation, desc)
    this.#items.push(item)
    try {
      item.registration = this.#host.registerMutation(desc, item)
    } catch (error) {
      this.#items.pop()
      this.#changed()
      this.#armCurrent()
      throw error
    }
    this.#observe(item)
    this.#changed()
    this.#armCurrent()
    return item.registration.promise
  }

  #enqueueCall(serviceName: string, method: string, args: unknown[]): Promise<unknown> {
    if (this.#detached) throw new Error('figbird: cannot enqueue into a detached mutation queue')
    const operation: MutationQueueOperation = { serviceName, method }
    const item = this.#createItem(operation, null)
    this.#items.push(item)
    try {
      item.registration = this.#host.registerCall(serviceName, method, args, item)
    } catch (error) {
      this.#items.pop()
      this.#changed()
      this.#armCurrent()
      throw error
    }
    this.#observe(item)
    this.#changed()
    this.#armCurrent()
    return item.registration.promise
  }

  #createItem(operation: MutationQueueOperation, desc: MutationDescriptor | null): QueueItem {
    const sequence = this.#nextSequence++
    const enqueuedAt = Date.now()
    const schedule = this.#schedule(operation)
    const policy = this.#capturePolicy()
    const item: QueueItem = {
      sequence,
      enqueuedAt,
      operation,
      desc,
      registration: null,
      policy,
      dueAt: enqueuedAt + schedule.wait,
      maxAt:
        schedule.maxWait === undefined ? Number.POSITIVE_INFINITY : enqueuedAt + schedule.maxWait,
      ready: false,
      settled: false,
      timer: null,
      listeners: new Set(),
      get timeout() {
        return item.policy.timeout
      },
      isReady: () => item.ready,
      subscribeReady: listener => {
        item.listeners.add(listener)
        return () => item.listeners.delete(listener)
      },
      expedite: () => {
        this.#flushThrough = Math.max(this.#flushThrough, item.sequence)
        this.#armCurrent()
      },
      onAttemptStart: () => {
        if (!item.settled) this.#setSnapshot({ status: 'saving', error: null })
      },
      onAttemptFailure: (error, attempt) => this.#onAttemptFailure(item, error, attempt),
    }
    return item
  }

  #observe(item: QueueItem): void {
    item.registration!.promise.then(
      () => this.#settled(item),
      () => this.#settled(item),
    )
  }

  #settled(item: QueueItem): void {
    item.settled = true
    if (item.timer) clearTimeout(item.timer)
    item.timer = null

    while (this.#items[0]?.settled) this.#items.shift()
    if (this.#items.length === 0) {
      this.#flushThrough = 0
      this.#setSnapshot({ status: 'idle', pending: 0, error: null })
      return
    }

    this.#changed()
    this.#armCurrent()
  }

  async #onAttemptFailure(
    item: QueueItem,
    error: Error,
    attempt: number,
  ): Promise<'retry' | 'discard'> {
    if (this.#shouldRetry(item.policy.retry, error, attempt, item.operation)) {
      this.#setSnapshot({ status: 'retrying', error })
      const delay = this.#retryDelay(item.policy.retryDelay, attempt, error, item.operation)
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
      return 'retry'
    }

    if (this.#detached) {
      this.#discardAfter(item)
      return 'discard'
    }

    this.#setSnapshot({ status: 'failed', error })
    return new Promise(resolve => {
      this.#failedDecision = resolve
    })
  }

  #shouldRetry(
    retry: MutationQueueRetry,
    error: Error,
    attempt: number,
    operation: MutationQueueOperation,
  ): boolean {
    if (retry === false) return false
    if (typeof retry === 'number') return attempt <= retry
    return retry(error, attempt, operation)
  }

  #retryDelay(
    delay: MutationQueueRetryDelay,
    attempt: number,
    error: Error,
    operation: MutationQueueOperation,
  ): number {
    return resolveRetryDelay(
      () => (typeof delay === 'number' ? delay : delay(attempt, error, operation)),
      defaultRetryDelay(attempt),
    )
  }

  #armCurrent(): void {
    const current = this.#items[0]
    if (!current || current.settled || current.ready || this.#failedDecision) return
    if (current.timer) clearTimeout(current.timer)

    const now = Date.now()
    let deadline = Math.min(current.dueAt, current.maxAt)
    for (const item of this.#items) {
      if (!item.settled) deadline = Math.min(deadline, item.dueAt, item.maxAt)
    }
    if (current.sequence <= this.#flushThrough) deadline = now
    const delay = Math.max(0, deadline - now)

    this.#setSnapshot({ status: 'scheduled', error: null })
    if (delay === 0) {
      this.#makeReady(current)
      return
    }
    current.timer = setTimeout(() => {
      current.timer = null
      this.#makeReady(current)
    }, delay)
  }

  #makeReady(item: QueueItem): void {
    if (this.#items[0] !== item || item.settled || item.ready) return
    item.ready = true
    for (const listener of item.listeners) listener()
  }

  #changed(): void {
    this.#setSnapshot({ pending: this.#items.filter(item => !item.settled).length })
  }

  #setSnapshot(change: Partial<MutationQueueSnapshot>): void {
    const next = { ...this.#snapshot, ...change }
    if (
      next.status === this.#snapshot.status &&
      next.pending === this.#snapshot.pending &&
      next.error === this.#snapshot.error
    ) {
      return
    }
    this.#snapshot = next
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch {
        // Listener errors must never alter mutation transport or settlement.
      }
    }
  }

  #schedule(operation: MutationQueueOperation): MutationSchedule {
    const schedule = this.#config.schedule?.(operation) ?? { wait: 0 }
    return {
      wait: Math.max(0, schedule.wait),
      ...(schedule.maxWait === undefined ? {} : { maxWait: Math.max(0, schedule.maxWait) }),
    }
  }

  #capturePolicy(): MutationQueuePolicy {
    return {
      retry: this.#config.retry ?? false,
      retryDelay: this.#config.retryDelay ?? 0,
      timeout: this.#config.timeout,
    }
  }

  #operationFromDesc(desc: MutationDescriptor): MutationQueueOperation {
    return {
      serviceName: desc.serviceName,
      method: desc.method,
      ...(desc.method === 'create' ? {} : { id: desc.id }),
      ...(desc.method === 'remove' ? {} : { data: desc.data }),
      ...(desc.params === undefined ? {} : { params: desc.params }),
    }
  }

  #canCoalesce(item: QueueItem, next: MutationDescriptor): boolean {
    const current = item.desc
    if (!current || current.method !== 'patch' || next.method !== 'patch') return false
    if (item.ready || item.settled) return false
    if (current.serviceName !== next.serviceName || current.id !== next.id) return false
    if (!structurallyEqual(current.params, next.params)) return false
    if (typeof current.optimistic !== 'boolean' || typeof next.optimistic !== 'boolean')
      return false
    if (current.optimistic !== next.optimistic) return false
    return this.#isRecord(current.data) && this.#isRecord(next.data)
  }

  #mergePatches(
    current: Extract<MutationDescriptor, { method: 'patch' }>,
    next: Extract<MutationDescriptor, { method: 'patch' }>,
  ): MutationDescriptor {
    const currentProjection = current.optimisticPatch ?? current.data
    const nextProjection = next.optimisticPatch ?? next.data
    const hasSeparateProjection =
      current.optimisticPatch !== undefined || next.optimisticPatch !== undefined
    return {
      ...current,
      data: {
        ...(current.data as Record<string, unknown>),
        ...(next.data as Record<string, unknown>),
      },
      ...(hasSeparateProjection &&
      this.#isRecord(currentProjection) &&
      this.#isRecord(nextProjection)
        ? {
            optimisticPatch: {
              ...currentProjection,
              ...nextProjection,
            },
          }
        : {}),
    }
  }

  #isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  }

  #discardAfter(item: QueueItem): void {
    const index = this.#items.indexOf(item)
    if (index === -1) return
    for (const pending of this.#items.slice(index + 1)) {
      pending.registration?.cancel(new MutationQueueDiscardedError())
    }
  }
}

function structurallyEqual(
  left: unknown,
  right: unknown,
  seen: Map<object, object> = new Map(),
): boolean {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime()
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    const previous = seen.get(left)
    if (previous) return previous === right
    seen.set(left, right)
    return left.every((value, index) => structurallyEqual(value, right[index], seen))
  }
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false
  const prototype = Object.getPrototypeOf(left)
  if (prototype !== Object.prototype && prototype !== null) return false
  const previous = seen.get(left)
  if (previous) return previous === right
  seen.set(left, right)
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      key =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        structurallyEqual(leftRecord[key], rightRecord[key], seen),
    )
  )
}
