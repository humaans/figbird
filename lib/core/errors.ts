type ItemId = string | number

/** A fetched item was removed by realtime while a consumer was viewing it. */
export class ItemRemovedError extends Error {
  readonly itemId: ItemId

  constructor(itemId: ItemId) {
    super(`Item ${String(itemId)} has been removed`)
    this.name = 'ItemRemovedError'
    this.itemId = itemId
  }
}

/** Identify an ItemRemovedError without relying on one package instance or realm. */
export function isItemRemovedError(error: unknown): error is ItemRemovedError {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { name?: unknown; message?: unknown; itemId?: unknown }
  return (
    candidate.name === 'ItemRemovedError' &&
    typeof candidate.message === 'string' &&
    (typeof candidate.itemId === 'string' || typeof candidate.itemId === 'number')
  )
}
