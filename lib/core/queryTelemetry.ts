import { FigbirdEventEmitter, type FigbirdEvent, type TraceCause } from './events.js'
import type { ProcessedCacheEvent, QueryGraphRef } from './queryTypes.js'

type TraceKind = TraceCause['kind']

const EMPTY_GRAPH = new Map<string, QueryGraphRef>()

function graphRefKey(ref: QueryGraphRef): string {
  return `${ref.operationId}\u0000${ref.runId}\u0000${ref.path}\u0000${ref.role ?? ''}`
}

/**
 * Owns the IDs and public event schema used for optional query observability.
 * Cache and query state machines ask for optional causes only at lifecycle seams;
 * when nobody is listening, no trace objects are retained by those machines.
 */
export class QueryTelemetry {
  readonly #events = new FigbirdEventEmitter()
  #nextTraceId = 1
  #nextFetchId = 1
  readonly #activeFetchGraphs = new Map<string, Map<string, QueryGraphRef>>()

  get events(): FigbirdEventEmitter {
    return this.#events
  }

  get active(): boolean {
    return this.#events.hasListeners
  }

  emit(event: FigbirdEvent): void {
    this.#events.emit(event)
  }

  nextFetchId(): number {
    return this.#nextFetchId++
  }

  nextTraceId(): number | undefined {
    return this.active ? this.#nextTraceId++ : undefined
  }

  beginGraph(
    queryId: string,
    refs: readonly QueryGraphRef[] | undefined,
  ): ReadonlyMap<string, QueryGraphRef> {
    if (!this.active) return EMPTY_GRAPH
    const graph = new Map((refs ?? []).map(ref => [graphRefKey(ref), ref]))
    this.#activeFetchGraphs.set(queryId, graph)
    return graph
  }

  attachGraph(queryId: string, ref: QueryGraphRef): void {
    this.#activeFetchGraphs.get(queryId)?.set(graphRefKey(ref), ref)
  }

  finishGraph(queryId: string, graph: ReadonlyMap<string, QueryGraphRef>): void {
    if (this.#activeFetchGraphs.get(queryId) === graph) this.#activeFetchGraphs.delete(queryId)
  }

  cause(kind: TraceKind): TraceCause | undefined {
    if (!this.active) return undefined
    const traceId = this.#nextTraceId++
    switch (kind) {
      case 'realtime':
        return { kind, traceId }
      case 'reconnect':
        return { kind, traceId }
      case 'mutation':
        return { kind, traceId }
      case 'fetch-rebase':
        return { kind, traceId }
      case 'manual':
        return { kind, traceId }
      case 'subscription':
        return { kind, traceId }
    }
  }

  mutationCause(mutationId: number): Extract<TraceCause, { kind: 'mutation' }> | undefined {
    if (!this.active) return undefined
    return { kind: 'mutation', traceId: this.#nextTraceId++, mutationId }
  }

  merge(
    current: readonly TraceCause[] | undefined,
    next: readonly TraceCause[] | undefined,
  ): TraceCause[] | undefined {
    if (!this.active) return undefined
    const keyed = new Map<number, TraceCause>()
    for (const cause of [...(current ?? []), ...(next ?? [])]) keyed.set(cause.traceId, cause)
    return keyed.size > 0 ? [...keyed.values()] : undefined
  }

  fallbackCause(event: ProcessedCacheEvent): TraceCause | undefined {
    if (event.mode === 'optimistic') return this.cause('mutation')
    if (event.mode === 'local') return this.cause('manual')
    if (event.source === 'realtime') return this.cause('realtime')
    if (event.source === 'mutation') return this.cause('mutation')
    return this.cause('fetch-rebase')
  }
}
