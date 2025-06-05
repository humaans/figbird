import { useReducer, useMemo, useCallback, useEffect, useRef } from 'react'
import { useFigbird } from './react.js'
import type { FigbirdError, ServiceItem } from '../types.js'

interface MutationState<T> {
  status: 'idle' | 'loading' | 'success' | 'error'
  data: T | null
  error: FigbirdError
}

type MutationAction<T> =
  | { type: 'mutating' }
  | { type: 'success'; payload: T }
  | { type: 'error'; payload: FigbirdError }

type MutationMethod = 'create' | 'update' | 'patch' | 'remove'

interface UseMutationResult<T> {
  create: (...args: unknown[]) => Promise<T>
  update: (...args: unknown[]) => Promise<T>
  patch: (...args: unknown[]) => Promise<T>
  remove: (...args: unknown[]) => Promise<T>
  data: T | null
  status: 'idle' | 'loading' | 'success' | 'error'
  error: FigbirdError
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
export function useMutation<T extends ServiceItem>(serviceName: string): UseMutationResult<T> {
  const figbird = useFigbird()

  const [state, dispatch] = useReducer(mutationReducer<T>, {
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
    async (method: MutationMethod, ...args: unknown[]): Promise<T> => {
      dispatch({ type: 'mutating' })
      try {
        const item = await figbird.mutate<T>({ serviceName, method, args })
        if (mountedRef.current) {
          dispatch({ type: 'success', payload: item })
        }
        return item
      } catch (err) {
        if (mountedRef.current) {
          dispatch({ type: 'error', payload: err as FigbirdError })
        }
        throw err
      }
    },
    [figbird, serviceName, dispatch, mountedRef],
  )

  const create = useCallback((...args: unknown[]) => mutate('create', ...args), [mutate])
  const update = useCallback((...args: unknown[]) => mutate('update', ...args), [mutate])
  const patch = useCallback((...args: unknown[]) => mutate('patch', ...args), [mutate])
  const remove = useCallback((...args: unknown[]) => mutate('remove', ...args), [mutate])

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

function mutationReducer<T>(state: MutationState<T>, action: MutationAction<T>): MutationState<T> {
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
