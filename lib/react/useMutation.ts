import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type { MutationOptions } from '../core/figbird.js'
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

/**
 * Per-call mutation options. Combines `MutationOptions` (e.g. `optimistic`)
 * with the adapter `params` passthrough.
 */
export interface MutationCallOptions<TItem = unknown> extends MutationOptions<TItem> {
  params?: unknown
}

export interface UseMutationResult<
  TItem,
  TCreate = Partial<TItem>,
  TUpdate = TItem,
  TPatch = Partial<TItem>,
> {
  // Overloaded create method for better type inference
  create(data: TCreate, options?: MutationCallOptions<TItem>): Promise<TItem>
  create(data: TCreate[], options?: MutationCallOptions<TItem[]>): Promise<TItem[]>
  create(
    data: TCreate | TCreate[],
    options?: MutationCallOptions<TItem | TItem[]>,
  ): Promise<TItem | TItem[]>
  update: (
    id: string | number,
    data: TUpdate,
    options?: MutationCallOptions<TItem>,
  ) => Promise<TItem>
  patch: (id: string | number, data: TPatch, options?: MutationCallOptions<TItem>) => Promise<TItem>
  remove: (id: string | number, options?: MutationCallOptions<TItem>) => Promise<TItem>
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
 * Returns untyped data. For type-safe mutations, use createHooks(figbird).
 *
 * const { create, patch, remove, status, data, error } = useMutation('notes')
 */
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export function useMutation(serviceName: string): UseMutationResult<any, any, any, any> {
  const figbird = useFigbird()

  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
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
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
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
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    (data: any, options?: MutationCallOptions) =>
      executeMutation(
        figbird.mutate({
          serviceName,
          method: 'create' as const,
          data,
          params: options?.params,
          optimistic: options?.optimistic,
        }),
      ),
    [executeMutation, figbird, serviceName],
  )
  const update = useCallback(
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    (id: string | number, data: any, options?: MutationCallOptions) =>
      executeMutation(
        figbird.mutate({
          serviceName,
          method: 'update' as const,
          id,
          data,
          params: options?.params,
          optimistic: options?.optimistic,
        }),
      ),
    [executeMutation, figbird, serviceName],
  )
  const patch = useCallback(
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    (id: string | number, data: any, options?: MutationCallOptions) =>
      executeMutation(
        figbird.mutate({
          serviceName,
          method: 'patch' as const,
          id,
          data,
          params: options?.params,
          optimistic: options?.optimistic,
        }),
      ),
    [executeMutation, figbird, serviceName],
  )
  const remove = useCallback(
    (id: string | number, options?: MutationCallOptions) =>
      executeMutation(
        figbird.mutate({
          serviceName,
          method: 'remove' as const,
          id,
          params: options?.params,
          optimistic: Boolean(options?.optimistic),
        }),
      ),
    [executeMutation, figbird, serviceName],
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
