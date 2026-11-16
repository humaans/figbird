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

export class RenderReadLease {
  readonly #clock: Clock
  #timer: ClockTimer | null = null
  #onExpire: (() => void) | null = null

  constructor(clock: Clock) {
    this.#clock = clock
  }
  get active(): boolean {
    return this.#timer !== null
  }

  retain(onExpire: () => void): void {
    this.#onExpire = onExpire
    this.renew()
  }

  renew(): void {
    if (!this.#onExpire) return
    this.#timer?.cancel()
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null
      this.#onExpire?.()
    }, RENDER_READ_LEASE_MS)
    this.#timer.unref()
  }

  release(): void {
    this.#timer?.cancel()
    this.#timer = null
    this.#onExpire = null
  }
}
