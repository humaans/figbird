import { useLayoutEffect } from 'react'
import test from 'ava'
import React, { type ReactNode } from 'react'
import {
  createSchema,
  cursorPagination,
  FeathersAdapter,
  Figbird,
  FigbirdProvider,
  offsetPagination,
  service,
  useQueryResult,
  type FeathersClient,
  type FeathersParams,
  type FeathersService,
  type VisibilitySource,
} from '../lib/index.js'
import { dom, it } from './dom.js'

interface Item {
  id: number
  rank: number
  title?: string
  virtualStatus?: string
}

interface ItemService {
  item: Item
}

const schema = createSchema({ services: { items: service<ItemService>() } })

interface CursorCall {
  query: Record<string, unknown>
}

interface CursorHold {
  promise: Promise<void>
  release(): void
}

function createCursorApp(
  rows: Item[],
  pageSizeWhenFetchingAll = 3,
  {
    visibility,
    retry,
    retryDelay,
    cursorMaxPageSize,
    cursorStability = 'ordering',
  }: {
    visibility?: VisibilitySource
    retry?: number | false
    retryDelay?: number
    cursorMaxPageSize?: number
    cursorStability?: 'ordering' | false
  } = {},
) {
  let serverRows = rows
  const calls: CursorCall[] = []
  const listeners = new Map<string, Set<(item: unknown) => void>>()
  const reconnectListeners = new Set<() => void>()
  const failingCursors = new Set<string>()
  const cursorHolds = new Map<string, CursorHold[]>()
  const cursorService = {
    async find(params: FeathersParams = {}) {
      const query = (params.query ?? {}) as Record<string, unknown>
      calls.push({ query })
      const limit = query.$limit as number
      const cursor = query.$after as string | null
      if (cursor && failingCursors.delete(cursor)) {
        throw new Error(`failed ${cursor}`)
      }
      const start = cursor ? Number(cursor.slice('cursor:'.length)) : 0
      const data = serverRows.slice(start, start + limit)
      const end = start + data.length
      const hasNextPage = end < serverRows.length
      const hold = cursor ? cursorHolds.get(cursor)?.shift() : undefined
      if (hold) await hold.promise
      return {
        data,
        limit,
        hasPreviousPage: cursor !== null,
        hasNextPage,
        startCursor: data.length > 0 ? `cursor:${start}` : null,
        endCursor: data.length > 0 ? `cursor:${end}` : null,
        ...(query.$total ? { total: serverRows.length } : {}),
      }
    },
    on(event: string, listener: (item: unknown) => void) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
    },
    off(event: string, listener: (item: unknown) => void) {
      listeners.get(event)?.delete(listener)
    },
  }
  const feathers: FeathersClient = {
    service: () => cursorService as unknown as FeathersService,
    io: {
      on(event: string, listener: () => void) {
        if (event === 'reconnect') reconnectListeners.add(listener)
      },
      off(event: string, listener: () => void) {
        if (event === 'reconnect') reconnectListeners.delete(listener)
      },
    },
  }
  const adapter = new FeathersAdapter(feathers, {
    defaultPageSizeWhenFetchingAll: pageSizeWhenFetchingAll,
    pagination: {
      items: cursorPagination({
        ...(cursorMaxPageSize !== undefined ? { maxPageSize: cursorMaxPageSize } : {}),
        ...(cursorStability ? { cursorStability } : {}),
      }),
    },
  })
  const figbird = new Figbird({
    schema,
    adapter,
    eventBatchInterval: 0,
    reconcileCooldown: 0,
    reconnectJitter: 0,
    ...(visibility ? { visibility } : {}),
    ...(retry !== undefined ? { retry } : {}),
    ...(retryDelay !== undefined ? { retryDelay } : {}),
  })
  const Provider = FigbirdProvider<typeof schema, typeof adapter>

  function App({ children }: { children?: ReactNode }) {
    return <Provider figbird={figbird}>{children}</Provider>
  }

  return {
    App,
    adapter,
    calls,
    feathers,
    figbird,
    replaceRows(next: Item[]) {
      serverRows = next
    },
    failNextCursor(cursor: string) {
      failingCursors.add(cursor)
    },
    holdNextCursor(cursor: string) {
      let release = () => {}
      const promise = new Promise<void>(resolve => {
        release = resolve
      })
      const holds = cursorHolds.get(cursor) ?? []
      holds.push({ promise, release })
      cursorHolds.set(cursor, holds)
      return release
    },
    emit(event: string, item: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(item)
    },
    emitReconnect() {
      for (const listener of reconnectListeners) listener()
    },
  }
}

function fakeVisibility(initiallyHidden: boolean) {
  let hidden = initiallyHidden
  const listeners = new Set<() => void>()
  return {
    source: {
      isHidden: () => hidden,
      onChange(listener: () => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    } satisfies VisibilitySource,
    set(nextHidden: boolean) {
      hidden = nextHidden
      for (const listener of listeners) listener()
    },
  }
}

function makeRows(count: number): Item[] {
  return Array.from({ length: count }, (_, index) => ({ id: index + 1, rank: index + 1 }))
}

it('cursor paginate: chains opaque cursors and trusts hasNextPage on a full final page', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, calls, figbird } = createCursorApp(makeRows(6))
  let loadMore: (() => void) | undefined

  function List() {
    const result = useQueryResult(
      figbird.q.items.where({ rank: { $gte: 1 } }).paginate({ pageSize: 3, includeTotal: true }),
    )
    useLayoutEffect(() => {
      loadMore = result.loadMore
    })
    return (
      <div
        className='items'
        data-ids={result.data.map(item => item.id).join(',')}
        data-more={String(result.hasMore)}
        data-total={String(result.total)}
      />
    )
  }

  render(
    <App>
      <React.Suspense fallback={<div>loading</div>}>
        <List />
      </React.Suspense>
    </App>,
  )
  await flush()

  t.is($('.items')?.getAttribute('data-ids'), '1,2,3')
  t.is($('.items')?.getAttribute('data-total'), '6')
  t.deepEqual(calls[0]?.query, {
    rank: { $gte: 1 },
    $limit: 3,
    $after: null,
    $total: true,
  })

  await flush(() => loadMore?.())

  t.is($('.items')?.getAttribute('data-ids'), '1,2,3,4,5,6')
  t.is($('.items')?.getAttribute('data-more'), 'false')
  const nextPageCall = calls.find(call => call.query.$after === 'cursor:3')
  t.deepEqual(nextPageCall?.query, {
    rank: { $gte: 1 },
    $limit: 3,
    $after: 'cursor:3',
  })

  const inspectedPages = figbird.inspect().filter(query => query.page)
  t.deepEqual(
    inspectedPages.map(query => query.page),
    [
      {
        request: { limit: 3, includeTotal: true },
        info: { hasMore: true, endCursor: 'cursor:3', total: 6 },
      },
      {
        request: { limit: 3, after: 'cursor:3', includeTotal: false },
        info: { hasMore: false },
      },
    ],
  )
  t.deepEqual(figbird.inspectRelational()[0]?.pagination, {
    strategy: 'cursor',
    realtime: 'reconcile',
    pageSize: 3,
    includeTotal: true,
    loadedPages: 2,
    hasMore: false,
    isLoadingMore: false,
    total: 6,
  })
  unmount()
})

test('cursor paginate: explain reports adapter-native pagination as server-authoritative', t => {
  const { figbird } = createCursorApp(makeRows(3))

  t.deepEqual(figbird.explain(figbird.q.items.paginate({ pageSize: 3 })).nodes[0], {
    path: '(root)',
    service: 'items',
    kind: 'paginate',
    class: 'server-authoritative',
    reasons: [
      {
        code: 'native-pagination',
        detail: 'adapter-native sequential pagination',
      },
    ],
    realtime: 'refetch',
  })
})

test('cursor all: drains every page without requesting a server total', async t => {
  const { adapter, calls } = createCursorApp(makeRows(7), 3)
  const result = await adapter.findAll('items')

  t.deepEqual(
    (result.data as Item[]).map(item => item.id),
    [1, 2, 3, 4, 5, 6, 7],
  )
  t.is(calls.length, 3)
  t.true(calls.every(call => !Object.hasOwn(call.query, '$total')))
  t.is(result.meta.total, 7)
  t.deepEqual(
    calls.map(call => call.query.$after),
    [null, 'cursor:3', 'cursor:6'],
  )
})

test('cursor all: a global default accepts per-service offset overrides', async t => {
  const { calls, feathers } = createCursorApp(makeRows(201))
  const cursor100 = cursorPagination({ maxPageSize: 100 })
  const adapter = new FeathersAdapter(feathers, {
    defaultPageSizeWhenFetchingAll: 2500,
    defaultPagination: cursor100,
  })
  const result = await adapter.findAll('items')

  t.is(result.data.length, 201)
  t.deepEqual(
    calls.map(call => call.query.$limit),
    [100, 100, 100],
  )

  const adapterWithOverride = new FeathersAdapter(feathers, {
    defaultPagination: cursor100,
    pagination: { items: offsetPagination() },
  })
  t.is(adapterWithOverride.pageSource('items'), undefined)
  t.truthy(adapterWithOverride.pageSource('other-items'))
})

test('cursorPagination: validates and enforces the service maximum', async t => {
  t.throws(() => cursorPagination({ maxPageSize: 0 }), {
    message: /maxPageSize must be a positive integer/,
  })
  t.throws(() => cursorPagination({ maxPageSize: 1.5 }), {
    message: /maxPageSize must be a positive integer/,
  })

  const { adapter, calls } = createCursorApp(makeRows(3), 3, {
    cursorMaxPageSize: 2,
  })
  const pageSource = adapter.pageSource('items')
  if (!pageSource) return t.fail('expected items to expose native pagination')
  await t.throwsAsync(pageSource.find(undefined, { limit: 3, includeTotal: false }), {
    message: /accepts at most 2 rows per page, got 3/,
  })
  t.is(calls.length, 0)
})

it('cursor paginate: realtime rebuilds the loaded prefix with a fresh cursor chain', async t => {
  const { render, unmount, flush, $ } = dom()
  const cursorApp = createCursorApp(makeRows(7))
  let loadMore: (() => void) | undefined

  function List() {
    const result = useQueryResult(cursorApp.figbird.q.items.paginate({ pageSize: 3 }))
    useLayoutEffect(() => {
      loadMore = result.loadMore
    })
    return <div className='items' data-ids={result.data.map(item => item.id).join(',')} />
  }

  render(
    <cursorApp.App>
      <React.Suspense fallback={<div>loading</div>}>
        <List />
      </React.Suspense>
    </cursorApp.App>,
  )
  await flush()
  await flush(() => loadMore?.())
  t.is($('.items')?.getAttribute('data-ids'), '1,2,3,4,5,6')

  const inserted = { id: 99, rank: 0 }
  cursorApp.replaceRows([inserted, ...makeRows(7)])
  await flush(async () => {
    cursorApp.emit('created', inserted)
    await new Promise(resolve => setTimeout(resolve, 20))
  })

  t.is($('.items')?.getAttribute('data-ids'), '99,1,2,3,4,5')
  const lastTwoCalls = cursorApp.calls.slice(-2).map(call => call.query.$after)
  t.deepEqual(lastTwoCalls, [null, 'cursor:3'])
  unmount()
})

it('cursor paginate: stable visible updates merge locally; ordering changes rebuild', async t => {
  const { render, unmount, flush, $ } = dom()
  const initialRows = makeRows(7).map(row => ({ ...row, title: `Item ${row.id}` }))
  const cursorApp = createCursorApp(initialRows)
  let loadMore: (() => void) | undefined

  function List() {
    const result = useQueryResult(
      cursorApp.figbird.q.items.orderBy('rank', 'asc').paginate({ pageSize: 3 }),
    )
    useLayoutEffect(() => {
      loadMore = result.loadMore
    })
    return (
      <div
        className='items'
        data-rows={result.data.map(item => `${item.id}:${item.title}`).join(',')}
      />
    )
  }

  render(
    <cursorApp.App>
      <React.Suspense fallback={<div>loading</div>}>
        <List />
      </React.Suspense>
    </cursorApp.App>,
  )
  await flush()
  await flush(() => loadMore?.())

  const callsBeforePatch = cursorApp.calls.length
  t.is(cursorApp.figbird.inspectRelational()[0]?.pagination?.realtime, 'merge-or-reconcile')
  const renamed = { ...initialRows[4]!, title: 'Renamed' }
  cursorApp.replaceRows(initialRows.map(row => (row.id === renamed.id ? renamed : row)))
  await flush(() => cursorApp.emit('patched', renamed))

  t.is(cursorApp.calls.length, callsBeforePatch)
  t.true($('.items')?.getAttribute('data-rows')?.includes('5:Renamed'))

  const reordered = { ...renamed, rank: 0 }
  cursorApp.replaceRows([reordered, ...initialRows.filter(row => row.id !== reordered.id)])
  await flush(async () => {
    cursorApp.emit('patched', reordered)
    await new Promise(resolve => setTimeout(resolve, 20))
  })

  t.is(cursorApp.calls.length, callsBeforePatch + 2)
  t.true($('.items')?.getAttribute('data-rows')?.startsWith('5:Renamed,1:Item 1'))
  unmount()
})

it('cursor paginate: without a cursor stability contract, visible updates rebuild', async t => {
  const { render, unmount, flush } = dom()
  const initialRows = makeRows(3).map(row => ({ ...row, title: `Item ${row.id}` }))
  const cursorApp = createCursorApp(initialRows, 3, { cursorStability: false })

  function List() {
    useQueryResult(cursorApp.figbird.q.items.orderBy('rank', 'asc').paginate({ pageSize: 3 }))
    return null
  }

  render(
    <cursorApp.App>
      <React.Suspense fallback={<div>loading</div>}>
        <List />
      </React.Suspense>
    </cursorApp.App>,
  )
  await flush()

  const callsBeforePatch = cursorApp.calls.length
  const renamed = { ...initialRows[1]!, title: 'Renamed' }
  cursorApp.replaceRows(initialRows.map(row => (row.id === renamed.id ? renamed : row)))
  await flush(async () => {
    cursorApp.emit('patched', renamed)
    await new Promise(resolve => setTimeout(resolve, 20))
  })

  t.is(cursorApp.calls.length, callsBeforePatch + 1)
  unmount()
})

it('cursor paginate: missing server-only inputs make a visible update rebuild', async t => {
  const { render, unmount, flush } = dom()
  const initialRows = makeRows(3).map(row => ({ ...row, title: `Item ${row.id}` }))
  const cursorApp = createCursorApp(initialRows)

  function List() {
    useQueryResult(
      cursorApp.figbird.q.items
        .where({ virtualStatus: 'visible' })
        .orderBy('rank', 'asc')
        .paginate({ pageSize: 3 }),
    )
    return null
  }

  render(
    <cursorApp.App>
      <React.Suspense fallback={<div>loading</div>}>
        <List />
      </React.Suspense>
    </cursorApp.App>,
  )
  await flush()

  const callsBeforePatch = cursorApp.calls.length
  const renamed = { ...initialRows[1]!, title: 'Renamed' }
  cursorApp.replaceRows(initialRows.map(row => (row.id === renamed.id ? renamed : row)))
  await flush(async () => {
    cursorApp.emit('patched', renamed)
    await new Promise(resolve => setTimeout(resolve, 20))
  })

  t.is(cursorApp.calls.length, callsBeforePatch + 1)
  unmount()
})

it('cursor paginate: an old in-flight page never leaks into a rebuilt prefix', async t => {
  const { render, unmount, flush, $ } = dom()
  const cursorApp = createCursorApp(makeRows(7))
  let loadMore: (() => void) | undefined

  function List() {
    const result = useQueryResult(cursorApp.figbird.q.items.paginate({ pageSize: 3 }))
    useLayoutEffect(() => {
      loadMore = result.loadMore
    })
    return <div className='items' data-ids={result.data.map(item => item.id).join(',')} />
  }

  render(
    <cursorApp.App>
      <React.Suspense fallback={<div>loading</div>}>
        <List />
      </React.Suspense>
    </cursorApp.App>,
  )
  await flush()

  const releaseOldPage = cursorApp.holdNextCursor('cursor:3')
  await flush(() => loadMore?.())
  t.is($('.items')?.getAttribute('data-ids'), '1,2,3')

  const inserted = { id: 99, rank: 0 }
  cursorApp.replaceRows([inserted, ...makeRows(7)])
  await flush(async () => {
    cursorApp.emit('created', inserted)
    await new Promise(resolve => setTimeout(resolve, 20))
  })

  const releaseFreshPage = cursorApp.holdNextCursor('cursor:3')
  await flush(async () => {
    releaseOldPage()
    await new Promise(resolve => setTimeout(resolve, 20))
  })

  t.is($('.items')?.getAttribute('data-ids'), '1,2,3')
  t.is(
    cursorApp.calls.filter(call => call.query.$after === 'cursor:3').length,
    2,
    'the fresh page request started without publishing the old response',
  )

  await flush(async () => {
    releaseFreshPage()
    await new Promise(resolve => setTimeout(resolve, 20))
  })

  t.is($('.items')?.getAttribute('data-ids'), '99,1,2,3,4,5')
  unmount()
})

it('cursor paginate: reconnect rebuilds every loaded page from page zero', async t => {
  const { render, unmount, flush, $ } = dom()
  const cursorApp = createCursorApp(makeRows(7))
  let loadMore: (() => void) | undefined

  function List() {
    const result = useQueryResult(cursorApp.figbird.q.items.paginate({ pageSize: 3 }))
    useLayoutEffect(() => {
      loadMore = result.loadMore
    })
    return <div className='items' data-ids={result.data.map(item => item.id).join(',')} />
  }

  render(
    <cursorApp.App>
      <React.Suspense fallback={<div>loading</div>}>
        <List />
      </React.Suspense>
    </cursorApp.App>,
  )
  await flush()
  await flush(() => loadMore?.())

  cursorApp.replaceRows([{ id: 99, rank: 0 }, ...makeRows(7)])
  await flush(async () => {
    cursorApp.emitReconnect()
    await new Promise(resolve => setTimeout(resolve, 20))
  })

  t.is($('.items')?.getAttribute('data-ids'), '99,1,2,3,4,5')
  t.deepEqual(
    cursorApp.calls.slice(-2).map(call => call.query.$after),
    [null, 'cursor:3'],
  )
  unmount()
})

it('cursor paginate: hidden reconnect waits, then rebuilds on visibility', async t => {
  const { render, unmount, flush, $ } = dom()
  const visibility = fakeVisibility(false)
  const cursorApp = createCursorApp(makeRows(7), 3, { visibility: visibility.source })
  let loadMore: (() => void) | undefined

  function List() {
    const result = useQueryResult(cursorApp.figbird.q.items.paginate({ pageSize: 3 }))
    useLayoutEffect(() => {
      loadMore = result.loadMore
    })
    return <div className='items' data-ids={result.data.map(item => item.id).join(',')} />
  }

  render(
    <cursorApp.App>
      <React.Suspense fallback={<div>loading</div>}>
        <List />
      </React.Suspense>
    </cursorApp.App>,
  )
  await flush()
  await flush(() => loadMore?.())
  const baselineCalls = cursorApp.calls.length

  visibility.set(true)
  cursorApp.replaceRows([{ id: 99, rank: 0 }, ...makeRows(7)])
  cursorApp.emitReconnect()
  await new Promise(resolve => setTimeout(resolve, 20))

  t.is(cursorApp.calls.length, baselineCalls)
  t.is($('.items')?.getAttribute('data-ids'), '1,2,3,4,5,6')

  await flush(async () => {
    visibility.set(false)
    await new Promise(resolve => setTimeout(resolve, 20))
  })

  t.is($('.items')?.getAttribute('data-ids'), '99,1,2,3,4,5')
  t.is(cursorApp.calls.length, baselineCalls + 2)
  unmount()
})

it('cursor paginate: failed prefix rebuild stays atomic and retries its depth', async t => {
  const { render, unmount, flush, $ } = dom()
  const cursorApp = createCursorApp(makeRows(7), 3, { retry: false })
  let loadMore: (() => void) | undefined

  function List() {
    const result = useQueryResult(cursorApp.figbird.q.items.paginate({ pageSize: 3 }))
    useLayoutEffect(() => {
      loadMore = result.loadMore
    })
    return <div className='items' data-ids={result.data.map(item => item.id).join(',')} />
  }

  render(
    <cursorApp.App>
      <React.Suspense fallback={<div>loading</div>}>
        <List />
      </React.Suspense>
    </cursorApp.App>,
  )
  await flush()
  await flush(() => loadMore?.())

  const firstInserted = { id: 99, rank: 0 }
  cursorApp.failNextCursor('cursor:3')
  cursorApp.replaceRows([firstInserted, ...makeRows(7)])
  await flush(async () => {
    cursorApp.emit('created', firstInserted)
    await new Promise(resolve => setTimeout(resolve, 20))
  })

  t.is($('.items')?.getAttribute('data-ids'), '1,2,3,4,5,6')

  const secondInserted = { id: 100, rank: -1 }
  cursorApp.replaceRows([secondInserted, firstInserted, ...makeRows(7)])
  await flush(async () => {
    cursorApp.emit('created', secondInserted)
    await new Promise(resolve => setTimeout(resolve, 20))
  })

  t.is($('.items')?.getAttribute('data-ids'), '100,99,1,2,3,4')
  t.deepEqual(
    cursorApp.calls.slice(-2).map(call => call.query.$after),
    [null, 'cursor:3'],
  )
  unmount()
})

it('cursor paginate: automatic fetch retry stays inside the frozen rebuild', async t => {
  const { render, unmount, flush, $ } = dom()
  const cursorApp = createCursorApp(makeRows(7), 3, { retry: 1, retryDelay: 0 })
  let loadMore: (() => void) | undefined

  function List() {
    const result = useQueryResult(cursorApp.figbird.q.items.paginate({ pageSize: 3 }))
    useLayoutEffect(() => {
      loadMore = result.loadMore
    })
    return <div className='items' data-ids={result.data.map(item => item.id).join(',')} />
  }

  render(
    <cursorApp.App>
      <React.Suspense fallback={<div>loading</div>}>
        <List />
      </React.Suspense>
    </cursorApp.App>,
  )
  await flush()
  await flush(() => loadMore?.())

  const inserted = { id: 99, rank: 0 }
  cursorApp.failNextCursor('cursor:3')
  cursorApp.replaceRows([inserted, ...makeRows(7)])
  await flush(async () => {
    cursorApp.emit('created', inserted)
    await new Promise(resolve => setTimeout(resolve, 20))
  })

  t.is($('.items')?.getAttribute('data-ids'), '99,1,2,3,4,5')
  t.deepEqual(
    cursorApp.calls.slice(-3).map(call => call.query.$after),
    [null, 'cursor:3', 'cursor:3'],
  )
  unmount()
})

test('cursor pagination: rejects a response that cannot continue safely', async t => {
  const feathers: FeathersClient = {
    service: () =>
      ({
        find: async () => ({ data: [], hasNextPage: true, endCursor: null }),
      }) as unknown as FeathersService,
  }
  const adapter = new FeathersAdapter(feathers, {
    pagination: { items: cursorPagination() },
  })
  const pageSource = adapter.pageSource('items')
  if (!pageSource) return t.fail('expected items to expose native pagination')

  await t.throwsAsync(pageSource.find(undefined, { limit: 10, includeTotal: false }), {
    message: /no endCursor/,
  })
})
