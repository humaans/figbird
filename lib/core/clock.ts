/** Internal time source; promise and microtask scheduling stay on the runtime. */
export interface Clock {
  now(): number
  setTimeout(callback: () => void, delay: number): ClockTimer
}

export interface ClockTimer {
  cancel(): void
  unref(): void
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(callback, delay) {
    const timer = setTimeout(callback, delay)
    return {
      cancel: () => clearTimeout(timer),
      unref: () => {
        const handle = timer as ReturnType<typeof setTimeout> & { unref?: () => void }
        handle.unref?.()
      },
    }
  },
}
