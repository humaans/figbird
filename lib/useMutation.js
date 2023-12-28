import { useReducer, useMemo, useCallback, useEffect, useRef } from 'react'
import { useFeathers } from './core'
import { useDispatch } from './cache'

/**
 * Simple mutation hook exposing crud methods
 * of any feathers service. The resulting state
 * of calling these operations needs to be handled
 * by the caller. as you create/update/patch/remove
 * entities using this helper, the entities cache gets updated
 *
 * e.g.
 *
 * const { create, patch, remove, status, data, error } = useMutation('notes')
 */
export function useMutation(serviceName) {
  const feathers = useFeathers()
  const cacheDispatch = useDispatch()

  const [state, dispatch] = useReducer(mutationReducer, {
    status: 'idle',
    data: null,
    error: null,
  })

  const mountedRef = useRef()
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const mutate = useCallback(
    (method, event, ...args) => {
      const service = feathers.service(serviceName)
      dispatch({ type: 'mutating' })
      return service[method](...args)
        .then(item => {
          const isMounted = mountedRef.current
          cacheDispatch({ event, serviceName, item })
          isMounted && dispatch({ type: 'success', payload: item })
          return item
        })
        .catch(err => {
          const isMounted = mountedRef.current
          isMounted && dispatch({ type: 'error', payload: err })
          throw err
        })
    },
    [feathers, serviceName, dispatch, cacheDispatch, mountedRef],
  )

  const create = useCallback((...args) => mutate('create', 'created', ...args), [mutate])
  const update = useCallback((...args) => mutate('update', 'updated', ...args), [mutate])
  const patch = useCallback((...args) => mutate('patch', 'patched', ...args), [mutate])
  const remove = useCallback((...args) => mutate('remove', 'removed', ...args), [mutate])

  return useMemo(
    () => ({
      create,
      update,
      patch,
      remove,
      data: state.data,
      status: state.status,
      error: state.error,
    }),
    [create, update, patch, remove, state],
  )
}

function mutationReducer(state, action) {
  switch (action.type) {
    case 'mutating':
      return { ...state, status: 'loading', data: null, error: null }
    case 'success':
      return { ...state, status: 'success', data: action.payload }
    case 'error':
      return { ...state, status: 'error', error: action.payload }
  }
}
