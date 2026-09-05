interface PendingRead<T> {
  status: 'pending'
  value: T
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
}

interface SettledRead<T> {
  status: 'settled'
  value: T
  promise: Promise<void>
  lastUsed: number
}

type ColdRead<T> = PendingRead<T> | SettledRead<T>

/** Owns subscriptions, speculative reads, and deferred release for composite queries. */
export class QueryLifetime<TListener, TOwner extends { staleTime: number }, TRead> {
  #owners = new Map<TListener, TOwner>()
  #reads = new Map<string, ColdRead<TRead>>()
  #cleanupScheduled = false
  #generation = 0
  #clock = 0

  get owners(): ReadonlyMap<TListener, TOwner> {
    return this.#owners
  }

  get reads(): ReadonlyMap<string, ColdRead<TRead>> {
    return this.#reads
  }

  acquire(listener: TListener, owner: TOwner): void {
    this.#owners.set(listener, owner)
  }

  release(listener: TListener): void {
    this.#owners.delete(listener)
  }

  staleTime(): number {
    if (this.#owners.size === 0) return 0
    let staleTime = Infinity
    for (const owner of this.#owners.values()) staleTime = Math.min(staleTime, owner.staleTime)
    return staleTime
  }

  read(key: string, value: TRead, start: () => void): Promise<void> {
    const existing = this.#reads.get(key)
    if (existing) {
      if (existing.status === 'settled') existing.lastUsed = ++this.#clock
      return existing.promise
    }
    let resolve = () => {}
    let reject = (_error: Error) => {}
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    this.#reads.set(key, { status: 'pending', value, promise, resolve, reject })
    start()
    return promise
  }

  settle(key: string, value: TRead, error: Error | null): void {
    const read = this.#reads.get(key)
    if (read?.status === 'settled') return
    this.#reads.set(key, {
      status: 'settled',
      value,
      promise: read?.promise ?? Promise.resolve(),
      lastUsed: ++this.#clock,
    })
    // A query may settle before anyone requests a Suspense promise.
    if (read) {
      if (error) read.reject(error)
      else read.resolve()
    }
  }

  releaseRead(key: string): void {
    this.#reads.delete(key)
  }

  pruneSettledReads(limit: number): void {
    const reads = Array.from(this.#reads.entries())
      .filter((entry): entry is [string, SettledRead<TRead>] => entry[1].status === 'settled')
      .sort((a, b) => b[1].lastUsed - a[1].lastUsed)
    for (const [key] of reads.slice(limit)) this.#reads.delete(key)
  }

  scheduleCleanup(canCleanup: () => boolean, cleanup: () => void): void {
    if (this.#cleanupScheduled) return
    this.#cleanupScheduled = true
    const generation = this.#generation
    queueMicrotask(() => {
      if (generation !== this.#generation) return
      this.#cleanupScheduled = false
      if (this.#owners.size === 0 && canCleanup()) cleanup()
    })
  }

  reset(): void {
    this.#generation += 1
    this.#cleanupScheduled = false
    this.#reads.clear()
  }

  dispose(): void {
    for (const [key, read] of this.#reads) {
      this.settle(key, read.value, new Error('figbird: instance has been disposed'))
    }
    this.#owners.clear()
    this.reset()
  }
}
