import type { CacheQueryEffect, TraceCause } from '../core/events.js'

export interface TimelineTraceSummary {
  traceId: number
  queryIds: string[]
  mergedQueries: number
  reconciledQueries: number
  cacheUpdated: boolean
  fetches: number
  sweptQueries?: number
}

/** Timeline-owned causal facts that remain valid when the raw event log is cleared. */
export class TimelineTraceStore {
  #traces = new Map<number, TimelineTraceSummary>()
  #outcomes = new Map<number, Map<string, CacheQueryEffect['outcome']>>()

  recordFetch(causes: readonly TraceCause[] | undefined): void {
    for (const cause of causes ?? []) {
      this.#update(cause.traceId, trace => {
        trace.fetches++
      })
    }
  }

  recordCacheUpdate(traceId: number, effects: readonly CacheQueryEffect[]): void {
    this.#update(traceId, trace => {
      trace.cacheUpdated = true
      const outcomes = this.#outcomes.get(traceId) ?? new Map()
      for (const effect of effects) outcomes.set(effect.queryId, effect.outcome)
      this.#outcomes.set(traceId, outcomes)
      trace.queryIds = [...outcomes.keys()]
      trace.mergedQueries = countOutcome(outcomes, 'merged')
      trace.reconciledQueries = countOutcome(outcomes, 'reconcile')
    })
  }

  recordSweep(traceId: number, queryCount: number | undefined): void {
    if (queryCount === undefined) return
    this.#update(traceId, trace => {
      trace.sweptQueries = queryCount
    })
  }

  snapshot(): TimelineTraceSummary[] {
    return [...this.#traces.values()].map(trace => ({ ...trace, queryIds: [...trace.queryIds] }))
  }

  retainOnly(traceIds: ReadonlySet<number>): void {
    for (const traceId of this.#traces.keys()) {
      if (traceIds.has(traceId)) continue
      this.#traces.delete(traceId)
      this.#outcomes.delete(traceId)
    }
  }

  clear(): void {
    this.#traces.clear()
    this.#outcomes.clear()
  }

  #update(traceId: number, update: (trace: TimelineTraceSummary) => void): void {
    const trace = this.#traces.get(traceId) ?? emptyTrace(traceId)
    update(trace)
    this.#traces.set(traceId, trace)
  }
}

function emptyTrace(traceId: number): TimelineTraceSummary {
  return {
    traceId,
    queryIds: [],
    mergedQueries: 0,
    reconciledQueries: 0,
    cacheUpdated: false,
    fetches: 0,
  }
}

function countOutcome(
  outcomes: ReadonlyMap<string, CacheQueryEffect['outcome']>,
  expected: CacheQueryEffect['outcome'],
): number {
  let count = 0
  for (const outcome of outcomes.values()) {
    if (outcome === expected) count++
  }
  return count
}
