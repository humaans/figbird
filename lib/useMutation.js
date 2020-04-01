import { useReducer } from 'react'
import { useFigbird } from './core'

/**
 * Simple mutation hook exposing crud methods
 * of any feathers service. The resulting state
 * of calling these operations needs to be handled
 * by the caller. as you create/update/patch/remove
 * entities using this helper, the entity cache gets updated
 *
 * e.g.
 *
 * const { create, patch, remove, loading, error } = useMutation('notes')
 */
export function useMutation(serviceName) {
  const { feathers, actions } = useFigbird()

  const [state, dispatch] = useReducer(reducer, {
    loading: false,
    error: null,
  })

  const service = feathers.service(serviceName)
  const bind = (method, action) => {
    return (...args) => {
      dispatch({ type: 'mutating' })
      return service[method](...args)
        .then(entity => {
          dispatch({ type: 'success' })
          action({ serviceName, entity })
          return entity
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
      return { ...state, loading: true, error: null }
    case 'success':
      return { ...state, loading: false }
    case 'error':
      return { ...state, loading: false, error: action.payload }
  }
}
