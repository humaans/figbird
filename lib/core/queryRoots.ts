import type { PageCursor, PageInfo } from '../adapters/adapter.js'
import type { QueryRef } from './queryRef.js'
import type { ProcessedRealtimeEvent, QueryState } from './queryTypes.js'
import type { AnySchema, Schema } from './schema.js'

/** The relational engine's adapter-neutral view of its root rows. */
export interface RootSnapshot {
  phase: 'loading' | 'error' | 'ready'
  /** Valid when phase is 'ready'. Identity is stable while the underlying data is. */
  rows: unknown[]
  isFetching: boolean
  error: Error | null
}

/** Common lifecycle for a single-query root and an accumulating page root. */
export interface RootSource {
  snapshot(): RootSnapshot
  setStaleTime(staleTime: number): void
  ensureFresh(staleTime?: number): void
  refetch(): void
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
  loadMore(): void
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

/**
 * Store listeners fire only on changes. Seed from the current state as well so a
 * query already warmed by another consumer does not look cold until its SWR fetch
 * settles.
 */
export function subscribeAndSeed<
  S extends Schema,
  TParams,
  TMeta extends Record<string, unknown>,
  TQuery,
>(
  queryRef: QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery>,
  onSuccess: (data: unknown[]) => void,
  onChange: () => void,
  staleTime = 0,
): () => void {
  const unsub = queryRef.subscribe(
    state => {
      if (state.status === 'success') onSuccess(state.data as unknown[])
      onChange()
    },
    { staleTime },
  )
  const initial = queryRef.getSnapshot()
  if (initial?.status === 'success') onSuccess(initial.data as unknown[])
  return unsub
}

/** Root backed by one find or get query. */
export class SingleQueryRoot<
  S extends Schema = AnySchema,
  TParams = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TQuery = Record<string, unknown>,
> implements RootSource {
  #queryRef: QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery>
  #unsub: () => void
  #isGet: boolean
  #lastGetData: unknown = undefined
  #lastGetDataAsArray: unknown[] = []

  constructor({
    queryRef,
    isGet,
    onRows,
    onChange,
    staleTime = 0,
  }: {
    queryRef: QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery>
    isGet: boolean
    onRows: (rows: unknown[]) => void
    onChange: () => void
    staleTime?: number
  }) {
    this.#queryRef = queryRef
    this.#isGet = isGet
    this.#unsub = subscribeAndSeed(
      queryRef,
      data => onRows(this.#asRows(data)),
      onChange,
      staleTime,
    )
  }

  #asRows(data: unknown): unknown[] {
    if (!this.#isGet) return data as unknown[]
    if (data === this.#lastGetData) return this.#lastGetDataAsArray
    this.#lastGetData = data
    this.#lastGetDataAsArray = data == null ? [] : [data]
    return this.#lastGetDataAsArray
  }

  snapshot(): RootSnapshot {
    const state = this.#queryRef.getSnapshot()
    if (!state || state.status === 'loading') return LOADING_ROOT
    if (state.status === 'error') {
      return { phase: 'error', rows: EMPTY_ROWS, isFetching: false, error: state.error }
    }
    return {
      phase: 'ready',
      rows: this.#asRows(state.data),
      isFetching: state.isFetching,
      error: null,
    }
  }

  ensureFresh(staleTime?: number): void {
    this.#queryRef.ensureFresh({ staleTime })
  }

  setStaleTime(_staleTime: number): void {}

  refetch(): void {
    this.#queryRef.refetch()
  }

  teardown(): void {
    this.#unsub()
  }

  queryIds(): string[] {
    return [this.#queryRef.details().queryId]
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
  S extends Schema = AnySchema,
  TParams = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TQuery = Record<string, unknown>,
> implements PaginatedRootSource {
  #makePageRef: (
    pageIndex: number,
    after?: PageCursor,
  ) => QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery>
  #onRows: (rows: unknown[]) => void
  #onChange: () => void
  #pageSize: number
  #includeTotal: boolean
  #sequential: boolean
  #realtime: InspectedPagination['realtime']

  #pageRefs: Array<QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery>> = []
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
  }: {
    pageSize: number
    includeTotal: boolean
    sequential: boolean
    makePageRef: (
      pageIndex: number,
      after?: PageCursor,
    ) => QueryRef<unknown[], unknown, S, TParams, TMeta, TQuery>
    onRows: (rows: unknown[]) => void
    onChange: () => void
    cursorRealtime?: {
      subscribe(fn: (event: ProcessedRealtimeEvent) => void): () => void
      canKeepPrefix(event: ProcessedRealtimeEvent): boolean
    }
    realtime: InspectedPagination['realtime']
    staleTime?: number
  }) {
    this.#pageSize = pageSize
    this.#includeTotal = includeTotal
    this.#sequential = sequential
    this.#realtime = realtime
    this.#makePageRef = makePageRef
    this.#onRows = onRows
    this.#onChange = onChange
    this.#staleTime = staleTime
    this.#setupPage(0)
    if (cursorRealtime) {
      this.#cursorReconnectUnsub = this.#pageRefs[0]?.registerReconnectReconciliation() ?? null
      this.#cursorEventUnsub = cursorRealtime.subscribe(event => {
        if (cursorRealtime.canKeepPrefix(event)) {
          for (const pageRef of this.#pageRefs) pageRef.applyVisibleEvent(event)
        } else {
          this.#pageRefs[0]?.reconcile()
        }
      })
    }
  }

  #setupPage(
    pageIndex: number,
    settle?: { onError: (error: Error) => void },
    after?: PageCursor,
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

      if (state?.status === 'success') {
        const pageData = (state.data ?? []) as unknown[]
        if (pendingSettle && !state.isFetching) {
          pendingSettle = undefined
          this.#isLoadingMore = false
          this.#loadMoreError = null
          this.#hasMoreSticky = this.#pageHasMore(state, pageData)
        } else if (!this.#isLoadingMore && !state.isFetching) {
          this.#hasMoreSticky = this.#pageHasMore(state, pageData)
        }
        this.#onRows(this.#allPagesData())
        if (
          this.#reconcile.phase === 'running' &&
          !state.isFetching &&
          pageIndex === this.#pageRefs.length - 1
        ) {
          this.#advanceReconcile(pageIndex, state)
        }
      } else if (state?.status === 'error' && pendingSettle) {
        const currentSettle = pendingSettle
        pendingSettle = undefined
        currentSettle.onError(state.error)
      } else if (state?.status === 'error' && this.#reconcile.phase === 'running') {
        this.#abortReconcile()
      }
    }

    const unsub = queryRef.subscribe(
      state => {
        onState(state)
        this.#onChange()
      },
      { staleTime: reconcile.phase === 'running' ? 0 : this.#staleTime },
    )
    this.#pageUnsubs.push(unsub)
    onState(queryRef.getSnapshot())
  }

  loadMore(): void {
    if (this.#reconcile.phase !== 'idle') return
    if (this.#isLoadingMore || !this.#hasMoreSticky || this.#pageRefs.length === 0) return

    const firstPageState = this.#pageRefs[0]?.getSnapshot()
    if (!firstPageState || firstPageState.status !== 'success') return

    const previousPageState = this.#pageRefs.at(-1)?.getSnapshot()
    if (!previousPageState || previousPageState.status !== 'success') return
    const pageInfo = this.#sequential ? this.#requirePageInfo(previousPageState) : undefined
    if (pageInfo && !pageInfo.hasMore) return
    const after = pageInfo?.endCursor

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
      error: null,
    }
  }

  ensureFresh(staleTime?: number): void {
    if (this.#sequential) {
      this.#pageRefs[0]?.ensureFresh({ staleTime })
      return
    }
    for (const ref of this.#pageRefs) ref.ensureFresh({ staleTime })
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
  refetch(): void {
    this.#reconcile = { phase: 'idle' }
    this.#dropFollowupPages()
    this.#hasMoreSticky = true
    this.#isLoadingMore = false
    this.#loadMoreError = null
    this.#pageRefs[0]?.refetch()
    this.#onChange()
  }

  teardown(): void {
    this.#cursorEventUnsub?.()
    this.#cursorEventUnsub = null
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
    const state = this.#pageRefs[0]?.getSnapshot()
    if (!state || state.status !== 'success') return undefined
    if (state.pageInfo && typeof state.pageInfo.total === 'number' && state.pageInfo.total >= 0) {
      return state.pageInfo.total
    }
    const meta = state.meta as { total?: number } | undefined
    if (!meta || typeof meta.total !== 'number' || meta.total < 0) return undefined
    return meta.total
  }

  #pageHasMore(state: QueryState<unknown, TMeta>, data: unknown[]): boolean {
    if (this.#sequential) return this.#requirePageInfo(state).hasMore
    return data.length >= this.#pageSize
  }

  #requirePageInfo(state: QueryState<unknown, TMeta>): PageInfo {
    if (!state.pageInfo) {
      throw new Error('Native page query settled without pageInfo')
    }
    return state.pageInfo
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

  #advanceReconcile(pageIndex: number, state: QueryState<unknown, TMeta>): void {
    const current = this.#reconcile
    if (current.phase !== 'running') return

    const pageInfo = this.#requirePageInfo(state)
    if (pageIndex + 1 < current.targetPages && pageInfo.hasMore) {
      this.#setupPage(pageIndex + 1, undefined, pageInfo.endCursor)
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
      this.#advanceReconcile(0, firstPage)
    }
  }

  #abortReconcile(): void {
    const current = this.#reconcile
    if (current.phase !== 'running') return
    this.#reconcile = {
      phase: 'failed',
      targetPages: current.targetPages,
      rows: current.rows,
      previousQueryIds: current.previousQueryIds,
    }
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
