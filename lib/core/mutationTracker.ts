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
 * Read-only view of the tracker — what `figbird.mutating` exposes. Mutation
 * lifecycle methods are internal to the store.
 */
export interface MutationActivity {
  /** Notifies synchronously whenever the active set changes. */
  subscribe(listener: () => void): () => void
  /** Referentially stable between changes — safe for `useSyncExternalStore`. */
  getSnapshot(): readonly InFlightMutation[]
}

type MutationSyncState = 'pending' | 'retry-paused'

interface TrackedMutationEntry extends InFlightMutation {
  syncState: MutationSyncState
}

export interface MutationSyncSnapshot {
  readonly pendingWrites: number
  readonly failedWrites: number
}

type MutationSettlement = 'success' | 'failure' | 'discarded'

interface MutationSyncChange {
  successful: boolean
}

export class MutationTracker implements MutationActivity {
  #inFlight: Map<number, TrackedMutationEntry> = new Map()
  #listeners: Set<() => void> = new Set()
  #syncListeners: Set<(change: MutationSyncChange) => void> = new Set()
  #nextId = 1
  #snapshot: readonly InFlightMutation[] = []
  #syncSnapshot: MutationSyncSnapshot = { pendingWrites: 0, failedWrites: 0 }

  start(entry: { serviceName: string; method: string; id?: string | number }): number {
    const mutationId = this.#nextId++
    this.#inFlight.set(mutationId, { mutationId, ...entry, syncState: 'pending' })
    this.#changed()
    return mutationId
  }

  attemptFailed(mutationId: number): void {
    const mutation = this.#inFlight.get(mutationId)
    if (!mutation || mutation.syncState === 'retry-paused') return
    mutation.syncState = 'retry-paused'
    this.#changed({ activityChanged: false })
  }

  attemptRetrying(mutationId: number): void {
    const mutation = this.#inFlight.get(mutationId)
    if (!mutation || mutation.syncState === 'pending') return
    mutation.syncState = 'pending'
    this.#changed({ activityChanged: false })
  }

  settle(mutationId: number, outcome: MutationSettlement): void {
    if (this.#inFlight.delete(mutationId)) {
      this.#changed({ successful: outcome === 'success' })
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

  getSyncSnapshot(): MutationSyncSnapshot {
    return this.#syncSnapshot
  }

  subscribeToSync(listener: (change: MutationSyncChange) => void): () => void {
    this.#syncListeners.add(listener)
    return () => {
      this.#syncListeners.delete(listener)
    }
  }

  #changed({
    successful = false,
    activityChanged = true,
  }: { successful?: boolean; activityChanged?: boolean } = {}): void {
    const mutations = Array.from(this.#inFlight.values())
    if (activityChanged) {
      this.#snapshot = mutations.map(({ syncState: _, ...mutation }) => mutation)
    }
    this.#syncSnapshot = {
      pendingWrites: mutations.length,
      failedWrites: mutations.filter(mutation => mutation.syncState === 'retry-paused').length,
    }
    for (const listener of this.#syncListeners) listener({ successful })
    if (!activityChanged) return
    for (const fn of this.#listeners) {
      try {
        fn()
      } catch {
        // Listener errors must never break the mutation path.
      }
    }
  }
}
