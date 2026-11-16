import { RENDER_READ_LEASE_MS, RenderReadLease } from './renderReadLease.js'
import type { Clock, ClockTimer } from './clock.js'
import { QueryLifetime } from './queryLifetime.js'
import { isWithinStaleTime, validateStaleTime } from './staleTime.js'

type QueryLease =
  | { source: 'subscriber'; staleTime: number }
  | { source: 'prefetch'; staleTime: number; adoptableUntil: number | null }
  | { source: 'prepare'; staleTime: number; preparationGeneration: number }

type PreparedAdoption =
  | { kind: 'idle'; adoptedThrough: number }
  | { kind: 'wave'; generation: number }

type FreshnessDecision = { kind: 'adopt' } | { kind: 'check'; staleTime: number }

interface PrefetchLease {
  at: number
  release: () => void
  timer: ClockTimer
}

/** Owns graph leases, freshness adoption, and the prefetch deadline for one query identity. */
export class RelationalQueryLifetime<TListener> extends QueryLifetime<TListener, QueryLease, null> {
  readonly #clock: Clock
  readonly #defaultStaleTime: number
  #nextPreparationGeneration = 0
  #preparedAdoption: PreparedAdoption = { kind: 'idle', adoptedThrough: 0 }
  #coldStartAwaitingSubscriber = false
  #coldStartSettledAt = 0
  #prefetch: PrefetchLease | null = null
  #failedReadRetryArmed = false
  #failedReadRetryGeneration = 0
  readonly #renderRead: RenderReadLease

  constructor(clock: Clock, defaultStaleTime: number) {
    super()
    this.#clock = clock
    this.#renderRead = new RenderReadLease(clock)
    this.#defaultStaleTime = defaultStaleTime
  }

  retain(
    listener: TListener,
    options?: { source?: QueryLease['source']; staleTime?: number | undefined },
  ): FreshnessDecision {
    const source = options?.source ?? 'subscriber'
    const staleTime =
      options?.staleTime === undefined
        ? this.#defaultStaleTime
        : validateStaleTime(options.staleTime, 'query(): staleTime')
    const lease: QueryLease =
      source === 'prepare'
        ? { source, staleTime, preparationGeneration: ++this.#nextPreparationGeneration }
        : source === 'prefetch'
          ? { source, staleTime, adoptableUntil: this.#clock.now() + staleTime }
          : { source, staleTime }
    const adoptsPreparation = source === 'subscriber' && this.#claimPreparedAdoption()
    const adoptsPrefetch = source === 'prepare' && this.#claimPrefetch()
    this.acquire(listener, lease)
    this.#renderRead.release()

    if (this.#coldStartAwaitingSubscriber) {
      // Keep adoption open through the commit's immediate StrictMode resubscription.
      queueMicrotask(() => {
        this.#coldStartAwaitingSubscriber = false
      })
      // A render that never committed leaves its read unowned. Past the render lease it
      // is no longer this subscriber's read, so its freshness is checked like any other.
      if (this.#clock.now() - this.#coldStartSettledAt <= RENDER_READ_LEASE_MS) {
        return { kind: 'adopt' }
      }
    }
    return adoptsPreparation
      ? { kind: 'adopt' }
      : {
          kind: 'check',
          staleTime: adoptsPrefetch && options?.staleTime === undefined ? Infinity : staleTime,
        }
  }

  prefetch(staleTime: number, retain: () => () => void): void {
    const now = this.#clock.now()
    if (this.#prefetch && isWithinStaleTime(this.#prefetch.at, staleTime, now)) return
    this.#releasePrefetch()
    const release = retain()
    const timer = this.#clock.setTimeout(() => this.#releasePrefetch(), staleTime)
    timer.unref()
    this.#prefetch = { at: now, release, timer }
  }

  graphStarted(): void {
    this.#coldStartAwaitingSubscriber = this.owners.size === 0
    this.#coldStartSettledAt = this.#clock.now()
  }

  retainRenderRead(onExpire: () => void): void {
    if (this.owners.size === 0) this.#renderRead.retain(onExpire)
  }

  get renderReadRetained(): boolean {
    return this.#renderRead.active
  }

  armFailedReadRetry(): void {
    const generation = this.#failedReadRetryGeneration
    queueMicrotask(() => {
      if (generation === this.#failedReadRetryGeneration) this.#failedReadRetryArmed = true
    })
  }

  consumeFailedReadRetry(): boolean {
    if (!this.#failedReadRetryArmed) return false
    this.clearFailedReadRetry()
    this.releaseRead('root')
    return true
  }

  clearFailedReadRetry(): void {
    this.#failedReadRetryArmed = false
    this.#failedReadRetryGeneration++
  }

  canReleaseFailedRead(): boolean {
    return [...this.owners.values()].every(owner => owner.source !== 'subscriber')
  }

  canReleaseColdStart(): boolean {
    return this.owners.size === 0 && this.reads.get('root')?.status !== 'pending'
  }

  canEvictAbandonedRead(): boolean {
    return !this.#renderRead.active && this.canReleaseColdStart()
  }

  suspensePromise(start: () => void): Promise<void> {
    if (this.reads.get('root')?.status === 'settled') return Promise.resolve()
    return this.read('root', null, start)
  }

  settleSuspense(error: Error | null): boolean {
    const wasPending = this.reads.get('root')?.status === 'pending'
    this.settle('root', null, error)
    if (wasPending && this.owners.size === 0) {
      this.#renderRead.renew()
      this.#coldStartSettledAt = this.#clock.now()
    }
    return wasPending
  }

  override reset(): void {
    this.clearFailedReadRetry()
    this.#renderRead.release()
    if (this.#preparedAdoption.kind === 'wave') {
      this.#preparedAdoption = { kind: 'idle', adoptedThrough: this.#preparedAdoption.generation }
    }
    this.#coldStartAwaitingSubscriber = false
    super.reset()
  }

  override dispose(): void {
    this.#releasePrefetch()
    super.dispose()
  }

  #releasePrefetch(): void {
    const lease = this.#prefetch
    this.#prefetch = null
    if (!lease) return
    lease.timer.cancel()
    lease.release()
  }

  #claimPreparedAdoption(): boolean {
    const adoption = this.#preparedAdoption
    const adoptedThrough = adoption.kind === 'wave' ? adoption.generation : adoption.adoptedThrough
    let newestActive = adoptedThrough
    for (const lease of this.owners.values()) {
      if (lease.source === 'prepare') {
        newestActive = Math.max(newestActive, lease.preparationGeneration)
      }
    }
    if (newestActive > adoptedThrough) {
      this.#preparedAdoption = { kind: 'wave', generation: newestActive }
      queueMicrotask(() => {
        const current = this.#preparedAdoption
        if (current.kind === 'wave' && current.generation === newestActive) {
          this.#preparedAdoption = { kind: 'idle', adoptedThrough: newestActive }
        }
      })
    }
    return this.#preparedAdoption.kind === 'wave'
  }

  #claimPrefetch(): boolean {
    const now = this.#clock.now()
    let claimed = false
    for (const lease of this.owners.values()) {
      if (lease.source === 'prefetch' && lease.adoptableUntil !== null) {
        claimed ||= now < lease.adoptableUntil
        lease.adoptableUntil = null
      }
    }
    return claimed
  }
}
