import { useLayoutEffect, useState } from 'react'
import { now } from './format.js'

function readClock() {
  return { now: now(), wallNow: Date.now() }
}

/** Refresh displayed ages and in-flight durations without reading clocks during render. */
export function useClock(running = true) {
  const [clock, setClock] = useState(readClock)
  useLayoutEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Sample the external clock before paint when ticking starts or stops.
    setClock(readClock())
    if (!running) return
    const timer = setInterval(() => setClock(readClock()), 1_000)
    return () => clearInterval(timer)
  }, [running])
  return clock
}
