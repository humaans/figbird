import { setImmediate } from 'node:timers/promises'
import type { Clock, ClockTimer } from '../lib/core/clock.js'
import { waitForEmissions } from './helpers.js'

/** Drain real transport emissions and promise continuations without advancing policy time. */
export async function flushTasks(): Promise<void> {
  await waitForEmissions()
  await setImmediate()
}

export class TestClock implements Clock {
  #now = Date.now()
  #nextId = 0
  #timers = new Map<number, { at: number; callback: () => void }>()

  now(): number {
    return this.#now
  }

  setTimeout(callback: () => void, delay: number): ClockTimer {
    const id = this.#nextId++
    this.#timers.set(id, { at: this.#now + Math.max(0, delay), callback })
    return {
      cancel: () => {
        this.#timers.delete(id)
      },
      unref: () => {},
    }
  }

  async advance(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0)
      throw new Error('Clock must advance by a finite non-negative duration')
    await flushTasks()
    const target = this.#now + ms
    let remaining = 10_000
    while (true) {
      const next = [...this.#timers]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!next) break
      if (--remaining === 0) throw new Error('Clock did not reach an idle state')
      this.#now = next[1].at
      this.#timers.delete(next[0])
      next[1].callback()
      await flushTasks()
    }
    this.#now = target
    await flushTasks()
  }
}
