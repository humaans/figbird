import { QueryLifetime } from './queryLifetime.js'
import { hashObject } from './hash.js'
import type { QueryAST } from './queryBuilder.js'
import { RelationalQueryRef, type RelationalQueryHost } from './relationalQuery.js'
import type { AnySchema, Schema } from './schema.js'
import { resolveServicePath } from './schema.js'
import { validateStaleTime } from './staleTime.js'
import {
  CursorWindowPager,
  OffsetWindowPager,
  type PagerPage,
  type WindowPager,
} from './windowQueryPager.js'

export interface WindowRange {
  /** First requested row index. */
  start: number
  /** First row index after the requested range. */
  end: number
}

export interface WindowQueryConfig {
  pageSize: number
  preloadPages: number
  maxPages: number
}

export type WindowQueryState<T> =
  | {
      status: 'loading'
      data: ReadonlyMap<number, T>
      total: number | undefined
      error: null
      isFetching: true
    }
  | {
      status: 'success'
      data: ReadonlyMap<number, T>
      total: number | undefined
      error: Error | null
      isFetching: boolean
    }
  | {
      status: 'error'
      data: ReadonlyMap<number, T>
      total: number | undefined
      error: Error
      isFetching: false
    }

interface WindowSubscriber<T> {
  range: WindowRange
  staleTime: number
  listener: (state: WindowQueryState<T>) => void
}

interface WindowPage<T, S extends Schema, TParams, TMeta extends Record<string, unknown>, TQuery> {
  start: number
  ref: RelationalQueryRef<T[], S, TParams, TMeta, TQuery>
  unsubscribe: () => void
  staleTime: number
  lastUsed: number
}

interface WindowQueryOptions {
  defaultStaleTime?: number
  onEvict?: () => void
  onIdle?: () => void
}

const EMPTY_DATA: ReadonlyMap<number, never> = new Map<number, never>()
const MAX_SETTLED_COLD_READS = 20

function normalizeRange(range: WindowRange): WindowRange {
  if (!Number.isInteger(range.start) || range.start < 0) {
    throw new Error(
      `useWindowQuery(): range.start must be a non-negative integer, got ${range.start}`,
    )
  }
  if (!Number.isInteger(range.end) || range.end < range.start) {
    throw new Error(
      `useWindowQuery(): range.end must be an integer greater than or equal to range.start, got ${range.end}`,
    )
  }
  // An empty viewport still needs one row request to discover the server total.
  return range.end === range.start ? { start: range.start, end: range.start + 1 } : range
}

function rangeKey(range: WindowRange): string {
  return `${range.start}:${range.end}`
}

/**
 * Shared lifecycle for a viewport-indexed relational query. Pagination-specific
 * addressing and readiness live behind WindowPager; this class owns readers,
 * relational page refs, render-phase cold reads, and bounded retention.
 */
export class WindowQueryRef<
  T,
  S extends Schema = AnySchema,
  TParams = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TQuery = Record<string, unknown>,
> {
  #host: RelationalQueryHost<TParams, TMeta, TQuery>
  #ast: QueryAST
  #schema: S
  #config: WindowQueryConfig
  #pager: WindowPager
  #key: string
  #name: string | undefined
  #defaultStaleTime: number
  #onEvict: (() => void) | null
  #onIdle: (() => void) | null

  #pages = new Map<number, WindowPage<T, S, TParams, TMeta, TQuery>>()
  #lifetime = new QueryLifetime<
    (state: WindowQueryState<T>) => void,
    WindowSubscriber<T>,
    WindowRange
  >()
  #syncScheduled = false
  #notifyScheduled = false
  #clock = 0
  #version = 0
  #data: ReadonlyMap<number, T> = EMPTY_DATA
  #total: number | undefined
  #snapshotCache = new Map<string, { version: number; state: WindowQueryState<T> }>()

  constructor(
    host: RelationalQueryHost<TParams, TMeta, TQuery>,
    ast: QueryAST,
    schema: S,
    config: WindowQueryConfig,
    options?: WindowQueryOptions,
  ) {
    if (!Number.isInteger(config.pageSize) || config.pageSize <= 0) {
      throw new Error(
        `useWindowQuery(): pageSize must be a positive integer, got ${config.pageSize}`,
      )
    }
    if (!Number.isInteger(config.preloadPages) || config.preloadPages < 0) {
      throw new Error(
        `useWindowQuery(): preloadPages must be a non-negative integer, got ${config.preloadPages}`,
      )
    }
    if (!Number.isInteger(config.maxPages) || config.maxPages <= 0) {
      throw new Error(
        `useWindowQuery(): maxPages must be a positive integer, got ${config.maxPages}`,
      )
    }
    this.#host = host
    this.#ast = ast
    this.#schema = schema
    this.#config = config
    this.#key = `wq/${hashObject({ ast, config })}`
    this.#defaultStaleTime = options?.defaultStaleTime ?? 0
    this.#onEvict = options?.onEvict ?? null
    this.#onIdle = options?.onIdle ?? null

    const serviceName = resolveServicePath(schema, ast.service)
    const context = {
      pageSize: config.pageSize,
      serviceName,
      ast,
      access: {
        page: (start: number) => this.#pagerPage(start),
        pages: () => Array.from(this.#pages.keys(), start => this.#pagerPage(start)!),
        ensure: (start: number) => this.#ensurePage(start),
        drop: (start: number) => this.#dropPage(start),
        touch: (start: number) => this.#touchPage(start),
        total: () => this.#total,
        setTotal: (total: number) => {
          this.#total = total
        },
      },
    }
    this.#pager = host.adapter.pageSource?.(serviceName)
      ? new CursorWindowPager(context)
      : new OffsetWindowPager(context)
  }

  hash(): string {
    return this.#key
  }

  setDisplayName(name: string | undefined): void {
    if (name && !this.#name) this.#name = name
  }

  subscribe(
    listener: (state: WindowQueryState<T>) => void,
    options: { range: WindowRange; staleTime?: number },
  ): () => void {
    const range = normalizeRange(options.range)
    const staleTime =
      options.staleTime === undefined
        ? this.#defaultStaleTime
        : validateStaleTime(options.staleTime, 'useWindowQuery(): staleTime')
    this.#lifetime.acquire(listener, {
      listener,
      range,
      staleTime,
    })
    const coldRead = this.#lifetime.reads.get(rangeKey(range))
    if (coldRead?.status === 'settled') {
      this.#releaseColdRead(rangeKey(range))
    }
    this.#syncPages()

    return () => {
      this.#lifetime.release(listener)
      this.#scheduleSync()
      if (this.#lifetime.owners.size === 0 && this.#lifetime.reads.size === 0)
        this.#scheduleCleanup()
    }
  }

  getSnapshot(rangeInput: WindowRange): WindowQueryState<T> {
    const range = normalizeRange(rangeInput)
    const key = rangeKey(range)
    const cached = this.#snapshotCache.get(key)
    if (cached?.version === this.#version) return cached.state

    const required = this.#pager.requiredStarts(range).flatMap(start => {
      const page = this.#pages.get(start)
      return page ? [page] : []
    })
    const missing = !this.#pager.rangeReady(range)
    let isFetching = false
    let coldError: Error | null = null
    let backgroundError: Error | null = null
    for (const page of required) {
      const state = page.ref.getSnapshot()
      if (state.isFetching) isFetching = true
      if (state.status === 'error') coldError ??= state.error
      if (state.status === 'success') backgroundError ??= state.error
    }
    for (const start of this.#pager.fetchingStarts(range, this.#config.preloadPages)) {
      if (this.#pages.get(start)?.ref.getSnapshot().isFetching) isFetching = true
    }

    let state: WindowQueryState<T>
    if (coldError) {
      state = {
        status: 'error',
        data: this.#data,
        total: this.#total,
        error: coldError,
        isFetching: false,
      }
    } else if (missing) {
      state = {
        status: 'loading',
        data: this.#data,
        total: this.#total,
        error: null,
        isFetching: true,
      }
    } else {
      state = {
        status: 'success',
        data: this.#data,
        total: this.#total,
        error: backgroundError,
        isFetching,
      }
    }
    this.#snapshotCache.set(key, { version: this.#version, state })
    return state
  }

  refetch(): void {
    for (const page of this.#pages.values()) page.ref.refetch()
  }

  suspensePromise(rangeInput: WindowRange): Promise<void> {
    const range = normalizeRange(rangeInput)
    const state = this.getSnapshot(range)
    if (state.status === 'success') return Promise.resolve()
    if (state.status === 'error') return Promise.reject(state.error)

    const key = rangeKey(range)
    return this.#lifetime.read(key, range, () => {
      this.#syncPages()
      this.#settleColdReads()
    })
  }

  releaseColdStart(rangeInput: WindowRange): void {
    const range = normalizeRange(rangeInput)
    const key = rangeKey(range)
    this.#releaseColdRead(key)
  }

  /** @internal Evicts an abandoned render-phase read under Figbird cache pressure. */
  evictAbandonedRead(): boolean {
    if (this.#lifetime.owners.size > 0 || this.#lifetime.reads.size === 0) return false
    for (const read of this.#lifetime.reads.values()) {
      if (read.status === 'pending') return false
    }
    this.#cleanup()
    return true
  }

  #desiredStarts(): Set<number> {
    const starts = new Set<number>()
    for (const subscriber of this.#lifetime.owners.values()) {
      for (const start of this.#pager.targetStarts(subscriber.range, this.#config.preloadPages)) {
        starts.add(start)
      }
    }
    for (const read of this.#lifetime.reads.values()) {
      for (const start of this.#pager.targetStarts(read.value, this.#config.preloadPages)) {
        starts.add(start)
      }
    }
    return starts
  }

  #syncPages(): void {
    const desired = this.#desiredStarts()
    this.#pager.sync(desired)
    this.#syncPageFreshness()
    if (this.#evictPages(this.#pager.protectedStarts(desired))) {
      this.#rebuildData()
      this.#version += 1
      this.#snapshotCache.clear()
      this.#scheduleNotify()
    }
  }

  #ensurePage(start: number): void {
    const existing = this.#pages.get(start)
    if (existing) {
      existing.lastUsed = ++this.#clock
      return
    }

    const ref = new RelationalQueryRef<T[], S, TParams, TMeta, TQuery>(
      this.#host,
      this.#ast,
      this.#schema,
      undefined,
      {
        defaultStaleTime: this.#defaultStaleTime,
        root: this.#pager.rootOverride(start),
      },
    )
    ref.setDisplayName(this.#name ? `${this.#name} [${start}]` : undefined)
    const staleTime = this.#lifetime.staleTime()
    const page: WindowPage<T, S, TParams, TMeta, TQuery> = {
      start,
      ref,
      unsubscribe: () => {},
      staleTime,
      lastUsed: ++this.#clock,
    }
    this.#pages.set(start, page)
    page.unsubscribe = ref.subscribe(() => this.#pageChanged(start), {
      staleTime,
    })
    this.#pageChanged(start)
  }

  #pageChanged(start: number): void {
    const page = this.#pages.get(start)
    if (!page) return
    const state = page.ref.getSnapshot()
    if (state.status === 'success') {
      const metadata = page.ref.rootMetadata()
      this.#pager.pageSucceeded({
        start,
        rowCount: state.data.length,
        continuation: metadata.continuation,
        total: metadata.total,
        revision: metadata.revision,
      })
    }
    this.#rebuildData()
    this.#version += 1
    this.#snapshotCache.clear()
    this.#settleColdReads()
    this.#scheduleSync()
    this.#scheduleNotify()
  }

  #rebuildData(): void {
    const data = new Map<number, T>()
    const pages = Array.from(this.#pages.values()).sort((a, b) => a.start - b.start)
    for (const page of pages) {
      const state = page.ref.getSnapshot()
      if (state.status !== 'success') continue
      state.data.forEach((item, index) => data.set(page.start + index, item))
    }
    this.#data = data
  }

  #settleColdReads(): void {
    let settled = false
    for (const [key, read] of this.#lifetime.reads) {
      if (read.status === 'settled') continue
      const state = this.getSnapshot(read.value)
      if (state.status === 'loading') continue
      this.#lifetime.settle(key, read.value, state.status === 'error' ? state.error : null)
      settled = true
    }
    if (settled) {
      // Settled render-phase reads stay warm independently of maxPages so
      // concurrent Suspense retries cannot evict one another. The separate cap
      // bounds abandoned renders until React commits and subscribes a reader.
      this.#lifetime.pruneSettledReads(MAX_SETTLED_COLD_READS)
      this.#onIdle?.()
    }
  }

  #syncPageFreshness(): void {
    const staleTime = this.#lifetime.staleTime()
    for (const page of this.#pages.values()) {
      if (page.staleTime === staleTime) continue
      const unsubscribe = page.ref.subscribe(() => this.#pageChanged(page.start), { staleTime })
      page.unsubscribe()
      page.unsubscribe = unsubscribe
      page.staleTime = staleTime
    }
  }

  #pagerPage(start: number): PagerPage | undefined {
    const page = this.#pages.get(start)
    if (!page) return undefined
    const state = page.ref.getSnapshot()
    return {
      start,
      status: state.status,
      rowCount: state.status === 'success' ? state.data.length : 0,
    }
  }

  #touchPage(start: number): void {
    const page = this.#pages.get(start)
    if (page) page.lastUsed = ++this.#clock
  }

  #evictPages(protectedStarts: ReadonlySet<number>): boolean {
    let evicted = false
    while (this.#pages.size > this.#config.maxPages) {
      const candidates = Array.from(this.#pages.values())
        .filter(page => !protectedStarts.has(page.start))
        .sort((a, b) => a.lastUsed - b.lastUsed)
      const oldest = candidates[0]
      if (!oldest) break
      this.#dropPage(oldest.start)
      evicted = true
    }
    return evicted
  }

  #dropPage(start: number): void {
    const page = this.#pages.get(start)
    if (!page) return
    this.#pages.delete(start)
    page.unsubscribe()
  }

  #scheduleSync(): void {
    if (this.#syncScheduled) return
    this.#syncScheduled = true
    queueMicrotask(() => {
      this.#syncScheduled = false
      this.#syncPages()
    })
  }

  #scheduleNotify(): void {
    if (this.#notifyScheduled) return
    this.#notifyScheduled = true
    queueMicrotask(() => {
      this.#notifyScheduled = false
      for (const subscriber of this.#lifetime.owners.values()) {
        subscriber.listener(this.getSnapshot(subscriber.range))
      }
    })
  }

  #scheduleCleanup(): void {
    this.#lifetime.scheduleCleanup(
      () => this.#lifetime.reads.size === 0,
      () => this.#cleanup(),
    )
  }

  #releaseColdRead(key: string): void {
    if (!this.#lifetime.reads.has(key)) return
    this.#lifetime.releaseRead(key)
    this.#scheduleCleanup()
  }

  /** @internal Release readers and pending Suspense work when the instance closes. */
  dispose(): void {
    this.#lifetime.dispose()
    this.#cleanup()
  }

  #cleanup(): void {
    for (const page of this.#pages.values()) page.unsubscribe()
    this.#pages.clear()
    this.#pager.reset()
    this.#data = EMPTY_DATA
    this.#total = undefined
    this.#snapshotCache.clear()
    this.#lifetime.reset()
    this.#onEvict?.()
  }
}
