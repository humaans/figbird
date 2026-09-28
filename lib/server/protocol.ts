/**
 * The wire contract shared by `figbird/server` and the client's sync support.
 * See DESIGN.md "Sync Protocol (experimental)".
 */

export const CHANGE_TYPES = ['created', 'updated', 'patched', 'removed'] as const

export type ChangeType = (typeof CHANGE_TYPES)[number]

export interface SyncChange {
  service: string
  type: ChangeType
  id: string | number
  /** The current row, or `{ [idField]: id, [field]: seq }` for a removal. */
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
