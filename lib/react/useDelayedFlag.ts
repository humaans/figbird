import { useEffect, useRef, useState } from 'react'

/**
 * Latches a boolean `true` after the source has stayed true for at least
 * `delay` ms. If `minVisible` > 0, once latched, it stays true for at least
 * `minVisible` ms regardless of when the source flips back to false.
 *
 * The canonical use case is "show a spinner only if the operation is slow,
 * and once it shows, don't let it flash off":
 *
 * ```tsx
 * const { data, isFetching } = useQuery(...)
 * const showSpinner = useDelayedFlag(isFetching, 250, 800)
 * return (
 *   <div>
 *     <Content data={data} />
 *     {showSpinner ? <Spinner /> : null}
 *   </div>
 * )
 * ```
 *
 * Fast responses skip the spinner entirely (no jank). Slow ones get a steady
 * indicator that doesn't yo-yo even if the data arrives just after the
 * spinner appeared.
 *
 * Pair with React.Suspense + a custom DelayedFallback component to apply the
 * same principle to first-mount loading.
 */
export function useDelayedFlag(flag: boolean, delay = 400, minVisible = 0): boolean {
  const [delayed, setDelayed] = useState(false)
  const shownAtRef = useRef<number | null>(null)

  useEffect(() => {
    if (flag) {
      if (delayed) return
      const t = setTimeout(() => {
        shownAtRef.current = Date.now()
        setDelayed(true)
      }, delay)
      return () => clearTimeout(t)
    }

    if (!delayed) return
    const elapsed = Date.now() - (shownAtRef.current ?? 0)
    const remaining = minVisible - elapsed
    if (remaining <= 0) {
      shownAtRef.current = null
      setDelayed(false)
      return
    }
    const t = setTimeout(() => {
      shownAtRef.current = null
      setDelayed(false)
    }, remaining)
    return () => clearTimeout(t)
    // We intentionally avoid depending on `delayed` — the effect re-runs whenever the
    // source flag changes, which is the only time the timers need to (re)arm.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flag, delay, minVisible])

  // Fast-path the legacy minVisible=0 behavior: hide the instant the source
  // flag flips, even before the cleanup effect has had a chance to update state.
  return delayed && (flag || minVisible > 0)
}
