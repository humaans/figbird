import type { Clock, ClockTimer } from './clock.js'

/** Suspense retries have no committed subscription yet. Keep their results through a render window. */
export const RENDER_READ_LEASE_MS = 5 * 60_000

/**
 * How long after a render's read settles its first subscriber takes the read as its own
 * without a freshness check. React cannot say whether a suspended render is still waiting
 * to commit or was thrown away, so this covers a boundary briefly held by slower siblings.
 * After it, the read is cached data and the subscriber's staleTime decides.
 */
export const COLD_START_ADOPTION_MS = 30_000

/** What the first owner of a render's read should do about freshness. */
export type RenderReadClaim =
  | { kind: 'adopt' }
  | { kind: 'check'; staleTime: number; fetchedAfter: number | undefined }

/**
 * A read made while rendering, before the component has committed and subscribed.
 *
 * Until then nothing owns the query, so this stands in for the render: its lease keeps
 * the result from being evicted, and it remembers what the render started so the first
 * owner can take the read over as its own instead of fetching again.
 */
export class RenderRead {
  readonly #clock: Clock
  #timer: ClockTimer | null = null
  #onExpire: (() => void) | null = null
  // The read the render started: when it settled, the staleness it accepted from cache,
  // and the store's fetch revision when it began. Everything it used is that fresh or
  // was fetched after that revision.
  #awaitingOwner = false
  #settledAt = 0
  #staleTime = 0
  #fetchedAfter: number | undefined = undefined

  constructor(clock: Clock) {
    this.#clock = clock
  }

  /** The lease is running: a render may still commit and expects this result. */
  get active(): boolean {
    return this.#timer !== null
  }

  /** A render used the query. Starts or extends the lease. */
  retain(onExpire: () => void): void {
    this.#onExpire = onExpire
    this.#renew()
  }

  /** The render started the query's graph. `unowned` is false when an owner started it. */
  started(unowned: boolean, staleTime: number, fetchedAfter: number | undefined): void {
    this.#awaitingOwner = unowned
    this.#settledAt = this.#clock.now()
    this.#staleTime = staleTime
    this.#fetchedAfter = fetchedAfter
  }

  /** The read the render is suspended on settled; the render is about to try again. */
  settled(): void {
    this.#renew()
    this.#settledAt = this.#clock.now()
  }

  /**
   * An owner arrived, which ends the lease. Returns how that owner should treat the
   * read the render started, or null when there is none to take over.
   */
  claim(staleTime: number): RenderReadClaim | null {
    this.#endLease()
    if (!this.#awaitingOwner) return null
    // Keep the read claimable through the commit's immediate StrictMode resubscription.
    queueMicrotask(() => {
      this.#awaitingOwner = false
    })
    // A render that never committed leaves its read unowned. Past the adoption window
    // it is no longer this owner's read, so its freshness is checked like any other.
    if (this.#clock.now() - this.#settledAt > COLD_START_ADOPTION_MS) return null
    if (staleTime >= this.#staleTime) return { kind: 'adopt' }
    // A stricter reader than the one whose render started the read. What that render
    // fetched is fresh for everyone; what it took from cache is not.
    return { kind: 'check', staleTime, fetchedAfter: this.#fetchedAfter }
  }

  /** The query was torn down. */
  reset(): void {
    this.#endLease()
    this.#awaitingOwner = false
  }

  #renew(): void {
    if (!this.#onExpire) return
    this.#timer?.cancel()
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null
      this.#onExpire?.()
    }, RENDER_READ_LEASE_MS)
    this.#timer.unref()
  }

  #endLease(): void {
    this.#timer?.cancel()
    this.#timer = null
    this.#onExpire = null
  }
}
