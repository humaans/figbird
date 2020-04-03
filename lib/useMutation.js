import { useReducer } from 'react'
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

  const service = feathers.service(serviceName)
  const bind = (method, action) => {
    return (...args) => {
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
    }
  }

  return {
    create: bind('create', actions.feathersCreated),
    update: bind('update', actions.feathersUpdated),
    patch: bind('patch', actions.feathersPatched),
    remove: bind('remove', actions.feathersRemoved),
    loading: state.loading,
    error: state.error,
  }
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
