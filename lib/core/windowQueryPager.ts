import type { PageCursor } from '../adapters/adapter.js'
import type { PageContinuation } from '../adapters/queryPage.js'
import type { QueryAST } from './queryBuilder.js'
import type { RelationalRootOverride } from './relationalQuery.js'
import { sameValue } from './valueEquality.js'

export interface PagerRange {
  start: number
  end: number
}

export interface PagerPage {
  start: number
  status: 'idle' | 'loading' | 'success' | 'error'
  rowCount: number
}

export interface PagerPageSuccess {
  start: number
  rowCount: number
  continuation: PageContinuation
  total: number | undefined
}

export interface WindowPagerAccess {
  page(start: number): PagerPage | undefined
  pages(): Iterable<PagerPage>
  ensure(start: number): void
  drop(start: number): void
  touch(start: number): void
  total(): number | undefined
  setTotal(total: number): void
}

export interface WindowPager {
  targetStarts(range: PagerRange, preloadPages: number): number[]
  requiredStarts(range: PagerRange): number[]
  fetchingStarts(range: PagerRange, preloadPages: number): number[]
  rangeReady(range: PagerRange): boolean
  sync(targets: ReadonlySet<number>): void
  protectedStarts(targets: ReadonlySet<number>): ReadonlySet<number>
  rootOverride(start: number): RelationalRootOverride
  pageSucceeded(page: PagerPageSuccess): void
  reset(): void
}

interface WindowPagerContext {
  pageSize: number
  serviceName: string
  ast: QueryAST
  access: WindowPagerAccess
}

function targetStarts(
  range: PagerRange,
  preloadPages: number,
  pageSize: number,
  total: number | undefined,
): number[] {
  const firstVisible = Math.floor(range.start / pageSize) * pageSize
  const lastVisible = Math.floor((Math.max(range.start + 1, range.end) - 1) / pageSize) * pageSize
  const first = Math.max(0, firstVisible - preloadPages * pageSize)
  const last = lastVisible + preloadPages * pageSize
  const starts: number[] = []
  for (let start = first; start <= last; start += pageSize) {
    if (total !== undefined && start >= total) continue
    starts.push(start)
  }
  return starts
}

export class OffsetWindowPager implements WindowPager {
  #context: WindowPagerContext
  // Pages tile the index space at the size the server actually serves, which a
  // server cap (Feathers' paginate.max) can hold below the configured pageSize.
  #pageSize: number

  constructor(context: WindowPagerContext) {
    this.#context = context
    this.#pageSize = context.pageSize
  }

  targetStarts(range: PagerRange, preloadPages: number): number[] {
    return targetStarts(range, preloadPages, this.#pageSize, this.#context.access.total())
  }

  requiredStarts(range: PagerRange): number[] {
    return this.targetStarts(range, 0)
  }

  fetchingStarts(range: PagerRange, preloadPages: number): number[] {
    return this.targetStarts(range, preloadPages)
  }

  rangeReady(range: PagerRange): boolean {
    return this.requiredStarts(range).every(
      start => this.#context.access.page(start)?.status === 'success',
    )
  }

  sync(targets: ReadonlySet<number>): void {
    for (const start of targets) this.#context.access.ensure(start)
  }

  protectedStarts(targets: ReadonlySet<number>): ReadonlySet<number> {
    return targets
  }

  rootOverride(start: number): RelationalRootOverride {
    const { ast, serviceName } = this.#context
    return {
      descriptor: {
        serviceName,
        method: 'find',
        params: {
          query: {
            ...ast.query,
            $limit: this.#pageSize,
            $skip: start,
          },
        },
      },
      config: {
        realtime: ast.snapshot ? 'disabled' : 'merge',
        fetchPolicy: 'swr',
        gcOnUnsubscribe: true,
        ...(ast.server ? { server: true } : {}),
      },
    }
  }

  pageSucceeded(page: PagerPageSuccess): void {
    if (page.total !== undefined) this.#context.access.setTotal(page.total)
    if (page.continuation.kind !== 'offset') return
    const served = page.continuation.offset - page.start
    if (served <= 0 || served >= this.#pageSize) return
    // A capped page leaves a gap before the next planned start. Re-plan at the
    // served size and drop pages that no longer sit on its boundaries.
    this.#pageSize = served
    for (const { start } of Array.from(this.#context.access.pages())) {
      if (start % served !== 0) this.#context.access.drop(start)
    }
  }

  reset(): void {
    this.#pageSize = this.#context.pageSize
  }
}

export class CursorWindowPager implements WindowPager {
  #context: WindowPagerContext
  #cursorAt = new Map<number, PageCursor | undefined>([[0, undefined]])
  #terminalIndex: number | undefined
  #rootChain: Pick<PagerPageSuccess, 'rowCount' | 'continuation' | 'total'> | undefined

  constructor(context: WindowPagerContext) {
    this.#context = context
  }

  targetStarts(range: PagerRange, preloadPages: number): number[] {
    return targetStarts(range, preloadPages, this.#context.pageSize, this.#context.access.total())
  }

  requiredStarts(range: PagerRange): number[] {
    return this.#pagesForRange(range).map(page => page.start)
  }

  fetchingStarts(_range: PagerRange, _preloadPages: number): number[] {
    return Array.from(this.#context.access.pages(), page => page.start)
  }

  rangeReady(range: PagerRange): boolean {
    const knownEnd = Math.min(
      range.end,
      this.#terminalIndex ?? this.#context.access.total() ?? range.end,
    )
    let index = range.start
    while (index < knownEnd) {
      const page = this.#pageCovering(index)
      if (!page || page.status !== 'success') return false
      index = page.start + page.rowCount
    }
    return true
  }

  sync(targets: ReadonlySet<number>): void {
    // Page zero is the cursor chain's total/reconnect sentinel. Other target blocks
    // start directly once their absolute-index checkpoint has been discovered.
    this.#context.access.ensure(0)
    for (const target of targets) {
      const lastIndex = Math.min(
        target + this.#context.pageSize - 1,
        (this.#context.access.total() ?? Infinity) - 1,
      )
      if (lastIndex >= target) this.#ensurePath(lastIndex)
    }
  }

  protectedStarts(targets: ReadonlySet<number>): ReadonlySet<number> {
    const starts = new Set<number>([0])
    for (const target of targets) {
      const targetEnd = target + this.#context.pageSize
      for (const page of this.#context.access.pages()) {
        if (
          page.status === 'success' &&
          page.start < targetEnd &&
          page.start + page.rowCount > target
        ) {
          starts.add(page.start)
        }
      }
      const covering = this.#pageCovering(target)
      if (covering) starts.add(covering.start)
      const lastIndex = Math.min(
        target + this.#context.pageSize - 1,
        (this.#context.access.total() ?? Infinity) - 1,
      )
      const nearest = this.#nearestCheckpoint(lastIndex)
      if (this.#context.access.page(nearest)) starts.add(nearest)
    }
    return starts
  }

  rootOverride(start: number): RelationalRootOverride {
    const cursor = this.#cursorAt.get(start)
    const { ast, pageSize, serviceName } = this.#context
    return {
      descriptor: {
        serviceName,
        method: 'find',
        params: { query: ast.query },
        page: {
          limit: pageSize,
          ...(cursor !== undefined ? { after: cursor } : {}),
          includeTotal: start === 0,
        },
      },
      config: {
        realtime: start === 0 && !ast.snapshot ? 'refetch' : 'disabled',
        fetchPolicy: 'swr',
        gcOnUnsubscribe: true,
        server: true,
      },
    }
  }

  pageSucceeded(page: PagerPageSuccess): void {
    if (page.start === 0) {
      // Later pages hang off page zero's continuation. A value-only change to its
      // rows keeps the chain; a new end cursor, row count, or total invalidates it.
      const chain = { rowCount: page.rowCount, continuation: page.continuation, total: page.total }
      if (this.#rootChain !== undefined && !sameValue(this.#rootChain, chain)) {
        this.#resetDescendants()
      }
      this.#rootChain = chain
    }
    if (page.total !== undefined) {
      this.#context.access.setTotal(page.total)
      this.#terminalIndex = page.total
    }
    if (page.continuation.kind === 'done') {
      this.#terminalIndex = page.start + page.rowCount
      if (this.#context.access.total() === undefined) {
        this.#context.access.setTotal(this.#terminalIndex)
      }
      return
    }
    if (page.rowCount === 0) {
      throw new Error('Native window page reported hasMore without returning rows')
    }
    if (page.continuation.kind === 'cursor') {
      this.#cursorAt.set(page.start + page.rowCount, page.continuation.cursor)
    }
  }

  reset(): void {
    this.#cursorAt = new Map([[0, undefined]])
    this.#terminalIndex = undefined
    this.#rootChain = undefined
  }

  #ensurePath(target: number): void {
    if (this.#terminalIndex !== undefined && target >= this.#terminalIndex) return
    const covering = this.#pageCovering(target)
    if (covering) {
      this.#context.access.touch(covering.start)
      return
    }
    if (this.#cursorAt.has(target)) {
      this.#context.access.ensure(target)
      return
    }
    this.#context.access.ensure(this.#nearestCheckpoint(target))
  }

  #nearestCheckpoint(index: number): number {
    let nearest = 0
    for (const checkpoint of this.#cursorAt.keys()) {
      if (checkpoint <= index && checkpoint > nearest) nearest = checkpoint
    }
    return nearest
  }

  #pageCovering(index: number): PagerPage | undefined {
    for (const page of this.#context.access.pages()) {
      if (page.status === 'success' && page.start <= index && index < page.start + page.rowCount) {
        return page
      }
    }
    return undefined
  }

  #pagesForRange(range: PagerRange): PagerPage[] {
    const pages = new Set<PagerPage>()
    const knownEnd = Math.min(
      range.end,
      this.#terminalIndex ?? this.#context.access.total() ?? range.end,
    )
    let index = range.start
    while (index < knownEnd) {
      const covering = this.#pageCovering(index)
      if (covering) {
        pages.add(covering)
        if (covering.status !== 'success') break
        index = covering.start + covering.rowCount
        continue
      }
      const page = this.#context.access.page(this.#nearestCheckpoint(index))
      if (page) pages.add(page)
      break
    }
    return Array.from(pages)
  }

  #resetDescendants(): void {
    for (const page of Array.from(this.#context.access.pages())) {
      if (page.start > 0) this.#context.access.drop(page.start)
    }
    this.#cursorAt = new Map([[0, undefined]])
    this.#terminalIndex = undefined
  }
}
