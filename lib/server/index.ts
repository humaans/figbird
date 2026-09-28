/**
 * figbird/server — the experimental Feathers companion for figbird's sync
 * protocol. See DESIGN.md "Sync Protocol (experimental)".
 *
 * No runtime dependency on Feathers: the hooks and the sync service are typed
 * structurally against the parts of Feathers they use.
 */
export { hybridClock } from './sequencer.js'
export type { HybridClockOptions, Sequencer } from './sequencer.js'
export { memoryChangeLog } from './changeLog.js'
export type { ChangeEntry, ChangeLog, MemoryChangeLogOptions } from './changeLog.js'
export { CHANGE_TYPES, SYNC_CHANGE_TYPES } from './protocol.js'
export type { ChangeType, SyncChange, SyncChangeType, SyncResult } from './protocol.js'
export { versioned } from './versioned.js'
export type { VersionedHook, VersionedHookContext, VersionedOptions } from './versioned.js'
export { figbirdSync, SyncTruncatedError } from './sync.js'
export type { FigbirdSyncOptions, SyncParams } from './sync.js'
export type { ServiceOrdering } from '../core/sort.js'
