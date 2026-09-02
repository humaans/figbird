const MAX_TIMER_DELAY = 2_147_483_647

export function validateStaleTime(value: unknown, context: string): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
    throw new RangeError(
      `${context} must be a non-negative number or Infinity, got ${String(value)}`,
    )
  }
  return value
}

export function validatePrefetchStaleTime(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_TIMER_DELAY
  ) {
    throw new RangeError(
      `prefetch(): staleTime must be between 0 and ${MAX_TIMER_DELAY}, got ${String(value)}`,
    )
  }
  return value
}
