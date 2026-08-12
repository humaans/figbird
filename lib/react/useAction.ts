import { startTransition, useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { FigbirdEventEmitter, type FigbirdEvent } from '../core/events.js'
import type { FigbirdEvents } from '../core/figbird.js'
import { useFigbirdMaybe } from './context.js'

/**
 * Result of `useAction` — per-action UI lifecycle state around any async function.
 */
export interface UseActionResult<TArgs extends unknown[], TResult> {
  /**
   * Invoke the action. Never rejects — failures are captured into `error`.
   * Per-invocation consequences (navigate after delete, per-call recovery)
   * belong inside the action body, not after `run()`.
   */
  run: (...args: TArgs) => Promise<void>
  /** True while any invocation is in flight (a counter, not a flag). */
  pending: boolean
  /** Last settled failure; cleared when a new run starts. */
  error: Error | null
  /** Last successful result; cleared when a new run starts. */
  data: TResult | null
  /** Clear `error` and `data` back to idle. Does not cancel in-flight runs. */
  reset: () => void
}

/**
 * Call signatures for `useAction` — with or without a devtools label. Both the
 * root export and the `createHooks` kit version share this shape.
 */
export interface UseActionHook {
  <TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => Promise<TResult> | TResult,
  ): UseActionResult<TArgs, TResult>
  <TArgs extends unknown[], TResult>(
    name: string,
    fn: (...args: TArgs) => Promise<TResult> | TResult,
  ): UseActionResult<TArgs, TResult>
}

interface ActionState<TResult> {
  pendingCount: number
  error: Error | null
  data: TResult | null
}

type ActionEvent<TResult> =
  | { type: 'start' }
  | { type: 'success'; payload: TResult }
  | { type: 'failure'; payload: Error }
  | { type: 'reset' }

function actionReducer<TResult>(
  state: ActionState<TResult>,
  event: ActionEvent<TResult>,
): ActionState<TResult> {
  switch (event.type) {
    case 'start':
      // A new run wipes the previous outcome — a retry clears the stale error
      // immediately instead of showing it next to a fresh spinner.
      return { pendingCount: state.pendingCount + 1, error: null, data: null }
    case 'success':
      return { pendingCount: state.pendingCount - 1, error: null, data: event.payload }
    case 'failure':
      // Overlapping runs: last settled outcome wins the slot.
      return { pendingCount: state.pendingCount - 1, error: event.payload, data: null }
    case 'reset':
      return { pendingCount: state.pendingCount, error: null, data: null }
  }
}

/** The observability slice of a Figbird instance the hook can report into. @internal */
export interface ActionEventsHost {
  events: FigbirdEvents
}

// Correlates one invocation's action:start/end/error events.
let nextActionId = 1

// Derived from the core event union so the payloads can't drift from what
// devtools subscribers expect.
type ActionFigbirdEvent = Extract<FigbirdEvent, { actionId: number }>
type EmitFn = (event: ActionFigbirdEvent) => void

// The public `FigbirdEvents` surface is subscribe-only; emitting is the concrete
// emitter's affair. A Figbird instance always carries one — the instanceof check
// covers hand-rolled hosts (tests) that only implement subscribe.
function emitterOf(figbird: ActionEventsHost | undefined | null): EmitFn | null {
  const events = figbird?.events
  return events instanceof FigbirdEventEmitter ? event => events.emit(event) : null
}

/**
 * Per-action UI lifecycle around any async function — the write-side companion
 * to Suspense reads. Each hook call site is its own action with its own
 * `pending`/`error`, so a screen with six buttons declares six actions instead
 * of multiplexing one shared status slot.
 *
 * ```tsx
 * function Toolbar({ issue }: { issue: Issue }) {
 *   const close = useAction('close', () => m.issues.patch(issue.id, { status: 'closed' }))
 *   return (
 *     <button onClick={close.run} disabled={close.pending}>
 *       {close.pending ? 'Closing…' : 'Close'}
 *     </button>
 *   )
 * }
 * ```
 *
 * Semantics:
 * - `pending` counts overlapping runs — it stays true until the last settles.
 * - `error`/`data` are slots: last settled outcome, cleared when a new run starts.
 * - `run()` never rejects. Sequencing and per-invocation error handling live
 *   inside the action body (`async () => { await m.issues.remove(id); navigate('/') }`)
 *   — the body is plain async JS, so `try`/`catch` and return values work natively
 *   there. Awaiting `run()` and then acting is a bug: it resolves on failure too.
 * - The body runs as a React Action (async transition), so a navigation or query
 *   change it triggers keeps the previous UI on screen instead of flashing a
 *   Suspense fallback — writes compose with the read side's transition story.
 *   Corollary: urgent synchronous UI (closing an editor, clearing an input)
 *   belongs *before* `run()`, not inside the body.
 * - The function is captured fresh every render, so it can close over current
 *   props/state — no deps array.
 * - The optional `name` labels `action:start/end/error` observability events so
 *   devtools speak the app's vocabulary ("reassign · 340ms"), not just the data
 *   layer's. Events are emitted through the context instance when one exists.
 *
 * One identity, one call site: hoisting a single `useAction` over N list rows
 * re-creates the shared-slot problem ("which row is pending?"). Give each row
 * component its own action. For "is anything mutating this entity" — the
 * cross-cutting question — use `useMutating` instead.
 */
export const useAction: UseActionHook = <TArgs extends unknown[], TResult>(
  fnOrName: string | ((...args: TArgs) => Promise<TResult> | TResult),
  maybeFn?: (...args: TArgs) => Promise<TResult> | TResult,
): UseActionResult<TArgs, TResult> => {
  return useActionImpl(useFigbirdMaybe(), fnOrName, maybeFn)
}

/**
 * Instance-taking implementation behind the context-aware root export. @internal
 */
export function useActionImpl<TArgs extends unknown[], TResult>(
  figbird: ActionEventsHost | undefined | null,
  fnOrName: string | ((...args: TArgs) => Promise<TResult> | TResult),
  maybeFn?: (...args: TArgs) => Promise<TResult> | TResult,
): UseActionResult<TArgs, TResult> {
  const name = typeof fnOrName === 'string' ? fnOrName : undefined
  const fn = typeof fnOrName === 'string' ? maybeFn! : fnOrName

  const [state, dispatch] = useReducer(actionReducer<TResult>, {
    pendingCount: 0,
    error: null,
    data: null,
  })

  // Latest-closure refs: run() always sees the current render's fn/name/emitter
  // without being re-created, so it is referentially stable for the lifetime of
  // the component.
  const fnRef = useRef(fn)
  fnRef.current = fn
  const nameRef = useRef(name)
  nameRef.current = name
  const emitRef = useRef<EmitFn | null>(null)
  emitRef.current = emitterOf(figbird)

  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const run = useCallback((...args: TArgs): Promise<void> => {
    // Urgent, outside the transition: the pending flip (button label swap)
    // should paint immediately, not at transition priority.
    dispatch({ type: 'start' })
    const actionId = nextActionId++
    const startedAt = Date.now()
    const label = nameRef.current !== undefined ? { name: nameRef.current } : {}
    emitRef.current?.({ kind: 'action:start', actionId, ...label, args })
    return new Promise<void>(resolve => {
      // The body runs as a React Action (async transition): state updates it
      // causes downstream — suspense-triggering navigations, query re-reads —
      // keep the previous UI committed instead of flashing fallbacks. The
      // try/catch means no error ever escapes into React's action error path.
      // (On React 18, updates after the first await degrade to urgent updates —
      // a graceful downgrade, not a break.)
      startTransition(async () => {
        try {
          const result = await fnRef.current(...args)
          if (mountedRef.current) {
            dispatch({ type: 'success', payload: result })
          }
          emitRef.current?.({
            kind: 'action:end',
            actionId,
            ...label,
            durationMs: Date.now() - startedAt,
          })
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err))
          if (mountedRef.current) {
            dispatch({ type: 'failure', payload: error })
          }
          emitRef.current?.({
            kind: 'action:error',
            actionId,
            ...label,
            durationMs: Date.now() - startedAt,
            error,
          })
        }
        resolve()
      })
    })
  }, [])

  const reset = useCallback(() => {
    dispatch({ type: 'reset' })
  }, [])

  return useMemo(
    () => ({
      run,
      pending: state.pendingCount > 0,
      error: state.error,
      data: state.data,
      reset,
    }),
    [run, reset, state],
  )
}
