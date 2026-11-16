import { systemClock, type Clock, type ClockTimer } from './clock.js'
/** One timer bounds idle query retention without one timeout per cache entry. */
export class QueryRetention {
  readonly #clock: Clock
  readonly #duration: number
  readonly #expire: (queryId: string) => number | void
  readonly #deadlines = new Map<string, number>()
  #timer: ClockTimer | null = null
  /** When the pending timer fires. */
  #timerAt = Infinity
  #disposed = false

  /**
   * `expire` releases an idle entry. It may return a delay in milliseconds to keep the
   * entry and be asked again after that long, for an entry that is still in use.
   */
  constructor(
    duration: number,
    expire: (queryId: string) => number | void,
    clock: Clock = systemClock,
  ) {
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
    const deadline = this.#clock.now() + this.#duration
    this.#deadlines.set(queryId, deadline)
    // A postponed entry can leave the timer set far later than this deadline.
    if (this.#timer !== null && deadline >= this.#timerAt) return
    this.#cancelTimer()
    this.#arm(this.#duration)
  }

  cancel(queryId: string): void {
    this.#deadlines.delete(queryId)
  }

  dispose(): void {
    this.#disposed = true
    this.#cancelTimer()
    this.#deadlines.clear()
  }

  #cancelTimer(): void {
    this.#timer?.cancel()
    this.#timer = null
    this.#timerAt = Infinity
  }

  #arm(delay: number): void {
    this.#timerAt = this.#clock.now() + delay
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null
      this.#timerAt = Infinity
      const now = this.#clock.now()
      let next = Infinity
      // Sweep a copy: an entry retained or postponed during the sweep waits for the
      // next timer, so a callback can never keep this pass running.
      const postponed: [string, number][] = []
      for (const [queryId, deadline] of [...this.#deadlines]) {
        if (deadline > now || this.#deadlines.get(queryId) !== deadline) continue
        this.#deadlines.delete(queryId)
        const delay = this.#expire(queryId)
        if (typeof delay === 'number') postponed.push([queryId, now + Math.max(1, delay)])
      }
      if (this.#disposed) return
      for (const [queryId, deadline] of postponed) {
        // An expiry callback may have retained the entry again with its own deadline.
        if (!this.#deadlines.has(queryId)) this.#deadlines.set(queryId, deadline)
      }
      // A retain() during the sweep armed its own timer. Replace it so exactly one
      // timer is pending, set for the earliest deadline.
      this.#cancelTimer()
      for (const deadline of this.#deadlines.values()) next = Math.min(next, deadline)
      if (next !== Infinity) this.#arm(Math.max(0, next - this.#clock.now()))
    }, delay)
    this.#timer.unref()
  }
}
