import { useRef } from 'react'

/* returns the value from the previous render call, or `undefined` for the first render */
export function usePrevious(value) {
  const ref = useRef(undefined)
  const prev = ref.current
  ref.current = value
  return prev
}
