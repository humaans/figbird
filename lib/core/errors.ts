type ItemId = string | number

export interface ErrorDetails {
  name: string
  message: string
  [property: string]: unknown
}

/** Preserve structured server failures while keeping the public error contract. */
export function normalizeError(value: unknown): Error {
  if (value instanceof Error) return value

  const details = errorDetails(value)
  const error = new Error(details.message)
  error.name = details.name
  applyErrorDetails(error, details)
  return error
}

/** Convert an Error (including Feathers custom fields) into inspectable data. */
export function errorDetails(value: unknown): ErrorDetails {
  if (value instanceof Error) {
    const details: ErrorDetails = {
      name: value.name || 'Error',
      message: value.message || String(value),
    }
    for (const key of errorPropertyNames(value)) {
      if (key === 'name' || key === 'message' || key === 'stack') continue
      details[key] = safeErrorProperty(value, key)
    }
    return details
  }

  if (isErrorRecord(value)) {
    const name = typeof value.name === 'string' ? value.name : 'Error'
    const message =
      typeof value.message === 'string' && value.message
        ? value.message
        : typeof value.error === 'string' && value.error
          ? value.error
          : 'Request failed'
    return { ...value, name, message }
  }

  if (typeof value === 'string') return { name: 'Error', message: value }
  return { name: 'Error', message: 'Request failed', response: value }
}

/** Rebuild an Error after structured details have crossed the extension boundary. */
export function errorFromDetails(
  details: unknown,
  fallback: { name: string; message: string },
): Error {
  const normalized = isErrorRecord(details)
    ? errorDetails(details)
    : { name: fallback.name, message: fallback.message }
  const error = new Error(normalized.message)
  error.name = normalized.name
  applyErrorDetails(error, normalized)
  return error
}

function applyErrorDetails(error: Error, details: ErrorDetails): void {
  const target = error as Error & Record<string, unknown>
  for (const [key, value] of Object.entries(details)) {
    if (key === 'name' || key === 'message' || key === 'stack') continue
    try {
      target[key] = value
    } catch {
      // A custom Error subclass may expose a read-only property. Its core
      // name/message still survive even when that one field cannot be restored.
    }
  }
}

function errorPropertyNames(error: Error): string[] {
  try {
    return [...new Set([...Object.getOwnPropertyNames(error), ...Object.keys(error)])]
  } catch {
    return []
  }
}

function safeErrorProperty(error: Error, key: string): unknown {
  try {
    return (error as Error & Record<string, unknown>)[key]
  } catch (propertyError) {
    return `[Property threw: ${propertyError instanceof Error ? propertyError.message : String(propertyError)}]`
  }
}

function isErrorRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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
