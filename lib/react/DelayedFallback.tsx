import { useEffect, useState, type ReactNode } from 'react'

/**
 * A Suspense fallback that only appears when loading is actually slow.
 *
 * Fast responses would otherwise flash a skeleton for a few dozen milliseconds —
 * worse than showing nothing. This renders `null` for `delay` ms, then the real
 * fallback; fast loads resolve before it ever appears.
 *
 * ```tsx
 * <Suspense fallback={<DelayedFallback delay={250}><Skeleton /></DelayedFallback>}>
 *   <IssueDetail id={id} />
 * </Suspense>
 * ```
 *
 * The spinner-flag sibling for `isFetching` indicators is `useDelayedFlag`. See the
 * "no-flash checklist" in the docs for the full pattern set.
 */
export function DelayedFallback({
  delay = 250,
  children,
}: {
  delay?: number
  children: ReactNode
}) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), delay)
    return () => clearTimeout(t)
  }, [delay])
  return visible ? <>{children}</> : null
}
