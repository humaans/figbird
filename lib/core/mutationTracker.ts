/**
 * Synchronous registry of active mutations, including scheduled queue work.
 *
 * This deliberately does NOT ride on the observability events channel: event
 * delivery is deferred to a microtask and events never replay, so a subscriber
 * that attaches while a mutation is already in flight would miss its start and
 * report a false negative. The tracker is updated synchronously at the mutate
 * call sites instead, which makes `getSnapshot()` correct at any moment — the
 * property `useMutating` (via `useSyncExternalStore`) depends on.
 */

/** One active mutation, as visible through `figbird.mutating`. */
export interface InFlightMutation {
  /** Monotonic per-instance id, also stamped on the `mutate:*` events. */
  readonly mutationId: number
  /** Resolved service path (schema aliases already applied). */
  readonly serviceName: string
  /** `create` | `update` | `patch` | `remove`, or a custom method name. */
  readonly method: string
  /**
   * Target id when known. `create` without a client-generated id and custom
   * methods (whose args are positional and opaque) have no id.
   */
  readonly id?: string | number
}

/**
 * Read-only view of the tracker — what `figbird.mutating` exposes. `start`/`end`
 * are internal to the store.
 */
export interface MutationActivity {
  /** Notifies synchronously whenever the active set changes. */
  subscribe(listener: () => void): () => void
  /** Referentially stable between changes — safe for `useSyncExternalStore`. */
  getSnapshot(): readonly InFlightMutation[]
}

export class MutationTracker implements MutationActivity {
  #inFlight: Map<number, InFlightMutation> = new Map()
  #listeners: Set<() => void> = new Set()
  #nextId = 1
  #snapshot: readonly InFlightMutation[] = []

  /** Pending writes can still settle; external owners no longer receive updates. */
  dispose(): void {
    this.#listeners.clear()
  }

  start(entry: { serviceName: string; method: string; id?: string | number }): number {
    const mutationId = this.#nextId++
    this.#inFlight.set(mutationId, { mutationId, ...entry })
    this.#changed()
    return mutationId
  }

  end(mutationId: number): void {
    if (this.#inFlight.delete(mutationId)) {
      this.#changed()
    }
  }

  getSnapshot(): readonly InFlightMutation[] {
    return this.#snapshot
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #changed(): void {
    this.#snapshot = Array.from(this.#inFlight.values())
    for (const fn of this.#listeners) {
      try {
        fn()
      } catch {
        // Listener errors must never break the mutation path.
      }
    }
  }
}
