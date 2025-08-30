import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { findServiceByName } from '../core/schema.js'
import { useFigbird } from './react.js'

interface MutationState<T> {
  status: 'idle' | 'loading' | 'success' | 'error'
  data: T | null
  error: Error | null
}

type MutationAction<T> =
  | { type: 'mutating' }
  | { type: 'success'; payload: T }
  | { type: 'error'; payload: Error }

type MutationMethod = 'create' | 'update' | 'patch' | 'remove'

export interface UseMutationResult<
  TItem,
  TCreate = Partial<TItem>,
  TUpdate = TItem,
  TPatch = Partial<TItem>,
> {
  // Overloaded create method for better type inference
  create(data: TCreate, params?: unknown): Promise<TItem>
  create(data: TCreate[], params?: unknown): Promise<TItem[]>
  create(data: TCreate | TCreate[], params?: unknown): Promise<TItem | TItem[]>
  update: (id: string | number, data: TUpdate, params?: unknown) => Promise<TItem>
  patch: (id: string | number, data: TPatch, params?: unknown) => Promise<TItem>
  remove: (id: string | number, params?: unknown) => Promise<TItem>
  data: TItem | TItem[] | null
  status: 'idle' | 'loading' | 'success' | 'error'
  error: Error | null
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
export function useMutation<
  TItem = Record<string, unknown>,
  TCreate = Partial<TItem>,
  TUpdate = TItem,
  TPatch = Partial<TItem>,
>(serviceName: string): UseMutationResult<TItem, TCreate, TUpdate, TPatch> {
  const figbird = useFigbird()
  const service = findServiceByName(figbird.schema, serviceName)
  const actualServiceName = service?.name ?? serviceName

  const [state, dispatch] = useReducer(mutationReducer<TItem | TItem[]>, {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (method: MutationMethod, ...args: unknown[]): Promise<any> => {
      dispatch({ type: 'mutating' })
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const item = await figbird.mutate<any>({
          serviceName: actualServiceName,
          method,
          args,
        })
        if (mountedRef.current) {
          dispatch({ type: 'success', payload: item })
        }
        return item
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        if (mountedRef.current) {
          dispatch({ type: 'error', payload: error })
        }
        throw error
      }
    },
    [figbird, actualServiceName, dispatch, mountedRef],
  )

  const create = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (data: any, params?: unknown) => mutate('create', data, params),
    [mutate],
  )
  const update = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (id: string | number, data: any, params?: unknown) => mutate('update', id, data, params),
    [mutate],
  )
  const patch = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (id: string | number, data: any, params?: unknown) => mutate('patch', id, data, params),
    [mutate],
  )
  const remove = useCallback(
    (id: string | number, params?: unknown) => mutate('remove', id, params),
    [mutate],
  )

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
