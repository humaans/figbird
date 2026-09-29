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

function isResolved(chunk: Chunk<Record<string, unknown>>): boolean {
  return chunk.queryRef.getSnapshot()?.status === 'success'
}

export interface ChunkedRelationSnapshot {
  /**
   * `loading` until every referenced id is served or its chunk has settled; `error`
   * if a failed chunk holds a referenced id no resolved chunk serves.
   */
  status: 'ready' | 'loading' | 'error'
  /** Rows of every resolved chunk, in chunk order. Identity is stable while they are. */
  rows: unknown[]
  error: Error | null
  isFetching: boolean
}

/**
 * Chunks serving fewer referenced ids than this count as sparse. Past
 * MAX_SPARSE_CHUNKS of them, a sync merges their ids into fresh full chunks.
 */
const SPARSE_CHUNK_SIZE = RELATION_CHUNK_SIZE / 2
const MAX_SPARSE_CHUNKS = 4

/**
 * One relation hop's `$in` fetch, split into append-only chunks. A chunk's id set
 * never changes once opened: new source ids open new chunks, so growth (loadMore,
 * realtime creates, foreign-key patches) fetches only the new ids while existing
 * chunks stay live with their results and realtime maintenance. Ids dropping out of
 * a still-referenced chunk linger in its rows, but `readyRows()` leaves them out.
 *
 * Growth one id at a time (a live feed of creates) would leave a query and
 * subscription per id, so once too many chunks are sparse, their ids are fetched
 * again in merged chunks. The sparse chunks keep serving until those resolve, and
 * no merge starts while any chunk is unresolved: one in flight or failed would
 * otherwise be opened again on every sync.
 * Generally, a chunk is released once every referenced id it holds is served by a
 * newer resolved chunk, or it holds none.
 */
export class ChunkedRelationQuery<TMeta extends Record<string, unknown>> {
  #chunks: Chunk<TMeta>[] = []
  #live: ReadonlySet<SourceValue> = new Set()
  #open: (values: SourceValue[]) => QueryRef<unknown[], unknown, TMeta>
  #subscribe: (queryRef: QueryRef<unknown[], unknown, TMeta>, onSuccess: () => void) => () => void
  #sourceValueOf: (row: unknown) => SourceValue | undefined
  #onSuccess: () => void
  #lastParts: unknown[][] = []
  #lastRows: unknown[] = []

  constructor(
    open: (values: SourceValue[]) => QueryRef<unknown[], unknown, TMeta>,
    /** Subscribe to a chunk, calling `onSuccess` whenever it produces rows. */
    subscribe: (queryRef: QueryRef<unknown[], unknown, TMeta>, onSuccess: () => void) => () => void,
    /** The source id a fetched row was matched by. */
    sourceValueOf: (row: unknown) => SourceValue | undefined,
    /** Called whenever any chunk produces rows. */
    onSuccess: () => void,
  ) {
    this.#open = open
    this.#subscribe = subscribe
    this.#sourceValueOf = sourceValueOf
    this.#onSuccess = onSuccess
  }

  sync(values: readonly SourceValue[]): void {
    const live = new Set(values)
    this.#live = live
    this.#release()
    const held = new Set(this.#chunks.flatMap(chunk => chunk.values))
    let fetched = values.filter(value => !held.has(value))
    const sparse = this.#chunks.filter(
      chunk => chunk.values.filter(value => live.has(value)).length < SPARSE_CHUNK_SIZE,
    )
    if (
      sparse.length + (fetched.length > 0 ? 1 : 0) > MAX_SPARSE_CHUNKS &&
      this.#chunks.every(isResolved)
    ) {
      const merged = new Set(sparse.flatMap(chunk => chunk.values))
      fetched = values.filter(value => !held.has(value) || merged.has(value))
    }
    const opened: Chunk<TMeta>[] = []
    for (let i = 0; i < fetched.length; i += RELATION_CHUNK_SIZE) {
      const chunkValues = fetched.slice(i, i + RELATION_CHUNK_SIZE)
      opened.push({ values: chunkValues, queryRef: this.#open(chunkValues), unsub: () => {} })
    }
    this.#chunks = [...this.#chunks, ...opened]
    // Subscribe once the chunk list is complete: a warm chunk reports success
    // synchronously, and its callback reads every chunk. Opened chunks are disjoint
    // and newest, so a warm one can only release older chunks.
    for (const chunk of opened) {
      chunk.unsub = this.#subscribe(chunk.queryRef, () => {
        this.#release()
        this.#onSuccess()
      })
    }
  }

  snapshot(): ChunkedRelationSnapshot {
    let error: Error | null = null
    let isFetching = false
    const parts: unknown[][] = []
    const resolved: Chunk<TMeta>[] = []
    const unsettled: { chunk: Chunk<TMeta>; error: Error | null }[] = []
    for (const chunk of this.#chunks) {
      const state = chunk.queryRef.getSnapshot()
      if (!state || state.status === 'loading') {
        isFetching = true
        unsettled.push({ chunk, error: null })
      } else if (state.status === 'error') {
        unsettled.push({ chunk, error: state.error })
      } else {
        error ??= state.error
        isFetching ||= state.isFetching
        parts.push(state.data)
        resolved.push(chunk)
      }
    }
    const rows = this.#rows(parts)
    if (unsettled.length === 0) return { status: 'ready', rows, error, isFetching }
    // Only chunks holding a referenced id no resolved chunk serves count: a merged
    // chunk loading behind the sparse chunks it replaces is invisible. A chunk still
    // loading outranks a failed one, as the hop settles once every chunk has.
    const served = new Set(resolved.flatMap(chunk => chunk.values))
    const waiting = unsettled.filter(({ chunk }) =>
      chunk.values.some(value => this.#live.has(value) && !served.has(value)),
    )
    const failure = waiting.find(({ error }) => error)?.error ?? null
    const status = waiting.some(({ error }) => !error) ? 'loading' : failure ? 'error' : 'ready'
    return { status, rows, error: failure ?? error, isFetching }
  }

  /**
   * Rows of the currently referenced ids across every resolved chunk, or null while
   * any chunk has yet to settle. Nested relations sync from these, so ids that left
   * a still-referenced chunk stop driving them, and a failed chunk (whose error the
   * snapshot reports) doesn't hold back its healthy siblings.
   */
  readyRows(): unknown[] | null {
    const snapshot = this.snapshot()
    if (snapshot.status === 'loading') return null
    const live = this.#live
    if (this.#chunks.every(chunk => chunk.values.every(value => live.has(value)))) {
      return snapshot.rows
    }
    return snapshot.rows.filter(row => {
      const value = this.#sourceValueOf(row)
      return value !== undefined && live.has(value)
    })
  }

  queryRefs(): QueryRef<unknown[], unknown, TMeta>[] {
    return this.#chunks.map(chunk => chunk.queryRef)
  }

  dispose(): void {
    for (const chunk of this.#chunks) chunk.unsub()
    this.#chunks = []
  }

  /** Newest first, keep each chunk holding a referenced id no newer resolved chunk serves. */
  #release(): void {
    const served = new Set<SourceValue>()
    const kept: Chunk<TMeta>[] = []
    for (const chunk of [...this.#chunks].reverse()) {
      if (chunk.values.some(value => this.#live.has(value) && !served.has(value))) kept.push(chunk)
      else chunk.unsub()
      if (chunk.queryRef.getSnapshot()?.status === 'success') {
        for (const value of chunk.values) served.add(value)
      }
    }
    this.#chunks = kept.reverse()
  }

  #rows(parts: unknown[][]): unknown[] {
    const unchanged =
      parts.length === this.#lastParts.length &&
      parts.every((part, index) => part === this.#lastParts[index])
    if (!unchanged) {
      this.#lastParts = parts
      // A merged chunk overlaps the chunks it replaces until they're released, and a
      // frozen chunk or a server that ignores `$in` can return a shared entity twice;
      // relation rows list it once.
      this.#lastRows = parts.length === 1 ? parts[0]! : [...new Set(parts.flat())]
    }
    return this.#lastRows
  }
}
