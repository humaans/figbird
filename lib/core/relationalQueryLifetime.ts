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
  #prefetch: PrefetchLease | null = null

  constructor(clock: Clock, defaultStaleTime: number) {
    super()
    this.#clock = clock
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

    if (this.#coldStartAwaitingSubscriber) {
      // Keep adoption open through the commit's immediate StrictMode resubscription.
      queueMicrotask(() => {
        this.#coldStartAwaitingSubscriber = false
      })
      return { kind: 'adopt' }
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
  }

  canEvictAbandonedRead(): boolean {
    return this.owners.size === 0 && this.reads.get('root')?.status === 'settled'
  }

  suspensePromise(start: () => void): Promise<void> {
    if (this.reads.get('root')?.status === 'settled') return Promise.resolve()
    return this.read('root', null, start)
  }

  settleSuspense(error: Error | null): boolean {
    const wasPending = this.reads.get('root')?.status === 'pending'
    this.settle('root', null, error)
    return wasPending
  }

  override reset(): void {
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
