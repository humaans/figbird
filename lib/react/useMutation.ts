import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { resolveServicePath, type Schema } from '../core/schema.js'
import { useFigbird } from './context.js'

// Public untyped mutation hook intentionally returns `any` for backwards compatibility.
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
type UntypedData = any

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

/**
 * Simple mutation hook exposing crud methods
 * of any feathers service. The resulting state
 * of calling these operations needs to be handled
 * by the caller. As you create/update/patch/remove
 * entities using this helper, the entities cache gets updated.
 *
 * Writes are non-optimistic and retain their legacy concurrent transport behavior:
 * the cache reflects each change once the server acks, and same-record calls are
 * not serialized. Optimistic ordered writes are a feature of the current `m` API.
 *
 * Returns untyped data. For type-safe mutations, use createHooks(schema).
 *
 * const { create, patch, remove, status, data, error } = useMutation('notes')
 *
 * @deprecated Superseded by the split write-side story: `m` is the stateless
 * write proxy (callable anywhere, not a hook), `useAction` carries per-action
 * `pending`/`error` (one hook call site per action), and `useMutating` answers
 * entity/service-level "is anything in flight". This hook conflates the two
 * roles — a service client with a single status slot — which forces hand-rolled
 * pending-state machines on any screen with more than one action. Fully
 * functional and not going away soon.
 */
export function useMutation(
  serviceName: string,
): UseMutationResult<UntypedData, UntypedData, UntypedData, UntypedData> {
  return useMutationImpl(useFigbird(), serviceName)
}

/** The slice of a Figbird instance the mutation hook needs. @internal */
interface MutatingFigbird {
  schema: Schema | undefined
  queryStore: {
    mutateConfirmedDirect(desc: UntypedData): Promise<UntypedData>
  }
}

/**
 * Instance-taking implementation behind the context-bound `useMutation`. @internal
 */
export function useMutationImpl(
  figbird: MutatingFigbird,
  serviceName: string,
): UseMutationResult<UntypedData, UntypedData, UntypedData, UntypedData> {
  const [state, dispatch] = useReducer(mutationReducer<UntypedData>, {
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
    async (promise: Promise<UntypedData>): Promise<UntypedData> => {
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

  const mutate = useCallback(
    (desc: UntypedData) =>
      figbird.queryStore.mutateConfirmedDirect({
        ...desc,
        serviceName: resolveServicePath(figbird.schema, serviceName),
      }),
    [figbird, serviceName],
  )

  const create = useCallback(
    (data: UntypedData, params?: unknown) =>
      executeMutation(mutate({ method: 'create' as const, data, params })),
    [executeMutation, mutate],
  )
  const update = useCallback(
    (id: string | number, data: UntypedData, params?: unknown) =>
      executeMutation(mutate({ method: 'update' as const, id, data, params })),
    [executeMutation, mutate],
  )
  const patch = useCallback(
    (id: string | number, data: UntypedData, params?: unknown) =>
      executeMutation(mutate({ method: 'patch' as const, id, data, params })),
    [executeMutation, mutate],
  )
  const remove = useCallback(
    (id: string | number, params?: unknown) =>
      executeMutation(mutate({ method: 'remove' as const, id, params })),
    [executeMutation, mutate],
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
