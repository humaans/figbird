/** Hands out the change sequence: strictly increasing safe integers. */
export type Sequencer = () => number

/** Sequence units per wall-clock millisecond in `hybridClock` values. */
export const SEQUENCE_UNITS_PER_MS = 1000

export interface HybridClockOptions {
  /** Wall clock in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number
  /**
   * The highest sequence issued before this process started, e.g. `max(_v)` read
   * at boot. Only needed when the wall clock may have stepped backwards across a
   * restart; the clock alone is monotonic across restarts otherwise.
   */
  last?: number
}

/**
 * A hybrid logical clock encoded as one safe integer:
 * `next = max(now() * 1000, previous + 1)`.
 *
 * The wall-clock part keeps sequences monotonic across restarts without any
 * coordination or persisted state; the logical `+ 1` keeps them unique within
 * the process when writes land in the same millisecond, allowing 1000 writes per
 * millisecond before the counter runs ahead of the clock (it catches up when the
 * load drops). `Date.now()` is about 1.8e12 in 2026, so values are about 1.8e15,
 * and `Number.MAX_SAFE_INTEGER` (9.007e15) is reached when `Date.now()` passes
 * 9.007e12 — the year 2255.
 *
 * Separate processes issue comparable (time-ordered) but not unique values, and
 * no process knows what another issued, so gap-free replay across nodes needs a
 * shared log. See DESIGN.md "Sync Protocol (experimental)".
 */
export function hybridClock({ now = Date.now, last = 0 }: HybridClockOptions = {}): Sequencer {
  let previous = last
  return () => {
    previous = Math.max(Math.floor(now()) * SEQUENCE_UNITS_PER_MS, previous + 1)
    if (!Number.isSafeInteger(previous)) {
      throw new RangeError(`hybridClock(): sequence ${previous} is not a safe integer`)
    }
    return previous
  }
}
