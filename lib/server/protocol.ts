/**
 * The wire contract shared by `figbird/server` and the client's sync support.
 * See DESIGN.md "Sync Protocol (experimental)".
 */

export const CHANGE_TYPES = ['created', 'updated', 'patched', 'removed'] as const

export type ChangeType = (typeof CHANGE_TYPES)[number]

/**
 * A change as replayed: a logged change type, or `invalidated` for a changed row
 * the read-back didn't return — the caller may not read it, or it falls outside
 * the service's default scope. The client reconciles instead of deleting.
 */
export const SYNC_CHANGE_TYPES = [...CHANGE_TYPES, 'invalidated'] as const

export type SyncChangeType = (typeof SYNC_CHANGE_TYPES)[number]

export interface SyncChange {
  service: string
  type: SyncChangeType
  id: string | number
  /**
   * The current row; `{ [idField]: id, [field]: seq }` for a removal;
   * `{ [idField]: id }` for an invalidation.
   */
  item: Record<string, unknown>
}

export interface SyncResult {
  /** Resume position: pass it back as `since` once these changes are applied. */
  cursor: number
  /**
   * The requested services this answer covers. A client listening to any other
   * service has missed its events and must refetch.
   */
  services: string[]
  changes: SyncChange[]
}
