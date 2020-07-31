import { useReducer, useMemo, useCallback, useEffect, useRef } from 'react'
import { useFigbird } from './core'

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
  const { feathers, actions } = useFigbird()

  const [state, dispatch] = useReducer(reducer, {
    status: 'idle',
    data: null,
    error: null,
    loading: false, // deprecated, use status
  })

  const mountedRef = useRef()
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const common = [serviceName, dispatch, feathers, mountedRef]
  const create = useMethod('create', actions.feathersCreated, ...common)
  const update = useMethod('update', actions.feathersUpdated, ...common)
  const patch = useMethod('patch', actions.feathersPatched, ...common)
  const remove = useMethod('remove', actions.feathersRemoved, ...common)

  const mutation = useMemo(
    () => ({
      create,
      update,
      patch,
      remove,
      data: state.data,
      status: state.status,
      error: state.error,
      loading: state.loading, // deprecated, use status instead
    }),
    [create, update, patch, remove, state]
  )

  return mutation
}

function reducer(state, action) {
  switch (action.type) {
    case 'mutating':
      return { ...state, status: 'loading', loading: true, data: null, error: null }
    case 'success':
      return { ...state, status: 'success', loading: false, data: action.payload }
    case 'error':
      return { ...state, status: 'error', loading: false, error: action.payload }
  }
}

function useMethod(method, action, serviceName, dispatch, feathers, mountedRef) {
  return useCallback(
    (...args) => {
      const service = feathers.service(serviceName)
      dispatch({ type: 'mutating' })
      return service[method](...args)
        .then(item => {
          const isMounted = mountedRef.current
          action({ serviceName, item })
          isMounted && dispatch({ type: 'success', payload: item })
          return item
        })
        .catch(err => {
          const isMounted = mountedRef.current
          isMounted && dispatch({ type: 'error', payload: err })
          throw err
        })
    },
    [serviceName, method, action, dispatch]
  )
}
