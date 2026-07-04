import { startTransition, useEffect, useState } from 'react'

/**
 * Debounced value that commits inside a React transition.
 *
 * The text-input companion to `useQuery`'s exact-reads contract: every keystroke
 * would otherwise be a new query (a fresh cold suspension), so the value is
 * debounced — and when it finally commits, it commits inside `startTransition`,
 * so React keeps the previous committed UI on screen instead of unwinding to a
 * Suspense fallback while the new query loads.
 *
 * ```tsx
 * const [searchInput, setSearchInput] = useState('')
 * const search = useDebouncedTransition(searchInput.trim(), 250)
 * // pass `search` into the query; bind the input to `searchInput`
 * ```
 *
 * See the "no-flash checklist" in the docs for the full pattern set.
 */
export function useDebouncedTransition<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => startTransition(() => setDebounced(value)), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}
