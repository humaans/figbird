import { useRef, useCallback, useInsertionEffect } from 'react'

export function useEffectEvent(handler) {
  const ref = useRef(null)
  useInsertionEffect(() => {
    ref.current = handler
  })
  return useCallback((...args) => {
    const fn = ref.current
    fn(...args)
  }, [])
}
