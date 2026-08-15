import type { AdapterConnectionState } from '../adapters/adapter.js'

export type SyncPhase = 'restoring' | 'offline' | 'syncing' | 'synced' | 'error'

/** Canonical, instance-wide view of Figbird's progress toward server truth. */
export interface SyncStatus {
  readonly phase: SyncPhase
  /** Writes that have not reached a successful terminal state, including queued work. */
  readonly pendingWrites: number
  /** Pending or terminal writes whose latest attempt failed. */
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

interface WriteIdentity {
  serviceName: string
  method: string
  id?: string | number
}

function writeKey({ serviceName, method, id }: WriteIdentity): string {
  return `${serviceName}\u0000${method}\u0000${id === undefined ? '' : String(id)}`
}

/** Synchronously maintained by QueryStore; events are deliberately not involved. */
export class SyncTracker implements SyncActivity {
  #connection: AdapterConnectionState
  #pendingWrites = new Set<number>()
  #failedWrites = new Set<number>()
  #writeKeys = new Map<number, string>()
  #ignoredTerminalFailures = new Set<number>()
  #fetchCounts = new Map<string, number>()
  #failedQueries = new Set<string>()
  #reconciliations = new Set<string>()
  #listeners = new Set<() => void>()
  #snapshot: SyncStatus

  constructor(connection: AdapterConnectionState) {
    this.#connection = connection
    this.#snapshot = this.#createSnapshot(null)
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

  writeStarted(mutationId: number, identity: WriteIdentity): void {
    const key = writeKey(identity)
    // A new call with the same logical target is the retry boundary for a
    // terminal failure. Queue retries retain their mutation id and use the
    // attempt methods below instead.
    for (const [failedId, failedKey] of this.#writeKeys) {
      if (failedKey !== key || !this.#failedWrites.has(failedId)) continue
      this.#failedWrites.delete(failedId)
      if (!this.#pendingWrites.has(failedId)) this.#writeKeys.delete(failedId)
    }
    this.#writeKeys.set(mutationId, key)
    this.#pendingWrites.add(mutationId)
    this.#failedWrites.delete(mutationId)
    this.#changed()
  }

  writeAttemptFailed(mutationId: number): void {
    if (!this.#pendingWrites.has(mutationId)) return
    this.#failedWrites.add(mutationId)
    this.#changed()
  }

  writeAttemptRetrying(mutationId: number): void {
    if (this.#failedWrites.delete(mutationId)) this.#changed()
  }

  writeSucceeded(mutationId: number): void {
    const wasPending = this.#pendingWrites.delete(mutationId)
    const wasFailed = this.#failedWrites.delete(mutationId)
    this.#writeKeys.delete(mutationId)
    this.#ignoredTerminalFailures.delete(mutationId)
    if (wasPending || wasFailed) this.#changed({ successful: true })
  }

  writeFailed(mutationId: number): void {
    this.#pendingWrites.delete(mutationId)
    if (this.#ignoredTerminalFailures.delete(mutationId)) {
      this.#failedWrites.delete(mutationId)
      this.#writeKeys.delete(mutationId)
      this.#changed()
      return
    }
    this.#failedWrites.add(mutationId)
    this.#changed()
  }

  writeDiscarded(mutationId: number): void {
    this.#ignoredTerminalFailures.add(mutationId)
    this.#pendingWrites.delete(mutationId)
    this.#failedWrites.delete(mutationId)
    this.#changed()
  }

  queryStarted(queryId: string): void {
    this.#fetchCounts.set(queryId, (this.#fetchCounts.get(queryId) ?? 0) + 1)
    this.#failedQueries.delete(queryId)
    this.#changed()
  }

  queryFinished(queryId: string, outcome: 'success' | 'error' | 'cancelled'): void {
    const count = this.#fetchCounts.get(queryId) ?? 0
    if (count <= 1) this.#fetchCounts.delete(queryId)
    else this.#fetchCounts.set(queryId, count - 1)
    if (outcome === 'error' && count <= 1) this.#failedQueries.add(queryId)
    this.#changed({ successful: outcome === 'success' })
  }

  reconciliationStarted(queryId: string): void {
    if (this.#reconciliations.has(queryId)) return
    this.#reconciliations.add(queryId)
    this.#changed()
  }

  reconciliationFinished(queryId: string): void {
    if (!this.#reconciliations.delete(queryId)) return
    this.#changed({ successful: !this.#failedQueries.has(queryId) })
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
    return (
      this.#connection === 'connected' &&
      this.#pendingWrites.size === 0 &&
      this.#failedWrites.size === 0 &&
      this.#fetchCounts.size === 0 &&
      this.#failedQueries.size === 0 &&
      this.#reconciliations.size === 0
    )
  }

  #createSnapshot(lastSyncedAt: number | null): SyncStatus {
    const phase: SyncPhase =
      this.#connection === 'disconnected'
        ? 'offline'
        : this.#failedWrites.size > 0 || this.#failedQueries.size > 0
          ? 'error'
          : this.#connection === 'connecting' || this.#reconciliations.size > 0
            ? 'restoring'
            : this.#pendingWrites.size > 0 || this.#fetchCounts.size > 0
              ? 'syncing'
              : 'synced'
    return Object.freeze({
      phase,
      pendingWrites: this.#pendingWrites.size,
      failedWrites: this.#failedWrites.size,
      fetchingQueries: this.#fetchCounts.size,
      pendingReconciliations: this.#reconciliations.size,
      lastSyncedAt,
    })
  }
}
