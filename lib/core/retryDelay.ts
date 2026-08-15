const MAX_RETRY_DELAY = 30_000

export function defaultRetryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), MAX_RETRY_DELAY)
}

/** Resolve an application timing hook without letting it replace the original failure. */
export function resolveRetryDelay(resolve: () => number, fallback: number): number {
  try {
    const value = resolve()
    return Number.isFinite(value) ? Math.max(0, value) : 0
  } catch {
    return fallback
  }
}
