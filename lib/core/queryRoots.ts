import type { PageCursor } from '../adapters/adapter.js'
import type { PageContinuation } from '../adapters/queryPage.js'
import type { QueryRef } from './queryRef.js'
import type { ProcessedCacheEvent, QueryGraphRef, QueryState } from './queryTypes.js'

/** The relational engine's adapter-neutral view of its root rows. */
export interface RootSnapshot {
  phase: 'loading' | 'error' | 'ready'
  /** Valid when phase is 'ready'. Identity is stable while the underlying data is. */
  rows: unknown[]
  isFetching: boolean
  error: Error | null
}

/** Adapter-neutral metadata attached to the relational root query. */
export interface RootMetadata {
  /** Normalized native continuation metadata, when the root is page-backed. */
  continuation: PageContinuation
  /** Server-reported result-set size, when the adapter supplied one. */
  total: number | undefined
}

/** Common lifecycle for a single-query root and an accumulating page root. */
export interface RootSource {
  snapshot(): RootSnapshot
  metadata(): RootMetadata
  setStaleTime(staleTime: number): void
  ensureFresh(staleTime?: number, graph?: QueryGraphRef): void
  refetch(graph?: QueryGraphRef): void
  /** Refetch the loaded rows through the store's reconcile gate (cooldown, hidden tab). */
  reconcile(): void
  teardown(): void
  queryIds(): string[]
}

/** Pagination metadata exposed by `.paginate(...)` queries. */
export interface RelationalPaginationState {
  /** Sticky while `loadMore()` is in flight. */
  hasMore: boolean
  isLoadingMore: boolean
  loadMoreError: Error | null
  /** Present when page one requested a total and the adapter supplied one. */
  total: number | undefined
}

/** Stable, adapter-neutral pagination details exposed to devtools. */
export interface InspectedPagination {
  strategy: 'offset' | 'cursor'
  realtime: 'manual' | 'merge-or-reconcile' | 'reconcile'
  pageSize: number
  includeTotal: boolean
  loadedPages: number
  hasMore: boolean
  isLoadingMore: boolean
  total?: number
}

export interface PaginatedRootSource extends RootSource {
  loadMore(graph?: QueryGraphRef): void
  pagination(): RelationalPaginationState
  inspectPagination(): InspectedPagination
}

const EMPTY_ROWS: unknown[] = []
const LOADING_ROOT: RootSnapshot = {
  phase: 'loading',
  rows: EMPTY_ROWS,
  isFetching: true,
  error: null,
}

type RootQueryRef<TMeta extends Record<string, unknown>> = Pick<
  QueryRef<unknown, unknown, TMeta>,
  | 'getPage'
  | 'getRows'
  | 'getSnapshot'
  | 'subscribe'
  | 'ensureFresh'
  | 'refetch'
  | 'reconcile'
  | 'hash'
>

/**
 * Store listeners fire only on changes. Seed from the current state as well so a
 * query already warmed by another consumer does not look cold until its SWR fetch
 * settles.
 */
export function subscribeAndSeed<TMeta extends Record<string, unknown>>(
  queryRef: RootQueryRef<TMeta>,
  onSuccess: (data: unknown[]) => void,
  onChange: () => void,
  staleTime = 0,
  graph?: QueryGraphRef,
): () => void {
  const unsub = queryRef.subscribe(
    state => {
      if (state.status === 'success') onSuccess(queryRef.getRows())
      onChange()
    },
    { staleTime, graph },
  )
  const initial = queryRef.getSnapshot()
  if (initial?.status === 'success') onSuccess(queryRef.getRows())
  return unsub
}

/** Root backed by one find or get query. */
export class SingleQueryRoot<TMeta extends Record<string, unknown>> implements RootSource {
  #queryRef: RootQueryRef<TMeta>
  #unsub: () => void

  constructor({
    queryRef,
    onRows,
    onChange,
    staleTime = 0,
    graph,
  }: {
    queryRef: RootQueryRef<TMeta>
    onRows: (rows: unknown[]) => void
    onChange: () => void
    staleTime?: number
    graph?: QueryGraphRef
  }) {
    this.#queryRef = queryRef
    this.#unsub = subscribeAndSeed(queryRef, onRows, onChange, staleTime, graph)
  }

  snapshot(): RootSnapshot {
    const state = this.#queryRef.getSnapshot()
    if (!state || state.status === 'loading') return LOADING_ROOT
    if (state.status === 'error') {
      return { phase: 'error', rows: EMPTY_ROWS, isFetching: false, error: state.error }
    }
    return {
      phase: 'ready',
      rows: this.#queryRef.getRows(),
      isFetching: state.isFetching,
      error: state.error,
    }
  }

  metadata(): RootMetadata {
    const { continuation, total } = this.#queryRef.getPage()
    return { continuation, total }
  }

  ensureFresh(staleTime?: number, graph?: QueryGraphRef): void {
    this.#queryRef.ensureFresh({ staleTime, graph })
  }

  setStaleTime(_staleTime: number): void {}

  refetch(graph?: QueryGraphRef): void {
    this.#queryRef.refetch({ graph })
  }

  reconcile(): void {
    this.#queryRef.reconcile()
  }

  teardown(): void {
    this.#unsub()
  }

  queryIds(): string[] {
    return [this.#queryRef.hash()]
  }
}

type SequentialReconcileState =
  | { phase: 'idle' }
  | {
      phase: 'running'
      targetPages: number
      rows: unknown[]
      previousQueryIds: ReadonlySet<string>
      rerun: boolean
    }
  | {
      phase: 'failed'
      targetPages: number
      rows: unknown[]
      previousQueryIds: ReadonlySet<string>
    }

/**
 * Root backed by an accumulating sequence of pages. Offset pages are independent.
 * Native continuation pages are sequential: page zero is the QueryStore lifecycle
 * sentinel, and a background fetch there rebuilds the loaded prefix before exposing
 * any of it.
 */
export class PagedQueryRoot<
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> implements PaginatedRootSource {
  #makePageRef: (pageIndex: number, after?: PageCursor) => QueryRef<unknown[], unknown, TMeta>
  #onRows: (rows: unknown[]) => void
  #onChange: () => void
  #pageSize: number
  #includeTotal: boolean
  #sequential: boolean
  #realtime: InspectedPagination['realtime']

  #pageRefs: Array<QueryRef<unknown[], unknown, TMeta>> = []
  #pageUnsubs: Array<() => void> = []
  #staleTime = 0
  #isLoadingMore = false
  #loadMoreError: Error | null = null
  #hasMoreSticky = true
  #lastPageDataRefs: unknown[] = []
  #lastAllPagesData: unknown[] = []
  #reconcile: SequentialReconcileState = { phase: 'idle' }
  #lastPagination: RelationalPaginationState | null = null
  #cursorEventUnsub: (() => void) | null = null
  #cursorInvalidationUnsub: (() => void) | null = null
  #cursorReconnectUnsub: (() => void) | null = null

  constructor({
    pageSize,
    includeTotal,
    sequential,
    makePageRef,
    onRows,
    onChange,
    cursorRealtime,
    realtime,
    staleTime = 0,
    graph,
  }: {
    pageSize: number
    includeTotal: boolean
    sequential: boolean
    /** `after` is the native cursor for sequential pages, the row offset for offset pages. */
    makePageRef: (pageIndex: number, after?: PageCursor) => QueryRef<unknown[], unknown, TMeta>
    onRows: (rows: unknown[]) => void
    onChange: () => void
    cursorRealtime?: {
      subscribe(fn: (event: ProcessedCacheEvent) => void): () => void
      subscribeToInvalidations(fn: () => void): () => void
      canKeepPrefix(event: ProcessedCacheEvent): boolean
    }
    realtime: InspectedPagination['realtime']
    staleTime?: number
    graph?: QueryGraphRef
  }) {
    this.#pageSize = pageSize
    this.#includeTotal = includeTotal
    this.#sequential = sequential
    this.#realtime = realtime
    this.#makePageRef = makePageRef
    this.#onRows = onRows
    this.#onChange = onChange
    this.#staleTime = staleTime
    this.#setupPage(0, undefined, undefined, graph)
    if (cursorRealtime) {
      this.#cursorReconnectUnsub = this.#pageRefs[0]?.registerReconnectReconciliation() ?? null
      this.#cursorEventUnsub = cursorRealtime.subscribe(event => {
        if (cursorRealtime.canKeepPrefix(event)) {
          for (const pageRef of this.#pageRefs) pageRef.applyVisibleEvent(event)
        } else {
          this.#pageRefs[0]?.reconcile()
        }
      })
      this.#cursorInvalidationUnsub = cursorRealtime.subscribeToInvalidations(() => {
        this.#pageRefs[0]?.reconcile()
      })
    }
  }

  #setupPage(
    pageIndex: number,
    settle?: { onError: (error: Error) => void },
    after?: PageCursor,
    graph?: QueryGraphRef,
  ): void {
    const queryRef = this.#makePageRef(pageIndex, after)
    this.#pageRefs.push(queryRef)
    let pendingSettle = settle
    const reconcile = this.#reconcile
    let refetchAfterCurrent = Boolean(
      reconcile.phase === 'running' &&
      reconcile.previousQueryIds.has(queryRef.details().queryId) &&
      queryRef.getSnapshot()?.isFetching,
    )

    const onState = (state: ReturnType<(typeof queryRef)['getSnapshot']>): void => {
      if (
        this.#sequential &&
        pageIndex === 0 &&
        state?.isFetching &&
        (this.#pageRefs.length > 1 || this.#reconcile.phase !== 'idle')
      ) {
        this.#beginReconcile()
      }

      // This query id can still belong to a request started by the old cursor
      // chain. Let that attempt settle, then start the request owned by this chain;
      // never advance or expose the old terminal state.
      if (refetchAfterCurrent && state && !state.isFetching) {
        refetchAfterCurrent = false
        queryRef.refetch()
        return
      }

      if (state?.error && !state.isFetching) {
        if (pendingSettle) {
          const settle = pendingSettle
          pendingSettle = undefined
          settle.onError(state.error)
        } else if (this.#reconcile.phase === 'running') {
          this.#abortReconcile(state.error)
        }
      } else if (state?.status === 'success') {
        if (pendingSettle && !state.isFetching) {
          pendingSettle = undefined
          this.#isLoadingMore = false
          this.#loadMoreError = null
          this.#hasMoreSticky = queryRef.getPage().continuation.kind !== 'done'
        } else if (
          !this.#isLoadingMore &&
          !state.isFetching &&
          queryRef === this.#pageRefs.at(-1)
        ) {
          // Only the last page knows whether the chain continues; an earlier
          // page settling (say, after a local realtime merge) always has a cursor.
          this.#hasMoreSticky = queryRef.getPage().continuation.kind !== 'done'
        }
      }

      if (state?.status !== 'success') return
      this.#onRows(this.#allPagesData())
      if (
        !state.error &&
        !state.isFetching &&
        this.#reconcile.phase === 'running' &&
        pageIndex === this.#pageRefs.length - 1
      ) {
        this.#advanceReconcile(pageIndex)
      }
    }

    const unsub = queryRef.subscribe(
      state => {
        onState(state)
        this.#onChange()
      },
      { staleTime: reconcile.phase === 'running' ? 0 : this.#staleTime, graph },
    )
    this.#pageUnsubs.push(unsub)
    onState(queryRef.getSnapshot())
  }

  loadMore(graph?: QueryGraphRef): void {
    if (this.#reconcile.phase === 'failed') {
      // Retry the failed rebuild: page zero fetching restarts it at the depth
      // it was rebuilding.
      this.#pageRefs[0]?.refetch({ graph })
      return
    }
    if (this.#reconcile.phase !== 'idle') return
    if (this.#isLoadingMore || !this.#hasMoreSticky || this.#pageRefs.length === 0) return

    const firstPageState = this.#pageRefs[0]?.getSnapshot()
    if (!firstPageState || firstPageState.status !== 'success') return

    const previousPageState = this.#pageRefs.at(-1)?.getSnapshot()
    if (!previousPageState || previousPageState.status !== 'success') return
    const continuation = this.#pageRefs.at(-1)!.getPage().continuation
    if (continuation.kind === 'done') return
    // Offset pages start where the previous page ended — the server may serve
    // fewer rows per page than pageSize when it caps $limit.
    const after = continuation.kind === 'cursor' ? continuation.cursor : continuation.offset

    this.#isLoadingMore = true
    this.#loadMoreError = null
    this.#setupPage(
      this.#pageRefs.length,
      {
        onError: error => {
          this.#isLoadingMore = false
          this.#loadMoreError = error
          this.#hasMoreSticky = true
          this.#pageRefs.pop()
          this.#pageUnsubs.pop()?.()
        },
      },
      after,
      graph,
    )
    this.#onChange()
  }

  snapshot(): RootSnapshot {
    if (this.#pageRefs.length === 0) return LOADING_ROOT

    const pageStates: QueryState<unknown, TMeta>[] = []
    for (const ref of this.#pageRefs) {
      const state = ref.getSnapshot()
      if (!state) return LOADING_ROOT
      pageStates.push(state)
    }
    for (const state of pageStates) {
      if (state.status === 'error') {
        return { phase: 'error', rows: EMPTY_ROWS, isFetching: false, error: state.error }
      }
    }
    if (pageStates[0]!.status === 'loading') return LOADING_ROOT

    return {
      phase: 'ready',
      rows: this.#allPagesData(),
      isFetching: pageStates.some(state => state.isFetching),
      error: pageStates.find(state => state.error)?.error ?? null,
    }
  }

  metadata(): RootMetadata {
    return {
      continuation: this.#pageRefs.at(-1)?.getPage().continuation ?? { kind: 'done' },
      total: this.#computeTotal(),
    }
  }

  ensureFresh(staleTime?: number, graph?: QueryGraphRef): void {
    if (this.#sequential) {
      this.#pageRefs[0]?.ensureFresh({ staleTime, graph })
      return
    }
    for (const ref of this.#pageRefs) ref.ensureFresh({ staleTime, graph })
  }

  setStaleTime(staleTime: number): void {
    this.#staleTime = staleTime
  }

  pagination(): RelationalPaginationState {
    const hasMore = this.#hasMoreSticky
    const isLoadingMore = this.#isLoadingMore
    const loadMoreError = this.#loadMoreError
    const total = this.#computeTotal()
    const previous = this.#lastPagination
    if (
      previous &&
      previous.hasMore === hasMore &&
      previous.isLoadingMore === isLoadingMore &&
      previous.loadMoreError === loadMoreError &&
      previous.total === total
    ) {
      return previous
    }
    const next = { hasMore, isLoadingMore, loadMoreError, total }
    this.#lastPagination = next
    return next
  }

  inspectPagination(): InspectedPagination {
    const { hasMore, isLoadingMore, total } = this.pagination()
    return {
      strategy: this.#sequential ? 'cursor' : 'offset',
      realtime: this.#realtime,
      pageSize: this.#pageSize,
      includeTotal: this.#includeTotal,
      loadedPages: this.#pageRefs.length,
      hasMore,
      isLoadingMore,
      ...(total !== undefined ? { total } : {}),
    }
  }

  /** Manual refetch deliberately resets the cursor chain to page zero. */
  refetch(graph?: QueryGraphRef): void {
    this.#reconcile = { phase: 'idle' }
    this.#dropFollowupPages()
    this.#hasMoreSticky = true
    this.#isLoadingMore = false
    this.#loadMoreError = null
    this.#pageRefs[0]?.refetch({ graph })
    this.#onChange()
  }

  /**
   * Keep the loaded pages: offset pages reconcile independently, and a sequential
   * chain rebuilds its loaded prefix once page zero starts fetching.
   */
  reconcile(): void {
    for (const pageRef of this.#sequential ? this.#pageRefs.slice(0, 1) : this.#pageRefs) {
      pageRef.reconcile()
    }
  }

  teardown(): void {
    this.#cursorEventUnsub?.()
    this.#cursorEventUnsub = null
    this.#cursorInvalidationUnsub?.()
    this.#cursorInvalidationUnsub = null
    this.#cursorReconnectUnsub?.()
    this.#cursorReconnectUnsub = null
    for (const unsub of this.#pageUnsubs) unsub()
    this.#pageUnsubs.length = 0
    this.#pageRefs.length = 0
    this.#reconcile = { phase: 'idle' }
  }

  queryIds(): string[] {
    return this.#pageRefs.map(ref => ref.details().queryId)
  }

  #computeTotal(): number | undefined {
    if (!this.#includeTotal) return undefined
    return this.#pageRefs[0]?.getPage().total
  }

  #beginReconcile(): void {
    const current = this.#reconcile
    if (current.phase === 'running') {
      if (!current.rerun) this.#reconcile = { ...current, rerun: true }
      return
    }

    const targetPages = current.phase === 'failed' ? current.targetPages : this.#pageRefs.length
    if (targetPages <= 1 && current.phase === 'idle') return
    const rows = current.phase === 'failed' ? current.rows : this.#allPagesData()
    const previousQueryIds =
      current.phase === 'failed'
        ? current.previousQueryIds
        : new Set(this.#pageRefs.slice(1).map(ref => ref.details().queryId))
    this.#reconcile = {
      phase: 'running',
      targetPages,
      rows,
      previousQueryIds,
      rerun: false,
    }
    this.#dropFollowupPages()
    this.#hasMoreSticky = true
    this.#isLoadingMore = false
    this.#loadMoreError = null
    this.#onChange()
  }

  #advanceReconcile(pageIndex: number): void {
    const current = this.#reconcile
    if (current.phase !== 'running') return

    const continuation = this.#pageRefs[pageIndex]!.getPage().continuation
    if (pageIndex + 1 < current.targetPages && continuation.kind === 'cursor') {
      this.#setupPage(pageIndex + 1, undefined, continuation.cursor)
      return
    }

    if (current.rerun) {
      this.#restartReconcile(current)
      return
    }

    this.#reconcile = { phase: 'idle' }
    this.#onRows(this.#allPagesData())
    this.#onChange()
  }

  #restartReconcile(current: Extract<SequentialReconcileState, { phase: 'running' }>): void {
    this.#reconcile = { ...current, rerun: false }
    this.#dropFollowupPages()
    const firstPage = this.#pageRefs[0]?.getSnapshot()
    if (firstPage?.status === 'success' && !firstPage.isFetching) {
      this.#advanceReconcile(0)
    }
  }

  #abortReconcile(error: Error): void {
    const current = this.#reconcile
    if (current.phase !== 'running') return
    this.#reconcile = {
      phase: 'failed',
      targetPages: current.targetPages,
      rows: current.rows,
      previousQueryIds: current.previousQueryIds,
    }
    // Surface the failure where callers already offer a retry; loadMore()
    // restarts the rebuild.
    this.#loadMoreError = error
    this.#onChange()
  }

  #dropFollowupPages(): void {
    for (let index = 1; index < this.#pageUnsubs.length; index++) {
      this.#pageUnsubs[index]?.()
    }
    this.#pageUnsubs.length = Math.min(1, this.#pageUnsubs.length)
    this.#pageRefs.length = Math.min(1, this.#pageRefs.length)
  }

  /** Concatenate all settled pages, preserving identity until a page ref changes. */
  #allPagesData(): unknown[] {
    if (this.#reconcile.phase !== 'idle') return this.#reconcile.rows

    const refs: unknown[] = []
    for (const ref of this.#pageRefs) {
      const state = ref.getSnapshot()
      refs.push(state?.status === 'success' && Array.isArray(state.data) ? state.data : null)
    }
    let unchanged = refs.length === this.#lastPageDataRefs.length
    if (unchanged) {
      for (let index = 0; index < refs.length; index++) {
        if (refs[index] !== this.#lastPageDataRefs[index]) {
          unchanged = false
          break
        }
      }
    }
    if (unchanged) return this.#lastAllPagesData

    const all: unknown[] = []
    for (const ref of refs) {
      if (Array.isArray(ref)) all.push(...ref)
    }
    this.#lastPageDataRefs = refs
    this.#lastAllPagesData = all
    return all
  }
}
