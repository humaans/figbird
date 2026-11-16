import type { Clock, ClockTimer } from './clock.js'

/** Suspense retries have no committed subscription yet. Keep their results through a render window. */
export const RENDER_READ_LEASE_MS = 5 * 60_000

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
