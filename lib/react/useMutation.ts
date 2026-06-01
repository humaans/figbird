import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
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

// Public untyped mutation hook intentionally returns `any` for backwards compatibility.
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
type UntypedData = any

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
export function useMutation(
  serviceName: string,
): UseMutationResult<UntypedData, UntypedData, UntypedData, UntypedData> {
  const figbird = useFigbird()

  const [state, dispatch] = useReducer(mutationReducer<UntypedData | UntypedData[]>, {
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
    async <TResult>(promise: Promise<TResult>): Promise<TResult> => {
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
    (data: UntypedData | UntypedData[], params?: unknown) =>
      executeMutation(
        figbird.mutate({
          serviceName,
          method: 'create' as const,
          data,
          params,
        }) as Promise<UntypedData | UntypedData[]>,
      ),
    [executeMutation, figbird, serviceName],
  ) as UseMutationResult<UntypedData, UntypedData, UntypedData, UntypedData>['create']
  const update = useCallback(
    (id: string | number, data: UntypedData, params?: unknown) =>
      executeMutation(
        figbird.mutate({
          serviceName,
          method: 'update' as const,
          id,
          data,
          params,
        }) as Promise<UntypedData>,
      ),
    [executeMutation, figbird, serviceName],
  ) as UseMutationResult<UntypedData, UntypedData, UntypedData, UntypedData>['update']
  const patch = useCallback(
    (id: string | number, data: UntypedData, params?: unknown) =>
      executeMutation(
        figbird.mutate({
          serviceName,
          method: 'patch' as const,
          id,
          data,
          params,
        }) as Promise<UntypedData>,
      ),
    [executeMutation, figbird, serviceName],
  ) as UseMutationResult<UntypedData, UntypedData, UntypedData, UntypedData>['patch']
  const remove = useCallback(
    (id: string | number, params?: unknown) =>
      executeMutation(
        figbird.mutate({
          serviceName,
          method: 'remove' as const,
          id,
          params,
        }) as Promise<UntypedData>,
      ),
    [executeMutation, figbird, serviceName],
  ) as UseMutationResult<UntypedData, UntypedData, UntypedData, UntypedData>['remove']

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
