import { systemClock, type Clock, type ClockTimer } from './clock.js'
/** One timer bounds idle query retention without one timeout per cache entry. */
export class QueryRetention {
  readonly #clock: Clock
  readonly #duration: number
  readonly #expire: (queryId: string) => void
  readonly #deadlines = new Map<string, number>()
  #timer: ClockTimer | null = null
  #disposed = false

  constructor(duration: number, expire: (queryId: string) => void, clock: Clock = systemClock) {
    if (
      duration !== Infinity &&
      (!Number.isFinite(duration) || duration < 0 || duration > 2_147_483_647)
    ) {
      throw new RangeError('Figbird(): gcTime must be between 0 and 2147483647, or Infinity')
    }
    this.#clock = clock
    this.#duration = duration
    this.#expire = expire
  }

  retain(queryId: string): void {
    if (this.#disposed || this.#duration === Infinity) return
    this.#deadlines.set(queryId, this.#clock.now() + this.#duration)
    if (this.#timer === null) this.#arm(this.#duration)
  }

  cancel(queryId: string): void {
    this.#deadlines.delete(queryId)
  }

  dispose(): void {
    this.#disposed = true
    if (this.#timer !== null) this.#timer.cancel()
    this.#timer = null
    this.#deadlines.clear()
  }

  #arm(delay: number): void {
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null
      const now = this.#clock.now()
      let next = Infinity
      for (const [queryId, deadline] of this.#deadlines) {
        if (deadline <= now) {
          this.#deadlines.delete(queryId)
          this.#expire(queryId)
        } else {
          next = Math.min(next, deadline)
        }
      }
      if (!this.#disposed && next !== Infinity) this.#arm(Math.max(0, next - this.#clock.now()))
    }, delay)
    this.#timer.unref()
  }
}
