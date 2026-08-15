import { useSyncExternalStore } from 'react'
import type { SyncActivity, SyncStatus } from '../core/syncTracker.js'
import { useFigbird } from './context.js'

/** The slice of a Figbird instance required by `useSyncStatus`. @internal */
export interface SyncStatusHost {
  sync: SyncActivity
}

/**
 * Unified application-facing view of reads, writes, connectivity, and
 * reconciliation across the nearest Figbird instance.
 */
export function useSyncStatus(): SyncStatus {
  return useSyncStatusImpl(useFigbird())
}

/** Instance-taking implementation used by schema-bound hook kits. @internal */
export function useSyncStatusImpl(figbird: SyncStatusHost): SyncStatus {
  const { sync } = figbird
  return useSyncExternalStore(sync.subscribe, sync.getSnapshot, sync.getSnapshot)
}
