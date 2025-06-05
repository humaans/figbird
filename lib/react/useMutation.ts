import { useReducer, useMemo, useCallback, useEffect, useRef } from 'react'
import { useFigbird } from './react.js'

interface MutationState {
  status: 'idle' | 'loading' | 'success' | 'error'
  data: any
  error: any
}

type MutationAction =
  | { type: 'mutating' }
  | { type: 'success'; payload: any }
  | { type: 'error'; payload: any }

type MutationMethod = 'create' | 'update' | 'patch' | 'remove'

interface UseMutationResult {
  create: (...args: any[]) => Promise<any>
  update: (...args: any[]) => Promise<any>
  patch: (...args: any[]) => Promise<any>
  remove: (...args: any[]) => Promise<any>
  data: any
  status: 'idle' | 'loading' | 'success' | 'error'
  error: any
}

/**
 * Simple mutation hook exposing crud methods
 * of any feathers service. The resulting state
 * of calling these operations needs to be handled
 * by the caller. As you create/update/patch/remove
 * entities using this helper, the entities cache gets updated.
 *
 * const { create, patch, remove, status, data, error } = useMutation('notes')
 */
export function useMutation(serviceName: string): UseMutationResult {
  const figbird = useFigbird()

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
    async (method: MutationMethod, ...args: any[]): Promise<any> => {
      dispatch({ type: 'mutating' })
      try {
        const item = await figbird.mutate({ serviceName, method, args })
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
    [figbird, serviceName, dispatch, mountedRef],
  )

  const create = useCallback((...args: any[]) => mutate('create', ...args), [mutate])
  const update = useCallback((...args: any[]) => mutate('update', ...args), [mutate])
  const patch = useCallback((...args: any[]) => mutate('patch', ...args), [mutate])
  const remove = useCallback((...args: any[]) => mutate('remove', ...args), [mutate])

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

function mutationReducer(state: MutationState, action: MutationAction): MutationState {
  switch (action.type) {
    case 'mutating':
      return { ...state, status: 'loading', data: null, error: null }
    case 'success':
      return { ...state, status: 'success', data: action.payload }
    case 'error':
      return { ...state, status: 'error', error: action.payload }
    default:
      return state
  }
}
