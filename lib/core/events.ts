import type { EventType } from './queryTypes.js'

/**
 * Mutation method names (subset usable in observability events).
 */
export type MutationMethod = 'create' | 'update' | 'patch' | 'remove'

/**
 * Method name carried on `mutate:*` events — one of the CRUD methods, or a custom
 * service method name (custom methods flow through the same lifecycle events so
 * devtools and `useMutating` see them). `(string & {})` keeps CRUD autocomplete.
 */
// oxlint-disable-next-line @typescript-eslint/no-empty-object-type
export type MutationEventMethod = MutationMethod | (string & {})

/**
 * Observability events emitted by a Figbird instance — the same signal a dev tool
 * panel or trace logger would want to subscribe to.
 *
 * Events are intentionally lightweight (ids, durations, no payload diffs) so that
 * subscribing is cheap even with many concurrent queries.
 */
export type FigbirdEvent =
  | {
      kind: 'fetch:start'
      serviceName: string
      method: 'find' | 'get'
      queryId: string
      resourceId?: string | number
      params?: unknown
    }
  | {
      kind: 'fetch:end'
      serviceName: string
      method: 'find' | 'get'
      queryId: string
      durationMs: number
      itemCount: number
    }
  | {
      kind: 'fetch:error'
      serviceName: string
      method: 'find' | 'get'
      queryId: string
      durationMs: number
      error: Error
    }
  | {
      kind: 'realtime'
      serviceName: string
      type: EventType
      itemId: string | number | undefined
    }
  | {
      kind: 'mutate:start'
      /** Correlates the start/end/error/rollback events of one mutation. */
      mutationId: number
      serviceName: string
      method: MutationEventMethod
      id?: string | number
      optimistic: boolean
    }
  | {
      kind: 'mutate:end'
      mutationId: number
      serviceName: string
      method: MutationEventMethod
      durationMs: number
      id?: string | number
      optimistic: boolean
    }
  | {
      kind: 'mutate:error'
      mutationId: number
      serviceName: string
      method: MutationEventMethod
      durationMs: number
      error: Error
      id?: string | number
      optimistic: boolean
    }
  | {
      kind: 'mutate:rollback'
      mutationId: number
      serviceName: string
      method: MutationEventMethod
      id?: string | number
    }
  | {
      kind: 'action:start'
      /** Correlates one invocation's start/end/error. */
      actionId: number
      /** The label passed to `useAction(name, fn)` — absent for unnamed actions. */
      name?: string
    }
  | {
      kind: 'action:end'
      actionId: number
      name?: string
      durationMs: number
    }
  | {
      kind: 'action:error'
      actionId: number
      name?: string
      durationMs: number
      /** The captured failure — also available on the hook's `error` slot. */
      error: Error
    }

/**
 * Public surface for subscribing to Figbird's observability events.
 */
export interface FigbirdEvents {
  subscribe(listener: (event: FigbirdEvent) => void): () => void
}

export class FigbirdEventEmitter implements FigbirdEvents {
  #listeners: Set<(event: FigbirdEvent) => void> = new Set()
  #queue: FigbirdEvent[] = []
  #flushScheduled = false

  /**
   * Emission is deferred to a microtask (batched, order-preserving). Some emits
   * happen synchronously inside a React render (subscribing to a query can start a
   * fetch during render) — delivering to listeners at that moment forces every
   * React-bound subscriber to defer manually or hit "setState during render".
   * Event payloads capture their facts (timestamps, durations) at emit time, so
   * deferred delivery distorts nothing.
   */
  emit(event: FigbirdEvent): void {
    if (this.#listeners.size === 0) return
    this.#queue.push(event)
    if (this.#flushScheduled) return
    this.#flushScheduled = true
    queueMicrotask(() => {
      this.#flushScheduled = false
      const events = this.#queue
      this.#queue = []
      for (const event of events) {
        for (const fn of this.#listeners) {
          try {
            fn(event)
          } catch {
            // Listener errors must never break the store loop.
          }
        }
      }
    })
  }

  subscribe(listener: (event: FigbirdEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
}
