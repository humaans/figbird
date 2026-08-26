import { useCallback, useSyncExternalStore } from 'react'
import type { MutationActivity } from '../core/figbird.js'
import { resolveServicePath, type Schema } from '../core/schema.js'
import { useFigbird } from './context.js'

/**
 * Filter for `useMutating`. All given fields must match; omit a field to not
 * filter on it. Omit the whole filter to ask "is anything mutating at all".
 */
export interface UseMutatingFilter {
  /** Figbird service name. Schemaless instances use transport paths as their names. */
  service?: string
  /**
   * Target entity id. Note: `create` calls without a client-generated id and
   * custom method calls carry no id, so they never match an id filter.
   */
  id?: string | number
  /** `create` | `update` | `patch` | `remove`, or a custom method name. */
  method?: string
}

/** The slice of a Figbird instance the hook needs. @internal */
export interface MutatingHost {
  schema: Schema | undefined
  mutating: MutationActivity
}

/**
 * True while any active mutation matches the filter, including scheduled queue
 * work — the cross-cutting
 * counterpart to `useAction`'s per-call-site state. Backed by the core's
 * synchronous mutation tracker, so it is correct even when the component mounts
 * while a mutation is already in flight, and it sees mutations fired from
 * anywhere: other components, route actions, non-React code.
 *
 * ```tsx
 * // Serialize writes to one entity: disable the whole toolbar while ANY
 * // mutation (from any screen) touches this issue.
 * const busy = useMutating({ service: 'issues', id: issue.id })
 * ```
 */
export function useMutating(filter?: UseMutatingFilter): boolean {
  return useMutatingImpl(useFigbird(), filter)
}

/**
 * Instance-taking implementation behind the context-bound `useMutating`. @internal
 */
export function useMutatingImpl(figbird: MutatingHost, filter: UseMutatingFilter = {}): boolean {
  // Tracker entries carry resolved service paths — resolve the filter the same way
  // so `{ service: 'people' }` matches mutations on `'api/people'`.
  const service =
    filter.service !== undefined ? resolveServicePath(figbird.schema, filter.service) : undefined
  const { id, method } = filter
  const { mutating } = figbird

  const subscribe = useCallback((onChange: () => void) => mutating.subscribe(onChange), [mutating])

  // Returns a primitive, so useSyncExternalStore's referential-stability
  // requirement is trivially met.
  const getSnapshot = useCallback((): boolean => {
    return mutating
      .getSnapshot()
      .some(
        m =>
          (service === undefined || m.serviceName === service) &&
          (id === undefined || m.id === id) &&
          (method === undefined || m.method === method),
      )
  }, [mutating, service, id, method])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
