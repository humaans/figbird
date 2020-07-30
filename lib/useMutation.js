import { useReducer, useMemo, useCallback } from 'react'
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

  const create = useMethod(serviceName, 'create', actions.feathersCreated, dispatch, feathers)
  const update = useMethod(serviceName, 'update', actions.feathersUpdated, dispatch, feathers)
  const patch = useMethod(serviceName, 'patch', actions.feathersPatched, dispatch, feathers)
  const remove = useMethod(serviceName, 'remove', actions.feathersRemoved, dispatch, feathers)

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

function useMethod(serviceName, method, action, dispatch, feathers) {
  return useCallback(
    (...args) => {
      const service = feathers.service(serviceName)
      dispatch({ type: 'mutating' })
      return service[method](...args)
        .then(item => {
          action({ serviceName, item })
          dispatch({ type: 'success', payload: item })
          return item
        })
        .catch(err => {
          dispatch({ type: 'error', payload: err })
          throw err
        })
    },
    [serviceName, method, action, dispatch]
  )
}
