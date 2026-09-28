export type ChangeType = 'created' | 'updated' | 'patched' | 'removed'

/** One committed write. Ids only: the log never holds row payloads. */
export interface ChangeEntry {
  seq: number
  service: string
  id: string | number
  type: ChangeType
}

/**
 * Where committed writes are recorded for replay. `since(seq)` returns every
 * retained entry with `entry.seq >= seq` in append order, or `'truncated'` when
 * an entry that could match has already been dropped — the caller then cannot
 * replay and must fall back to refetching.
 *
 * Implementations may be async. A Redis Streams log XADDs each entry after the
 * write commits and XRANGEs from the stored stream id; a Postgres outbox inserts
 * the entry in the write's own transaction and selects `WHERE seq >= $1`. Both
 * survive restarts and are shared by every node, which the in-memory log is not.
 */
export interface ChangeLog {
  append(entry: ChangeEntry): void | Promise<void>
  since(seq: number): ChangeEntry[] | 'truncated' | Promise<ChangeEntry[] | 'truncated'>
}

export interface MemoryChangeLogOptions {
  /** Entries retained before the oldest is dropped. Defaults to 10 000. */
  size?: number
}

/**
 * A bounded ring buffer of the most recent changes in this process. Lost on
 * restart and invisible to other nodes: a replay it cannot answer reads as
 * `'truncated'` and the client refetches, so it is safe but only useful for a
 * single-node deployment.
 */
export function memoryChangeLog({ size = 10_000 }: MemoryChangeLogOptions = {}): ChangeLog {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new RangeError(`memoryChangeLog(): size must be a positive integer, got ${size}`)
  }
  const entries: ChangeEntry[] = []
  let next = 0
  // Entries are appended in commit order, which is not quite sequence order, so
  // track the highest evicted sequence rather than the oldest retained one.
  let highestEvicted = -Infinity

  return {
    append(entry) {
      if (entries.length < size) {
        entries.push(entry)
        return
      }
      highestEvicted = Math.max(highestEvicted, entries[next]!.seq)
      entries[next] = entry
      next = (next + 1) % size
    },
    since(seq) {
      if (highestEvicted >= seq) return 'truncated'
      const result: ChangeEntry[] = []
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[(next + i) % entries.length]!
        if (entry.seq >= seq) result.push(entry)
      }
      return result
    },
  }
}
