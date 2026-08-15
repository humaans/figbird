import type { EventType, TraceCause } from './queryTypes.js'
export type { TraceCause } from './queryTypes.js'

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

export type FetchReason = 'subscription' | 'manual' | 'reconcile' | 'retry' | 'follow-up'

export interface CacheQueryEffect {
  queryId: string
  outcome: 'merged' | 'reconcile'
}

/**
 * Observability events emitted by a Figbird instance — the same signal a dev tool
 * panel or trace logger would want to subscribe to.
 *
 * Events are intentionally bounded by consumers. Realtime events and mutation/action
 * starts carry their original payloads so an attached devtool can inspect what
 * happened. Cache transitions may include before/after values for attached devtools,
 * and emit() drops everything when nothing is listening.
 */
export type FigbirdEvent =
  | {
      kind: 'fetch:start'
      serviceName: string
      method: 'find' | 'get'
      queryId: string
      generation: number
      fetchId?: number
      reason?: FetchReason
      attempt?: number
      causes?: readonly TraceCause[]
      resourceId?: string | number
      params?: unknown
    }
  | {
      kind: 'fetch:end'
      serviceName: string
      method: 'find' | 'get'
      queryId: string
      generation: number
      fetchId?: number
      durationMs: number
      itemCount: number
    }
  | {
      kind: 'fetch:error'
      serviceName: string
      method: 'find' | 'get'
      queryId: string
      generation: number
      fetchId?: number
      durationMs: number
      error: Error
    }
  | {
      kind: 'reconcile:started'
      queryId: string
      serviceName: string
      causes?: readonly TraceCause[]
    }
  | {
      kind: 'reconcile:decision'
      queryId: string
      serviceName: string
      decision: 'fetch-now' | 'coalesced' | 'deferred-hidden' | 'inactive'
      causes?: readonly TraceCause[]
    }
  | {
      kind: 'reconnect:sweep'
      traceId?: number
      phase: 'scheduled' | 'started'
      delayMs: number
      queryCount?: number
    }
  | {
      kind: 'realtime'
      traceId?: number
      serviceName: string
      type: EventType
      itemId: string | number | undefined
      item?: unknown
    }
  | {
      kind: 'cache:updated'
      traceId?: number
      source: 'realtime' | 'mutation' | 'fetch' | 'optimistic' | 'devtools'
      serviceName: string
      type: EventType
      itemId: string | number
      item: unknown
      previousItem: unknown | null
      queryEffects: readonly CacheQueryEffect[]
    }
  | {
      kind: 'connection:connected'
      traceId?: number
      transport?: string
      connectionId?: string
    }
  | {
      kind: 'connection:disconnected'
      traceId?: number
      reason?: string
      reconnecting: boolean
    }
  | {
      kind: 'connection:reconnected'
      traceId?: number
      attempt?: number
      transport?: string
      connectionId?: string
    }
  | {
      kind: 'connection:error'
      traceId?: number
      phase: 'connect' | 'reconnect'
      error: Error
    }
  | { kind: 'connection:reconnect-failed'; traceId?: number; error?: Error }
  | {
      kind: 'mutate:start'
      /** Correlates the start/end/error/rollback events of one mutation. */
      mutationId: number
      traceId?: number
      serviceName: string
      method: MutationEventMethod
      id?: string | number
      optimistic: boolean
      args?: readonly unknown[]
    }
  | {
      /** An unsent queued mutation was coalesced with newer arguments. */
      kind: 'mutate:update'
      mutationId: number
      traceId?: number
      serviceName: string
      method: MutationEventMethod
      id?: string | number
      optimistic: boolean
      args: readonly unknown[]
    }
  | {
      kind: 'mutate:end'
      mutationId: number
      traceId?: number
      serviceName: string
      method: MutationEventMethod
      durationMs: number
      id?: string | number
      optimistic: boolean
    }
  | {
      kind: 'mutate:error'
      mutationId: number
      traceId?: number
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
      traceId?: number
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
      args?: readonly unknown[]
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
  #queue: Array<{
    event: FigbirdEvent
    recipients: Array<(event: FigbirdEvent) => void>
  }> = []
  #flushScheduled = false

  /**
   * Emission is deferred to a microtask (batched, order-preserving). Some emits
   * happen synchronously inside a React render (subscribing to a query can start a
   * fetch during render) — delivering to listeners at that moment forces every
   * React-bound subscriber to defer manually or hit "setState during render".
   * Event payloads capture their facts (timestamps, durations) at emit time, so
   * deferred delivery distorts nothing. Recipients are also captured at emit time:
   * subscribing before the microtask flush must not replay already-emitted events.
   */
  emit(event: FigbirdEvent): void {
    if (this.#listeners.size === 0) return
    this.#queue.push({ event, recipients: [...this.#listeners] })
    if (this.#flushScheduled) return
    this.#flushScheduled = true
    queueMicrotask(() => {
      this.#flushScheduled = false
      const events = this.#queue
      this.#queue = []
      for (const { event: queuedEvent, recipients } of events) {
        for (const fn of recipients) {
          if (!this.#listeners.has(fn)) continue
          try {
            fn(queuedEvent)
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
