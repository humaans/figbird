/** One timer bounds idle query retention without one timeout per cache entry. */
export class QueryRetention {
  readonly #duration: number
  readonly #expire: (queryId: string) => void
  readonly #deadlines = new Map<string, number>()
  #timer: ReturnType<typeof setTimeout> | null = null
  #disposed = false

  constructor(duration: number, expire: (queryId: string) => void) {
    if (
      duration !== Infinity &&
      (!Number.isFinite(duration) || duration < 0 || duration > 2_147_483_647)
    ) {
      throw new RangeError('Figbird(): gcTime must be between 0 and 2147483647, or Infinity')
    }
    this.#duration = duration
    this.#expire = expire
  }

  retain(queryId: string): void {
    if (this.#disposed || this.#duration === Infinity) return
    this.#deadlines.set(queryId, Date.now() + this.#duration)
    if (this.#timer === null) this.#arm(this.#duration)
  }

  cancel(queryId: string): void {
    this.#deadlines.delete(queryId)
  }

  dispose(): void {
    this.#disposed = true
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
    this.#deadlines.clear()
  }

  #arm(delay: number): void {
    this.#timer = setTimeout(() => {
      this.#timer = null
      const now = Date.now()
      let next = Infinity
      for (const [queryId, deadline] of this.#deadlines) {
        if (deadline <= now) {
          this.#deadlines.delete(queryId)
          this.#expire(queryId)
        } else {
          next = Math.min(next, deadline)
        }
      }
      if (!this.#disposed && next !== Infinity) this.#arm(Math.max(0, next - Date.now()))
    }, delay)
    const timer = this.#timer as ReturnType<typeof setTimeout> & { unref?: () => void }
    timer.unref?.()
  }
}
