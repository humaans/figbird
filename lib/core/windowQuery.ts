import type { PageCursor, PageInfo } from '../adapters/adapter.js'
import { hashObject } from './hash.js'
import type { QueryAST } from './queryBuilder.js'
import {
  RelationalQueryRef,
  type RelationalPageRoot,
  type RelationalQueryHost,
} from './relationalQuery.js'
import type { AnySchema, Schema } from './schema.js'
import { resolveServicePath } from './schema.js'

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
  lastUsed: number
  rootRevision: unknown
}

interface SuspenseWaiter {
  range: WindowRange
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
}

const EMPTY_DATA: ReadonlyMap<number, never> = new Map<number, never>()

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
 * A viewport-indexed relational query. Offset services address blocks directly;
 * native cursor services walk forward once and retain index -> cursor checkpoints.
 * The public hook supplies ranges, while this reference owns page lifetimes.
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
  #strategy: 'offset' | 'cursor'
  #serviceName: string
  #key: string
  #name: string | undefined
  #onEvict: (() => void) | null

  #pages = new Map<number, WindowPage<T, S, TParams, TMeta, TQuery>>()
  #cursorAt = new Map<number, PageCursor | undefined>([[0, undefined]])
  #terminalIndex: number | undefined
  #subscribers = new Map<(state: WindowQueryState<T>) => void, WindowSubscriber<T>>()
  #coldRanges = new Map<string, WindowRange>()
  #waiters = new Map<string, SuspenseWaiter>()
  #cleanupScheduled = false
  #syncScheduled = false
  #clock = 0
  #version = 0
  #data: ReadonlyMap<number, T> = EMPTY_DATA
  #total: number | undefined
  #hasSuccessfulWindow = false
  #snapshotCache = new Map<string, { version: number; state: WindowQueryState<T> }>()

  constructor(
    host: RelationalQueryHost<TParams, TMeta, TQuery>,
    ast: QueryAST,
    schema: S,
    config: WindowQueryConfig,
    onEvict?: () => void,
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
    this.#serviceName = resolveServicePath(schema, ast.service)
    this.#strategy = host.adapter.pageSource?.(this.#serviceName) ? 'cursor' : 'offset'
    this.#key = `wq/${hashObject({ ast, config })}`
    this.#onEvict = onEvict ?? null
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
    this.#subscribers.set(listener, {
      listener,
      range,
      staleTime: options.staleTime ?? 0,
    })
    this.#coldRanges.delete(rangeKey(range))
    this.#syncPages()

    return () => {
      this.#subscribers.delete(listener)
      this.#scheduleSync()
      if (this.#subscribers.size === 0 && this.#coldRanges.size === 0) this.#scheduleCleanup()
    }
  }

  getSnapshot(rangeInput: WindowRange): WindowQueryState<T> {
    const range = normalizeRange(rangeInput)
    const key = rangeKey(range)
    const cached = this.#snapshotCache.get(key)
    if (cached?.version === this.#version) return cached.state

    const required =
      this.#strategy === 'cursor'
        ? this.#cursorPagesForRange(range)
        : this.#pageStarts(range, 0).flatMap(start => {
            const page = this.#pages.get(start)
            return page ? [page] : []
          })
    let missing =
      this.#strategy === 'cursor'
        ? !this.#cursorRangeReady(range)
        : required.length !== this.#pageStarts(range, 0).length
    let isFetching = false
    let error: Error | null = null
    for (const page of required) {
      const state = page.ref.getSnapshot()
      if (!state || state.status === 'loading') missing = true
      if (state?.isFetching) isFetching = true
      if (state?.status === 'error') error ??= state.error
      if (state?.status === 'success' && state.error) error ??= state.error
    }
    if (this.#strategy === 'cursor') {
      for (const page of this.#pages.values()) {
        if (page.ref.getSnapshot().isFetching) isFetching = true
      }
    } else {
      for (const start of this.#pageStarts(range, this.#config.preloadPages)) {
        if (this.#pages.get(start)?.ref.getSnapshot().isFetching) isFetching = true
      }
    }

    let state: WindowQueryState<T>
    if (error && !this.#hasSuccessfulWindow) {
      state = {
        status: 'error',
        data: this.#data,
        total: this.#total,
        error,
        isFetching: false,
      }
    } else if (missing && !this.#hasSuccessfulWindow) {
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
        error,
        isFetching: isFetching || missing,
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
    if (this.#hasSuccessfulWindow) return Promise.resolve()
    const state = this.getSnapshot(range)
    if (state.status === 'success') return Promise.resolve()
    if (state.status === 'error') return Promise.reject(state.error)

    const key = rangeKey(range)
    const existing = this.#waiters.get(key)
    if (existing) return existing.promise

    let resolve = () => {}
    let reject = (_error: Error) => {}
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    this.#waiters.set(key, { range, promise, resolve, reject })
    this.#coldRanges.set(key, range)
    this.#syncPages()
    this.#settleWaiters()
    return promise
  }

  releaseColdStart(rangeInput: WindowRange): void {
    const range = normalizeRange(rangeInput)
    const key = rangeKey(range)
    this.#coldRanges.delete(key)
    this.#waiters.delete(key)
    if (this.#subscribers.size === 0 && this.#coldRanges.size === 0) this.#scheduleCleanup()
  }

  #pageStarts(range: WindowRange, preloadPages: number): number[] {
    const { pageSize } = this.#config
    const firstVisible = Math.floor(range.start / pageSize) * pageSize
    const lastVisible = Math.floor((Math.max(range.start + 1, range.end) - 1) / pageSize) * pageSize
    const first = Math.max(0, firstVisible - preloadPages * pageSize)
    const last = lastVisible + preloadPages * pageSize
    const starts: number[] = []
    for (let start = first; start <= last; start += pageSize) {
      if (this.#total !== undefined && start >= this.#total) continue
      starts.push(start)
    }
    return starts
  }

  #desiredStarts(): Set<number> {
    const starts = new Set<number>()
    for (const subscriber of this.#subscribers.values()) {
      for (const start of this.#pageStarts(subscriber.range, this.#config.preloadPages)) {
        starts.add(start)
      }
    }
    for (const range of this.#coldRanges.values()) {
      for (const start of this.#pageStarts(range, this.#config.preloadPages)) starts.add(start)
    }
    return starts
  }

  #syncPages(): void {
    const desired = this.#desiredStarts()
    if (this.#strategy === 'offset') {
      for (const start of desired) this.#ensurePage(start)
    } else {
      // Page zero is the cursor chain's total/reconnect sentinel. Other desired
      // blocks start directly once their index checkpoint has been discovered.
      this.#ensurePage(0)
      for (const target of desired) {
        const lastIndex = Math.min(
          target + this.#config.pageSize - 1,
          (this.#total ?? Infinity) - 1,
        )
        if (lastIndex >= target) this.#ensureCursorPath(lastIndex)
      }
    }
    this.#evictPages(this.#strategy === 'cursor' ? this.#cursorProtectedStarts(desired) : desired)
  }

  #ensureCursorPath(target: number): void {
    if (this.#terminalIndex !== undefined && target >= this.#terminalIndex) return
    const covering = this.#cursorPageCovering(target)
    if (covering) {
      covering.lastUsed = ++this.#clock
      return
    }
    if (this.#cursorAt.has(target)) {
      this.#ensurePage(target)
      return
    }
    let nearest = 0
    for (const index of this.#cursorAt.keys()) {
      if (index <= target && index > nearest) nearest = index
    }
    this.#ensurePage(nearest)
  }

  #ensurePage(start: number): void {
    const existing = this.#pages.get(start)
    if (existing) {
      existing.lastUsed = ++this.#clock
      return
    }
    if (this.#strategy === 'cursor' && !this.#cursorAt.has(start)) return

    const pageRoot: RelationalPageRoot | undefined =
      this.#strategy === 'cursor'
        ? {
            page: {
              limit: this.#config.pageSize,
              ...(this.#cursorAt.get(start) !== undefined
                ? { after: this.#cursorAt.get(start)! }
                : {}),
              includeTotal: start === 0,
            },
            realtime: start === 0 && !this.#ast.snapshot ? 'refetch' : 'disabled',
          }
        : undefined
    const pageAst: QueryAST =
      this.#strategy === 'offset'
        ? {
            ...this.#ast,
            query: {
              ...this.#ast.query,
              $limit: this.#config.pageSize,
              $skip: start,
            },
          }
        : this.#ast
    const ref = new RelationalQueryRef<T[], S, TParams, TMeta, TQuery>(
      this.#host,
      pageAst,
      this.#schema,
      undefined,
      { ...(pageRoot ? { pageRoot } : {}), ephemeralRoot: true },
    )
    ref.setDisplayName(this.#name ? `${this.#name} [${start}]` : undefined)
    const page: WindowPage<T, S, TParams, TMeta, TQuery> = {
      start,
      ref,
      unsubscribe: () => {},
      lastUsed: ++this.#clock,
      rootRevision: undefined,
    }
    this.#pages.set(start, page)
    page.unsubscribe = ref.subscribe(() => this.#pageChanged(start), {
      staleTime: this.#currentStaleTime(),
    })
    this.#pageChanged(start)
  }

  #pageChanged(start: number): void {
    const page = this.#pages.get(start)
    if (!page) return
    const state = page.ref.getSnapshot()
    if (state.status === 'success') {
      const total = page.ref.total()
      if (total !== undefined) {
        this.#total = total
        if (this.#strategy === 'cursor') this.#terminalIndex = total
      }

      if (this.#strategy === 'cursor') {
        const revision = page.ref.rootRevision()
        if (start === 0 && page.rootRevision !== undefined && page.rootRevision !== revision) {
          this.#resetCursorDescendants()
        }
        page.rootRevision = revision
        this.#recordCursorContinuation(start, state.data.length, page.ref.pageInfo())
      }
    }
    this.#rebuildData()
    this.#refreshSuccessfulWindow()
    this.#version += 1
    this.#snapshotCache.clear()
    this.#settleWaiters()
    this.#scheduleSync()
    for (const subscriber of this.#subscribers.values()) {
      subscriber.listener(this.getSnapshot(subscriber.range))
    }
  }

  #recordCursorContinuation(start: number, rowCount: number, pageInfo: PageInfo | undefined): void {
    if (!pageInfo) return
    if (!pageInfo.hasMore) {
      this.#terminalIndex = start + rowCount
      this.#total ??= this.#terminalIndex
      return
    }
    const next = start + rowCount
    if (rowCount === 0) return
    this.#cursorAt.set(next, pageInfo.endCursor)
  }

  #resetCursorDescendants(): void {
    for (const start of Array.from(this.#pages.keys())) {
      if (start > 0) this.#dropPage(start)
    }
    this.#cursorAt = new Map([[0, undefined]])
    this.#terminalIndex = undefined
  }

  #refreshSuccessfulWindow(): void {
    if (this.#hasSuccessfulWindow) return
    const ranges = [
      ...Array.from(this.#subscribers.values(), subscriber => subscriber.range),
      ...this.#coldRanges.values(),
    ]
    this.#hasSuccessfulWindow = ranges.some(range =>
      this.#strategy === 'cursor'
        ? this.#cursorRangeReady(range)
        : this.#pageStarts(range, 0).every(start => {
            const state = this.#pages.get(start)?.ref.getSnapshot()
            return state?.status === 'success'
          }),
    )
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

  #settleWaiters(): void {
    for (const [key, waiter] of this.#waiters) {
      const required =
        this.#strategy === 'cursor'
          ? this.#cursorPagesForRange(waiter.range)
          : this.#pageStarts(waiter.range, 0).flatMap(start => {
              const page = this.#pages.get(start)
              return page ? [page] : []
            })
      let error: Error | null = null
      let ready =
        this.#strategy === 'cursor'
          ? this.#cursorRangeReady(waiter.range)
          : required.length === this.#pageStarts(waiter.range, 0).length
      for (const page of required) {
        const state = page.ref.getSnapshot()
        if (state.status === 'loading') ready = false
        if (state?.status === 'error') error ??= state.error
      }
      if (error) {
        this.#waiters.delete(key)
        this.#coldRanges.delete(key)
        waiter.reject(error)
      } else if (ready) {
        this.#waiters.delete(key)
        waiter.resolve()
      }
    }
  }

  #currentStaleTime(): number {
    let staleTime = Infinity
    for (const subscriber of this.#subscribers.values()) {
      staleTime = Math.min(staleTime, subscriber.staleTime)
    }
    return staleTime === Infinity ? 0 : staleTime
  }

  /** A successful cursor page whose absolute interval contains this row. */
  #cursorPageCovering(index: number): WindowPage<T, S, TParams, TMeta, TQuery> | undefined {
    for (const page of this.#pages.values()) {
      const state = page.ref.getSnapshot()
      if (
        state.status === 'success' &&
        page.start <= index &&
        index < page.start + state.data.length
      ) {
        return page
      }
    }
    return undefined
  }

  /** Cursor pages currently responsible for making a visible range ready. */
  #cursorPagesForRange(range: WindowRange): WindowPage<T, S, TParams, TMeta, TQuery>[] {
    const pages = new Set<WindowPage<T, S, TParams, TMeta, TQuery>>()
    const knownEnd = Math.min(range.end, this.#terminalIndex ?? this.#total ?? range.end)
    let index = range.start
    while (index < knownEnd) {
      const covering = this.#cursorPageCovering(index)
      if (covering) {
        pages.add(covering)
        const state = covering.ref.getSnapshot()
        if (state.status !== 'success') break
        index = covering.start + state.data.length
        continue
      }
      let nearest = 0
      for (const checkpoint of this.#cursorAt.keys()) {
        if (checkpoint <= index && checkpoint > nearest) nearest = checkpoint
      }
      const page = this.#pages.get(nearest)
      if (page) pages.add(page)
      break
    }
    return Array.from(pages)
  }

  #cursorRangeReady(range: WindowRange): boolean {
    const knownEnd = Math.min(range.end, this.#terminalIndex ?? this.#total ?? range.end)
    let index = range.start
    while (index < knownEnd) {
      const page = this.#cursorPageCovering(index)
      if (!page) return false
      const state = page.ref.getSnapshot()
      if (state.status !== 'success') return false
      index = page.start + state.data.length
    }
    return true
  }

  #cursorProtectedStarts(targets: ReadonlySet<number>): Set<number> {
    const starts = new Set<number>([0])
    for (const target of targets) {
      const targetEnd = target + this.#config.pageSize
      for (const page of this.#pages.values()) {
        const state = page.ref.getSnapshot()
        if (
          state.status === 'success' &&
          page.start < targetEnd &&
          page.start + state.data.length > target
        ) {
          starts.add(page.start)
        }
      }
      const covering = this.#cursorPageCovering(target)
      if (covering) {
        starts.add(covering.start)
      }
      const lastIndex = Math.min(target + this.#config.pageSize - 1, (this.#total ?? Infinity) - 1)
      let nearest = 0
      for (const checkpoint of this.#cursorAt.keys()) {
        if (checkpoint <= lastIndex && checkpoint > nearest) nearest = checkpoint
      }
      if (this.#pages.has(nearest)) starts.add(nearest)
    }
    return starts
  }

  #evictPages(protectedStarts: ReadonlySet<number>): void {
    while (this.#pages.size > this.#config.maxPages) {
      const candidates = Array.from(this.#pages.values())
        .filter(page => !protectedStarts.has(page.start))
        .sort((a, b) => a.lastUsed - b.lastUsed)
      const oldest = candidates[0]
      if (!oldest) break
      this.#dropPage(oldest.start)
    }
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

  #scheduleCleanup(): void {
    if (this.#cleanupScheduled) return
    this.#cleanupScheduled = true
    queueMicrotask(() => {
      this.#cleanupScheduled = false
      if (this.#subscribers.size === 0 && this.#coldRanges.size === 0) this.#cleanup()
    })
  }

  #cleanup(): void {
    for (const page of this.#pages.values()) page.unsubscribe()
    this.#pages.clear()
    this.#cursorAt = new Map([[0, undefined]])
    this.#terminalIndex = undefined
    this.#data = EMPTY_DATA
    this.#total = undefined
    this.#hasSuccessfulWindow = false
    this.#snapshotCache.clear()
    this.#waiters.clear()
    this.#onEvict?.()
  }
}
