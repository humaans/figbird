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

export interface UseMutationResult<T, TMethods = Record<string, never>> {
  // Overloaded create method for better type inference
  create(data: Partial<T>, params?: unknown): Promise<T>
  create(data: Partial<T>[], params?: unknown): Promise<T[]>
  create(data: Partial<T> | Partial<T>[], params?: unknown): Promise<T | T[]>
  update: (id: string | number, data: Partial<T>, params?: unknown) => Promise<T>
  patch: (id: string | number, data: Partial<T>, params?: unknown) => Promise<T>
  remove: (id: string | number, params?: unknown) => Promise<T>
  data: T | T[] | null
  status: 'idle' | 'loading' | 'success' | 'error'
  error: Error | null
  // Custom methods
  mutate: (method: string, ...args: unknown[]) => Promise<unknown>
  // Typed custom methods (when schema is available)
  methods: TMethods
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useMutation<T = any, TMethods = Record<string, never>>(
  serviceName: string,
): UseMutationResult<T, TMethods> {
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

  const mutate = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (method: MutationMethod | string, ...args: unknown[]): Promise<any> => {
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

  // Create typed methods proxy for custom service methods
  const methods = useMemo(() => {
    if (!service || !service._phantom?.methods) {
      return {} as TMethods
    }

    const methodsProxy: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
    // This is just for typing, actual methods are called via mutate
    for (const methodName in service._phantom.methods) {
      methodsProxy[methodName] = (...args: unknown[]) => mutate(methodName, ...args)
    }
    return methodsProxy as TMethods
  }, [service, mutate])

  return useMemo(
    () => ({
      create,
      update,
      patch,
      remove,
      data: state.data,
      status: state.status,
      error: state.error,
      mutate,
      methods,
    }),
    [create, update, patch, remove, state, mutate, methods],
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
