import { RenderRead } from './renderReadLease.js'
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

type FreshnessDecision =
  | { kind: 'adopt' }
  | { kind: 'check'; staleTime: number; fetchedAfter?: number | undefined }

interface PrefetchLease {
  at: number
  release: () => void
  timer: ClockTimer
}

/**
 * Who holds one query identity, and what a new holder should do about freshness.
 *
 * A query is held by its owners (subscribers, `prepare()` handles, a prefetch pin) and,
 * before any of those exist, by the render that read it: a Suspense render has no
 * subscription until it commits. Three facts answer every lifetime question:
 *
 * - `owned`: an owner exists.
 * - `awaited`: a render is suspended on the root read, so the graph must stay to settle it.
 * - `leased`: a render read the query recently and may still commit.
 *
 * Nothing may tear the query down while it is owned or awaited. The lease additionally
 * protects it from cache-pressure eviction, but not from an explicit release.
 */
export class RelationalQueryLifetime<TListener> extends QueryLifetime<TListener, QueryLease, null> {
  readonly #clock: Clock
  readonly #defaultStaleTime: number
  #nextPreparationGeneration = 0
  #preparedAdoption: PreparedAdoption = { kind: 'idle', adoptedThrough: 0 }
  #prefetch: PrefetchLease | null = null
  #failedReadRetryArmed = false
  #failedReadRetryGeneration = 0
  readonly #renderRead: RenderRead

  constructor(clock: Clock, defaultStaleTime: number) {
    super()
    this.#clock = clock
    this.#renderRead = new RenderRead(clock)
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
    const claim = this.#renderRead.claim(staleTime)
    if (claim) return claim
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

  /** `staleTime` is the tolerance the graph accepts cached results with. */
  graphStarted(staleTime = 0, fetchedAfter?: number): void {
    this.#renderRead.started(!this.owned, staleTime, fetchedAfter)
  }

  /** A render used the query. Without an owner, the render's lease holds it. */
  retainRenderRead(onExpire: () => void): void {
    if (!this.owned) this.#renderRead.retain(onExpire)
  }

  get owned(): boolean {
    return this.owners.size > 0
  }

  /** A render is suspended on the root read's promise. */
  get awaited(): boolean {
    return this.reads.get('root')?.status === 'pending'
  }

  /** A render read the query recently and may still commit. */
  get leased(): boolean {
    return this.#renderRead.active
  }

  /** Nothing holds the query, so cache pressure may evict it. */
  canEvict(): boolean {
    return !this.owned && !this.awaited && !this.leased
  }

  /** An explicit release may drop the query: a lease alone does not keep it. */
  canAbandon(): boolean {
    return !this.owned && !this.awaited
  }

  /**
   * A Suspense reader threw this query's failure to its error boundary. With no
   * subscriber the failed query is dropped, so a boundary retry starts a fresh one.
   * A subscriber keeps it alive, so the retry is armed to refetch in place instead.
   */
  failedReadObserved(stillFailed: () => boolean, abandon: () => void): void {
    if (this.#hasSubscriber()) {
      this.#armFailedReadRetry()
      return
    }
    // A reader in the same commit subscribes after this render, so look again after it.
    queueMicrotask(() => {
      if (!stillFailed()) return
      if (this.#hasSubscriber()) this.#armFailedReadRetry()
      else abandon()
    })
  }

  /** Armed after this pass, so the render that just threw does not consume its own retry. */
  #armFailedReadRetry(): void {
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

  #hasSubscriber(): boolean {
    return [...this.owners.values()].some(owner => owner.source === 'subscriber')
  }

  suspensePromise(start: () => void): Promise<void> {
    if (this.reads.get('root')?.status === 'settled') return Promise.resolve()
    return this.read('root', null, start)
  }

  settleSuspense(error: Error | null): boolean {
    const wasPending = this.reads.get('root')?.status === 'pending'
    this.settle('root', null, error)
    if (wasPending && !this.owned) this.#renderRead.settled()
    return wasPending
  }

  override reset(): void {
    this.clearFailedReadRetry()
    this.#renderRead.reset()
    if (this.#preparedAdoption.kind === 'wave') {
      this.#preparedAdoption = { kind: 'idle', adoptedThrough: this.#preparedAdoption.generation }
    }
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
