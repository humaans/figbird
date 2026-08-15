import type { AdapterConnectionState } from '../adapters/adapter.js'
import type { MutationTracker } from './mutationTracker.js'

export type SyncPhase = 'restoring' | 'offline' | 'syncing' | 'synced' | 'error'

/** Canonical, instance-wide view of Figbird's progress toward server truth. */
export interface SyncStatus {
  readonly phase: SyncPhase
  /** Writes that have not settled, including scheduled and paused queue work. */
  readonly pendingWrites: number
  /** Pending queue writes whose latest attempt failed and can be retried or discarded. */
  readonly failedWrites: number
  /** Distinct queries currently fetching or waiting to retry. */
  readonly fetchingQueries: number
  /** Event/reconnect reconciliations that are fetching, gated, or deferred. */
  readonly pendingReconciliations: number
  /** Epoch milliseconds of the last fully successful settle, or null before the first one. */
  readonly lastSyncedAt: number | null
}

/** Read-only external-store surface exposed as `figbird.sync`. */
export interface SyncActivity {
  subscribe(listener: () => void): () => void
  getSnapshot(): SyncStatus
}

/** Synchronously maintained by QueryStore; events are deliberately not involved. */
export class SyncTracker implements SyncActivity {
  #mutations: MutationTracker
  #connection: AdapterConnectionState
  #fetchCounts = new Map<string, number>()
  #failedReconciliations = new Set<string>()
  #reconciliations = new Set<string>()
  #listeners = new Set<() => void>()
  #snapshot: SyncStatus

  constructor(mutations: MutationTracker, connection: AdapterConnectionState) {
    this.#mutations = mutations
    this.#connection = connection
    this.#snapshot = this.#createSnapshot(null)
    this.#mutations.subscribeToSync(change => this.#changed(change))
  }

  getSnapshot = (): SyncStatus => this.#snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  connectionChanged(connection: AdapterConnectionState): void {
    if (connection === this.#connection) return
    this.#connection = connection
    this.#changed()
  }

  queryStarted(queryId: string): void {
    this.#fetchCounts.set(queryId, (this.#fetchCounts.get(queryId) ?? 0) + 1)
    if (this.#failedReconciliations.delete(queryId)) {
      this.#reconciliations.add(queryId)
    }
    this.#changed()
  }

  queryFinished(queryId: string, outcome: 'success' | 'error' | 'cancelled'): void {
    const count = this.#fetchCounts.get(queryId) ?? 0
    if (count <= 1) this.#fetchCounts.delete(queryId)
    else this.#fetchCounts.set(queryId, count - 1)
    if (outcome === 'error' && count <= 1 && this.#reconciliations.has(queryId)) {
      this.#failedReconciliations.add(queryId)
    }
    // Ordinary query fetches remain observable through fetchingQueries, but do
    // not change the interpreted, write-focused phase or lastSyncedAt.
    this.#changed()
  }

  reconciliationStarted(queryId: string): void {
    const wasFailed = this.#failedReconciliations.delete(queryId)
    if (this.#reconciliations.has(queryId)) {
      if (wasFailed) this.#changed()
      return
    }
    this.#reconciliations.add(queryId)
    this.#changed()
  }

  reconciliationFinished(queryId: string): void {
    if (!this.#reconciliations.delete(queryId)) return
    this.#changed({ successful: !this.#failedReconciliations.has(queryId) })
  }

  /** Remove every trace of a query that QueryStore is deleting. */
  forgetQuery(queryId: string): void {
    const fetched = this.#fetchCounts.delete(queryId)
    const failed = this.#failedReconciliations.delete(queryId)
    const reconciling = this.#reconciliations.delete(queryId)
    if (fetched || failed || reconciling) this.#changed()
  }

  #changed({ successful = false }: { successful?: boolean } = {}): void {
    const previous = this.#snapshot
    const canStamp = successful && this.#isFullySynced()
    const lastSyncedAt = canStamp ? Date.now() : previous.lastSyncedAt
    const next = this.#createSnapshot(lastSyncedAt)
    if (
      next.phase === previous.phase &&
      next.pendingWrites === previous.pendingWrites &&
      next.failedWrites === previous.failedWrites &&
      next.fetchingQueries === previous.fetchingQueries &&
      next.pendingReconciliations === previous.pendingReconciliations &&
      next.lastSyncedAt === previous.lastSyncedAt
    ) {
      return
    }
    this.#snapshot = next
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch {
        // Subscriber failures must never interrupt the store's lifecycle.
      }
    }
  }

  #isFullySynced(): boolean {
    const writes = this.#mutations.getSyncSnapshot()
    return (
      this.#connection === 'connected' &&
      writes.pendingWrites === 0 &&
      writes.failedWrites === 0 &&
      this.#failedReconciliations.size === 0 &&
      this.#reconciliations.size === 0
    )
  }

  #createSnapshot(lastSyncedAt: number | null): SyncStatus {
    const writes = this.#mutations.getSyncSnapshot()
    const phase: SyncPhase =
      this.#connection === 'disconnected'
        ? 'offline'
        : writes.failedWrites > 0 || this.#failedReconciliations.size > 0
          ? 'error'
          : this.#connection === 'connecting' || this.#reconciliations.size > 0
            ? 'restoring'
            : writes.pendingWrites > 0
              ? 'syncing'
              : 'synced'
    return Object.freeze({
      phase,
      pendingWrites: writes.pendingWrites,
      failedWrites: writes.failedWrites,
      fetchingQueries: this.#fetchCounts.size,
      pendingReconciliations: this.#reconciliations.size,
      lastSyncedAt,
    })
  }
}
