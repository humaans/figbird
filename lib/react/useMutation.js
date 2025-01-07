import { useReducer, useMemo, useCallback, useEffect, useRef } from 'react'
import { useFigbird } from './react'
import { useDispatch } from './cache'

/**
 * Simple mutation hook exposing crud methods
 * of any feathers service. The resulting state
 * of calling these operations needs to be handled
 * by the caller. As you create/update/patch/remove
 * entities using this helper, the entities cache gets updated.
 *
 * const { create, patch, remove, status, data, error } = useMutation('notes')
 */
export function useMutation(serviceName) {
  const { queryManager } = useFigbird()

  const [state, dispatch] = useReducer(mutationReducer, {
    status: 'idle',
    data: null,
    error: null,
  })

  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const mutate = useCallback(
    async (method, ...args) => {
      dispatch({ type: 'mutating' })
      try {
        const item = await queryManager.mutate({ serviceName, method, args })
        if (mountedRef.current) {
          dispatch({ type: 'success', payload: item })
        }
        return item
      } catch (err) {
        if (mountedRef.current) {
          dispatch({ type: 'error', payload: err })
        }
        throw err
      }
    },
    [queryManager, serviceName, dispatch, mountedRef],
  )

  const create = useCallback((...args) => mutate('create', ...args), [mutate])
  const update = useCallback((...args) => mutate('update', ...args), [mutate])
  const patch = useCallback((...args) => mutate('patch', ...args), [mutate])
  const remove = useCallback((...args) => mutate('remove', ...args), [mutate])

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
