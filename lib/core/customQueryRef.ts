import { sameValue } from './valueEquality.js'
import type { Clock, ClockTimer } from './clock.js'
import { normalizeError } from './errors.js'
import type { InspectedQuery } from './figbird.js'
import { RelationalQueryLifetime } from './relationalQueryLifetime.js'
import type { RelationalQueryState } from './relationalQuery.js'
import { isWithinStaleTime } from './staleTime.js'
import { defaultRetryDelay, resolveRetryDelay } from './retryDelay.js'
import type { RetryDelay } from './queryStore.js'

interface CustomQueryHost<T> {
  clock: Clock
  assertActive(): void
  fetch(): Promise<T>
  isRetryable(error: Error): boolean
  retry: number | false
  retryDelay: RetryDelay | undefined
  onChange(): void
  onActive(): void
  onIdle(): void
  onSettled(): void
  onAbandoned(): void
}

type Listener<T> = (state: RelationalQueryState<T>) => void

/** Opaque query results share read leases with entity queries, never entity maintenance. */
export class CustomQueryRef<T> {
  readonly #host: CustomQueryHost<T>
  readonly #key: string
  readonly #serviceName: string
  readonly #method: string
  readonly #args: readonly unknown[]
  readonly #lifetime: RelationalQueryLifetime<Listener<T>>
  #state: RelationalQueryState<T> = { status: 'idle', data: null, error: null, isFetching: false }
  #pending = false
  #disposed = false
  #adopted = false
  #refetchRequested = false
  #invalidated = false
  #retryTimer: ClockTimer | null = null
  #fetchedAt: number | undefined
  #fetchCount = 0
  #errorCount = 0
  #lastDurationMs: number | undefined
  #totalDurationMs = 0
  #name: string | undefined
  coldReadGroup: object = {}

  constructor(
    key: string,
    serviceName: string,
    method: string,
    args: readonly unknown[],
    staleTime: number,
    host: CustomQueryHost<T>,
  ) {
    this.#key = key
    this.#serviceName = serviceName
    this.#method = method
    this.#args = args
    this.#host = host
    this.#lifetime = new RelationalQueryLifetime(host.clock, staleTime)
  }

  get serviceName(): string {
    return this.#serviceName
  }

  hash(): string {
    return this.#key
  }
  kind(): 'custom' {
    return 'custom'
  }
  setDisplayName(name: string | undefined): void {
    this.#name ??= name
  }
  setColdReadGroup(group: object): void {
    this.coldReadGroup = group
  }
  getSnapshot(): RelationalQueryState<T> {
    return this.#state
  }

  subscribe(
    fn: Listener<T>,
    options?: { staleTime?: number | undefined; source?: 'subscriber' | 'prepare' | 'prefetch' },
  ): () => void {
    this.#assertActive()
    this.#host.onActive()
    this.#adopted = true
    const freshness = this.#lifetime.retain(fn, options)
    if (
      this.#state.status === 'idle' ||
      this.#invalidated ||
      (freshness.kind === 'check' &&
        !isWithinStaleTime(this.#fetchedAt, freshness.staleTime, this.#host.clock.now()))
    ) {
      this.#start()
    }
    this.#host.onChange()
    return () => {
      // A handle can outlive its reference, for example a failed preparation that a
      // boundary retry already replaced. Releasing it must not touch the replacement.
      if (this.#disposed) return
      this.#lifetime.release(fn)
      this.#lifetime.scheduleCleanup(
        () => !this.#pending,
        () => this.#host.onIdle(),
      )
      this.#host.onChange()
    }
  }

  prefetch(staleTime: number): void {
    this.#assertActive()
    this.#lifetime.prefetch(staleTime, () =>
      this.subscribe(() => {}, { source: 'prefetch', staleTime }),
    )
  }

  refetch(): void {
    this.#assertActive()
    if (this.#pending) {
      this.#refetchRequested = true
      return
    }
    this.#start()
  }

  /** Service-wide invalidation starts active queries and marks retained results stale. */
  invalidate(): void {
    this.#invalidated = true
    if (this.#lifetime.owners.size > 0 || this.#pending) this.refetch()
  }

  suspensePromise(): Promise<void> {
    this.#assertActive()
    return this.#lifetime.suspensePromise(() => {
      if (this.#state.status === 'idle') this.#start()
      this.#settle()
    })
  }

  /** @internal Restart a cold failure only when its Suspense consumer retries. */
  retryColdStart(): boolean {
    if (this.#state.status !== 'error' || !this.#lifetime.consumeFailedReadRetry()) return false
    this.refetch()
    return true
  }

  releaseColdStart(observed = true): void {
    if (this.#state.status === 'error') {
      const stillFailed = () => this.#state.status === 'error'
      const abandon = () => this.#host.onAbandoned()
      // Only a reader that threw the failure to its boundary may arm a retry.
      if (observed) this.#lifetime.failedReadObserved(stillFailed, abandon)
      else this.#lifetime.releaseFailedRead(stillFailed, abandon)
      return
    }
    if (!this.#lifetime.owned && !this.#pending)
      this.#lifetime.scheduleCleanup(
        () => !this.#pending,
        () => this.#host.onAbandoned(),
      )
  }

  retainRenderRead(onExpire: () => void): void {
    this.#lifetime.retainRenderRead(onExpire)
  }

  canEvictAbandonedRead(): boolean {
    return (
      !this.#lifetime.leased &&
      (!this.#adopted || this.#state.status === 'error') &&
      !this.#lifetime.owned &&
      !this.#pending
    )
  }

  /** @internal A render that has not committed yet still expects this result. */
  get renderReadRetained(): boolean {
    return this.#lifetime.leased
  }

  /** @internal Idle retention may expire only results nothing holds or is fetching. */
  canExpire(): boolean {
    return !this.#lifetime.owned && !this.#pending
  }

  evictAbandonedRead(): boolean {
    if (!this.canEvictAbandonedRead()) return false
    this.#host.onAbandoned()
    return true
  }

  inspect(): InspectedQuery {
    return {
      queryId: this.#key,
      generation: 1,
      serviceName: this.#serviceName,
      method: this.#method,
      custom: true,
      ...(this.#name ? { name: this.#name } : {}),
      query: { args: this.#args },
      classification: 'custom',
      classificationReasons: [{ code: 'custom-method' }],
      realtimeStrategy: 'manual',
      status: this.#state.status === 'idle' ? 'loading' : this.#state.status,
      isFetching: this.#state.isFetching,
      ...(this.#state.status === 'success' ? { data: this.#state.data } : {}),
      itemCount:
        this.#state.status === 'success'
          ? Array.isArray(this.#state.data)
            ? this.#state.data.length
            : 1
          : 0,
      fetchedAt: this.#fetchedAt,
      prepareCount: [...this.#lifetime.owners.values()].filter(owner => owner.source === 'prepare')
        .length,
      prefetchCount: [...this.#lifetime.owners.values()].filter(
        owner => owner.source === 'prefetch',
      ).length,
      subscriberCount: [...this.#lifetime.owners.values()].filter(
        owner => owner.source === 'subscriber',
      ).length,
      fetchCount: this.#fetchCount,
      errorCount: this.#errorCount,
      ...(this.#lastDurationMs === undefined ? {} : { lastDurationMs: this.#lastDurationMs }),
      totalDurationMs: this.#totalDurationMs,
    }
  }

  dispose(): void {
    this.#disposed = true
    this.#retryTimer?.cancel()
    this.#retryTimer = null
    this.#lifetime.dispose()
    this.#state = { status: 'idle', data: null, error: null, isFetching: false }
  }

  #assertActive(): void {
    this.#host.assertActive()
    if (this.#disposed) throw new Error('figbird: custom query reference has been released')
  }

  #start(): void {
    if (this.#pending) return
    this.#host.onActive()
    this.#lifetime.clearFailedReadRetry()
    // Drop only a read the earlier failure already settled. A render may still be
    // suspended on a pending one, and the fetch started here is what settles it.
    if (this.#state.status === 'error' && this.#lifetime.reads.get('root')?.status === 'settled') {
      this.#lifetime.releaseRead('root')
    }
    this.#pending = true
    this.#invalidated = false
    this.#lifetime.graphStarted()
    this.#state =
      this.#state.status === 'success'
        ? { ...this.#state, error: null, isFetching: true }
        : { status: 'loading', data: null, error: null, isFetching: true }
    this.#notify()
    void this.#attempt(0)
  }

  async #attempt(attempt: number): Promise<void> {
    const startedAt = this.#host.clock.now()
    this.#fetchCount++
    try {
      const data = await this.#host.fetch()
      if (this.#disposed) return
      this.#recordDuration(startedAt)
      this.#fetchedAt = this.#host.clock.now()
      const stableData =
        this.#state.status === 'success' && sameValue(this.#state.data, data)
          ? this.#state.data
          : data
      this.#state = { status: 'success', data: stableData, error: null, isFetching: false }
    } catch (value) {
      if (this.#disposed) return
      this.#recordDuration(startedAt)
      this.#errorCount++
      const error = normalizeError(value)
      if (
        this.#host.retry !== false &&
        attempt < this.#host.retry &&
        this.#host.isRetryable(error)
      ) {
        const next = attempt + 1
        const configured = this.#host.retryDelay
        const delay =
          configured === undefined
            ? defaultRetryDelay(next)
            : resolveRetryDelay(
                () => (typeof configured === 'function' ? configured(next, error) : configured),
                defaultRetryDelay(next),
              )
        this.#retryTimer = this.#host.clock.setTimeout(() => {
          this.#retryTimer = null
          void this.#attempt(next)
        }, delay)
        this.#retryTimer.unref()
        this.#host.onChange()
        return
      }
      this.#state =
        this.#state.status === 'success'
          ? { ...this.#state, error, isFetching: false }
          : { status: 'error', data: null, error, isFetching: false }
    }
    this.#pending = false
    if (this.#refetchRequested) {
      this.#refetchRequested = false
      this.#start()
      return
    }
    this.#settle()
    this.#notify()
    if (this.#lifetime.owners.size === 0) {
      if (this.#adopted) this.#host.onIdle()
      else this.#host.onSettled()
    }
  }

  #recordDuration(startedAt: number): void {
    this.#lastDurationMs = this.#host.clock.now() - startedAt
    this.#totalDurationMs += this.#lastDurationMs
  }

  #settle(): void {
    if (this.#state.status === 'success' || this.#state.status === 'error') {
      this.#lifetime.settleSuspense(this.#state.status === 'error' ? this.#state.error : null)
    }
  }

  #notify(): void {
    this.#host.onChange()
    queueMicrotask(() => {
      if (this.#disposed) return
      for (const fn of this.#lifetime.owners.keys()) fn(this.#state)
    })
  }
}
