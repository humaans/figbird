import type { QueryRef } from './queryRef.js'

/**
 * Upper bound on source ids per relation `$in` request. Larger id sets are split
 * across several ordinary queries so REST transports stay under URL length limits.
 */
export const RELATION_CHUNK_SIZE = 100

type SourceValue = string | number

interface Chunk<TMeta extends Record<string, unknown>> {
  values: SourceValue[]
  queryRef: QueryRef<unknown[], unknown, TMeta>
  unsub: () => void
}

export interface ChunkedRelationSnapshot {
  status: 'ready' | 'loading' | 'error'
  /** Rows of every resolved chunk, in chunk order. Identity is stable while they are. */
  rows: unknown[]
  error: Error | null
  isFetching: boolean
}

/**
 * One relation hop's `$in` fetch, split into append-only chunks. A chunk's id set
 * never changes once opened: new source ids open new chunks, so growth (loadMore,
 * realtime creates, foreign-key patches) fetches only the new ids while existing
 * chunks stay live with their results and realtime maintenance. A chunk is released
 * once none of its ids are referenced; ids dropping out of a still-referenced chunk
 * simply linger until then.
 */
export class ChunkedRelationQuery<TMeta extends Record<string, unknown>> {
  #chunks: Chunk<TMeta>[] = []
  #open: (values: SourceValue[]) => QueryRef<unknown[], unknown, TMeta>
  #subscribe: (queryRef: QueryRef<unknown[], unknown, TMeta>) => () => void
  #lastParts: unknown[][] = []
  #lastRows: unknown[] = []

  constructor(
    open: (values: SourceValue[]) => QueryRef<unknown[], unknown, TMeta>,
    subscribe: (queryRef: QueryRef<unknown[], unknown, TMeta>) => () => void,
  ) {
    this.#open = open
    this.#subscribe = subscribe
  }

  sync(values: readonly SourceValue[]): void {
    const live = new Set(values)
    const kept: Chunk<TMeta>[] = []
    for (const chunk of this.#chunks) {
      if (chunk.values.some(value => live.has(value))) kept.push(chunk)
      else chunk.unsub()
    }
    const held = new Set(kept.flatMap(chunk => chunk.values))
    const added = values.filter(value => !held.has(value))
    const opened: Chunk<TMeta>[] = []
    for (let i = 0; i < added.length; i += RELATION_CHUNK_SIZE) {
      const chunkValues = added.slice(i, i + RELATION_CHUNK_SIZE)
      opened.push({ values: chunkValues, queryRef: this.#open(chunkValues), unsub: () => {} })
    }
    this.#chunks = [...kept, ...opened]
    // Subscribe once the chunk list is complete: a warm chunk reports success
    // synchronously, and its callback reads every chunk.
    for (const chunk of opened) chunk.unsub = this.#subscribe(chunk.queryRef)
  }

  snapshot(): ChunkedRelationSnapshot {
    let status: ChunkedRelationSnapshot['status'] = 'ready'
    let error: Error | null = null
    let isFetching = false
    const parts: unknown[][] = []
    for (const { queryRef } of this.#chunks) {
      const state = queryRef.getSnapshot()
      if (!state || state.status === 'loading') {
        if (status === 'ready') status = 'loading'
        isFetching = true
      } else if (state.status === 'error') {
        status = 'error'
        error ??= state.error
      } else {
        error ??= state.error
        isFetching ||= state.isFetching
        parts.push(state.data)
      }
    }
    return { status, rows: this.#rows(parts), error, isFetching }
  }

  /** Rows across every chunk, or null while any chunk has yet to produce data. */
  readyRows(): unknown[] | null {
    const snapshot = this.snapshot()
    return snapshot.status === 'ready' ? snapshot.rows : null
  }

  queryRefs(): QueryRef<unknown[], unknown, TMeta>[] {
    return this.#chunks.map(chunk => chunk.queryRef)
  }

  dispose(): void {
    for (const chunk of this.#chunks) chunk.unsub()
    this.#chunks = []
  }

  #rows(parts: unknown[][]): unknown[] {
    const unchanged =
      parts.length === this.#lastParts.length &&
      parts.every((part, index) => part === this.#lastParts[index])
    if (!unchanged) {
      this.#lastParts = parts
      // Chunks hold disjoint ids, but a frozen chunk or a server that ignores `$in`
      // can still return a shared entity twice; relation rows list it once.
      this.#lastRows = parts.length === 1 ? parts[0]! : [...new Set(parts.flat())]
    }
    return this.#lastRows
  }
}
