/** A diagnostic value that can outlive the bounded payload retention window. */
export type HistoricalValue<T = unknown> = { state: 'retained'; value: T } | { state: 'evicted' }

export const EVICTED_VALUE: HistoricalValue<never> = { state: 'evicted' }

export function retainedValue<T>(value: T): HistoricalValue<T> {
  return { state: 'retained', value }
}

export function historicalValue<T>(captured: HistoricalValue<T> | undefined): T | undefined {
  return captured?.state === 'retained' ? captured.value : undefined
}
