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

export interface UseMutationResult<
  TItem,
  TCreate = Partial<TItem>,
  TUpdate = TItem,
  TPatch = Partial<TItem>,
  TData = TItem | TItem[],
> {
  // Overloaded create method for better type inference
  create(data: TCreate, params?: unknown): Promise<TItem>
  create(data: TCreate[], params?: unknown): Promise<TItem[]>
  create(data: TCreate | TCreate[], params?: unknown): Promise<TItem | TItem[]>
  update: (id: string | number, data: TUpdate, params?: unknown) => Promise<TItem>
  patch: (id: string | number, data: TPatch, params?: unknown) => Promise<TItem>
  remove: (id: string | number, params?: unknown) => Promise<TItem>
  call: (method: string, ...args: unknown[]) => Promise<unknown>
  data: TData | null
  status: 'idle' | 'loading' | 'success' | 'error'
  error: Error | null
}

/**
 * Simple mutation hook exposing crud methods
 * of any feathers service. The resulting state
 * of calling these operations needs to be handled
 * by the caller. As you create/update/patch/remove
 * entities using this helper, the entities cache gets updated.
 * Custom method calls are imperative and do not auto-merge
 * into the query cache.
 *
 * Returns untyped data. For type-safe mutations, use createHooks(figbird).
 *
 * const { create, patch, remove, call, status, data, error } = useMutation('notes')
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useMutation(serviceName: string): UseMutationResult<any, any, any, any> {
  const figbird = useFigbird()
  const service = findServiceByName(figbird.schema, serviceName)
  const actualServiceName = service?.name ?? serviceName

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [state, dispatch] = useReducer(mutationReducer<any>, {
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

  const executeMutation = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (promise: Promise<any>): Promise<any> => {
      dispatch({ type: 'mutating' })
      try {
        const item = await promise
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
    [dispatch, mountedRef],
  )

  const create = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (data: any, params?: unknown) =>
      executeMutation(
        figbird.mutate({
          serviceName: actualServiceName,
          method: 'create' as const,
          data,
          params,
        }),
      ),
    [executeMutation, figbird, actualServiceName],
  )
  const update = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (id: string | number, data: any, params?: unknown) =>
      executeMutation(
        figbird.mutate({
          serviceName: actualServiceName,
          method: 'update' as const,
          id,
          data,
          params,
        }),
      ),
    [executeMutation, figbird, actualServiceName],
  )
  const patch = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (id: string | number, data: any, params?: unknown) =>
      executeMutation(
        figbird.mutate({
          serviceName: actualServiceName,
          method: 'patch' as const,
          id,
          data,
          params,
        }),
      ),
    [executeMutation, figbird, actualServiceName],
  )
  const remove = useCallback(
    (id: string | number, params?: unknown) =>
      executeMutation(
        figbird.mutate({
          serviceName: actualServiceName,
          method: 'remove' as const,
          id,
          params,
        }),
      ),
    [executeMutation, figbird, actualServiceName],
  )
  const call = useCallback(
    (method: string, ...args: unknown[]) =>
      executeMutation(figbird.adapter.mutate(actualServiceName, method, args)),
    [executeMutation, figbird, actualServiceName],
  )

  return useMemo(
    () => ({
      create,
      update,
      patch,
      remove,
      call,
      data: state.data,
      status: state.status,
      error: state.error,
    }),
    [create, update, patch, remove, call, state],
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
