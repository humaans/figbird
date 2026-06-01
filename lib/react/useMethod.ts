import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { resolveServicePath } from '../core/schema.js'
import { useFigbird } from './react.js'

export type UseMethodStatus = 'idle' | 'loading' | 'success' | 'error'

export interface UseMethodState<TResult = unknown> {
  status: UseMethodStatus
  data: TResult | null
  error: Error | null
  reset: () => void
}

interface MethodState<TResult> {
  status: UseMethodStatus
  data: TResult | null
  error: Error | null
}

type MethodAction<TResult> =
  | { type: 'calling' }
  | { type: 'success'; payload: TResult }
  | { type: 'error'; payload: Error }
  | { type: 'reset' }

export type UseMethodCall<TArgs extends unknown[] = unknown[], TResult = unknown> = (
  ...args: TArgs
) => Promise<TResult>

export type UseMethodResult<TArgs extends unknown[] = unknown[], TResult = unknown> = readonly [
  UseMethodCall<TArgs, TResult>,
  UseMethodState<TResult>,
]

const initialMethodState = {
  status: 'idle',
  data: null,
  error: null,
} satisfies MethodState<unknown>

/**
 * Calls an arbitrary service method and tracks local UI lifecycle state.
 * This does not apply CRUD cache updates. For typed custom methods, prefer
 * the `useMethod` returned by `createHooks(figbird)`.
 */
export function useMethod<TArgs extends unknown[] = unknown[], TResult = unknown>(
  serviceName: string,
  methodName: string,
): UseMethodResult<TArgs, TResult> {
  const figbird = useFigbird()
  const servicePath = resolveServicePath(figbird.schema, serviceName)

  const [state, dispatch] = useReducer(methodReducer<TResult>, initialMethodState)

  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const call = useCallback(
    async (...args: TArgs): Promise<TResult> => {
      dispatch({ type: 'calling' })
      try {
        const result = (await figbird.adapter.mutate(servicePath, methodName, args)) as TResult
        if (mountedRef.current) {
          dispatch({ type: 'success', payload: result })
        }
        return result
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        if (mountedRef.current) {
          dispatch({ type: 'error', payload: error })
        }
        throw error
      }
    },
    [figbird.adapter, methodName, servicePath],
  )

  const reset = useCallback(() => {
    dispatch({ type: 'reset' })
  }, [])

  return useMemo(
    () =>
      [
        call,
        {
          status: state.status,
          data: state.data,
          error: state.error,
          reset,
        },
      ] as const,
    [call, reset, state],
  )
}

function methodReducer<TResult>(
  state: MethodState<TResult>,
  action: MethodAction<TResult>,
): MethodState<TResult> {
  switch (action.type) {
    case 'calling':
      return { ...state, status: 'loading', data: null, error: null }
    case 'success':
      return { ...state, status: 'success', data: action.payload, error: null }
    case 'error':
      return { ...state, status: 'error', data: null, error: action.payload }
    case 'reset':
      return { status: 'idle', data: null, error: null }
    default:
      return state
  }
}
