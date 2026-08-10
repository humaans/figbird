import test from 'ava'
import React, { type ReactNode } from 'react'
import {
  createSchema,
  cursorPagination,
  FeathersAdapter,
  Figbird,
  FigbirdProvider,
  service,
  useQuery,
  type FeathersClient,
  type FeathersParams,
  type FeathersService,
  type VisibilitySource,
} from '../lib/index.js'
import { dom } from './helpers.js'

interface Item {
  id: number
  rank: number
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
    cursorPageSizeWhenFetchingAll,
  }: {
    visibility?: VisibilitySource
    retry?: number | false
    retryDelay?: number
    cursorPageSizeWhenFetchingAll?: number
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
      const limit = query.cursorLimit as number
      const cursor = query.cursor as string | undefined
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
        pageInfo: {
          hasNextPage,
          endCursor: hasNextPage ? `cursor:${end}` : null,
          ...(query.returnTotal ? { total: serverRows.length } : {}),
        },
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
        ...(cursorPageSizeWhenFetchingAll !== undefined
          ? { pageSizeWhenFetchingAll: cursorPageSizeWhenFetchingAll }
          : {}),
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

test('cursor paginate: chains opaque cursors and trusts hasNextPage on a full final page', async t => {
  const { render, unmount, flush, $ } = dom()
  const { App, calls, figbird } = createCursorApp(makeRows(6))
  let loadMore: (() => void) | undefined

  function List() {
    const result = useQuery(
      figbird.q.items.where({ rank: { $gte: 1 } }).paginate({ pageSize: 3, returnTotal: true }),
    )
    loadMore = result.loadMore
    return (
      <div
        className='items'
        data-ids={result.data.map(item => item.id).join(',')}
        data-more={String(result.hasMore)}
        data-total={String(result.totalCount)}
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
    cursorLimit: 3,
    returnCursor: true,
    returnTotal: true,
  })

  await flush(() => loadMore?.())

  t.is($('.items')?.getAttribute('data-ids'), '1,2,3,4,5,6')
  t.is($('.items')?.getAttribute('data-more'), 'false')
  const nextPageCall = calls.find(call => call.query.cursor === 'cursor:3')
  t.deepEqual(nextPageCall?.query, {
    rank: { $gte: 1 },
    cursorLimit: 3,
    returnCursor: true,
    cursor: 'cursor:3',
  })
  unmount()
})

test('cursor all: drains every page and only requests the total on page one', async t => {
  const { calls, figbird } = createCursorApp(makeRows(7), 3)
  const ref = figbird.query(figbird.q.items.all())
  const unsub = ref.subscribe(() => {})

  await new Promise(resolve => setTimeout(resolve, 10))

  t.deepEqual(
    (ref.getSnapshot().data as Item[]).map(item => item.id),
    [1, 2, 3, 4, 5, 6, 7],
  )
  t.is(calls.length, 3)
  t.true(calls[0]?.query.returnTotal === true)
  t.false(Object.hasOwn(calls[1]?.query ?? {}, 'returnTotal'))
  t.false(Object.hasOwn(calls[2]?.query ?? {}, 'returnTotal'))
  t.deepEqual(
    calls.map(call => call.query.cursor),
    [undefined, 'cursor:3', 'cursor:6'],
  )
  unsub()
})

test('cursor all: a per-service page size overrides the adapter-wide default', async t => {
  const { calls, figbird } = createCursorApp(makeRows(201), 2500, {
    cursorPageSizeWhenFetchingAll: 100,
  })
  const ref = figbird.query(figbird.q.items.all())
  const unsub = ref.subscribe(() => {})

  await new Promise(resolve => setTimeout(resolve, 10))

  t.is((ref.getSnapshot().data as Item[]).length, 201)
  t.deepEqual(
    calls.map(call => call.query.cursorLimit),
    [100, 100, 100],
  )
  unsub()
})

test('cursorPagination: rejects an invalid all-page size', t => {
  t.throws(() => cursorPagination({ pageSizeWhenFetchingAll: 0 }), {
    message: /pageSizeWhenFetchingAll/,
  })
})

test('cursor paginate: realtime rebuilds the loaded prefix with a fresh cursor chain', async t => {
  const { render, unmount, flush, $ } = dom()
  const cursorApp = createCursorApp(makeRows(7))
  let loadMore: (() => void) | undefined

  function List() {
    const result = useQuery(cursorApp.figbird.q.items.paginate({ pageSize: 3 }))
    loadMore = result.loadMore
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
  const lastTwoCalls = cursorApp.calls.slice(-2).map(call => call.query.cursor)
  t.deepEqual(lastTwoCalls, [undefined, 'cursor:3'])
  unmount()
})

test('cursor paginate: an old in-flight page never leaks into a rebuilt prefix', async t => {
  const { render, unmount, flush, $ } = dom()
  const cursorApp = createCursorApp(makeRows(7))
  let loadMore: (() => void) | undefined

  function List() {
    const result = useQuery(cursorApp.figbird.q.items.paginate({ pageSize: 3 }))
    loadMore = result.loadMore
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
    cursorApp.calls.filter(call => call.query.cursor === 'cursor:3').length,
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

test('cursor paginate: reconnect rebuilds every loaded page from page zero', async t => {
  const { render, unmount, flush, $ } = dom()
  const cursorApp = createCursorApp(makeRows(7))
  let loadMore: (() => void) | undefined

  function List() {
    const result = useQuery(cursorApp.figbird.q.items.paginate({ pageSize: 3 }))
    loadMore = result.loadMore
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
    cursorApp.calls.slice(-2).map(call => call.query.cursor),
    [undefined, 'cursor:3'],
  )
  unmount()
})

test('cursor paginate: hidden reconnect waits, then rebuilds on visibility', async t => {
  const { render, unmount, flush, $ } = dom()
  const visibility = fakeVisibility(false)
  const cursorApp = createCursorApp(makeRows(7), 3, { visibility: visibility.source })
  let loadMore: (() => void) | undefined

  function List() {
    const result = useQuery(cursorApp.figbird.q.items.paginate({ pageSize: 3 }))
    loadMore = result.loadMore
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

test('cursor paginate: failed prefix rebuild stays atomic and retries its depth', async t => {
  const { render, unmount, flush, $ } = dom()
  const cursorApp = createCursorApp(makeRows(7), 3, { retry: false })
  let loadMore: (() => void) | undefined

  function List() {
    const result = useQuery(cursorApp.figbird.q.items.paginate({ pageSize: 3 }))
    loadMore = result.loadMore
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
    cursorApp.calls.slice(-2).map(call => call.query.cursor),
    [undefined, 'cursor:3'],
  )
  unmount()
})

test('cursor paginate: automatic fetch retry stays inside the frozen rebuild', async t => {
  const { render, unmount, flush, $ } = dom()
  const cursorApp = createCursorApp(makeRows(7), 3, { retry: 1, retryDelay: 0 })
  let loadMore: (() => void) | undefined

  function List() {
    const result = useQuery(cursorApp.figbird.q.items.paginate({ pageSize: 3 }))
    loadMore = result.loadMore
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
    cursorApp.calls.slice(-3).map(call => call.query.cursor),
    [undefined, 'cursor:3', 'cursor:3'],
  )
  unmount()
})

test('cursor pagination: rejects a response that cannot continue safely', async t => {
  const feathers: FeathersClient = {
    service: () =>
      ({
        find: async () => ({ data: [], pageInfo: { hasNextPage: true, endCursor: null } }),
      }) as unknown as FeathersService,
  }
  const adapter = new FeathersAdapter(feathers, {
    pagination: { items: cursorPagination() },
  })
  const pageSource = adapter.pageSource('items')
  if (!pageSource) return t.fail('expected items to expose native pagination')

  await t.throwsAsync(pageSource.find(undefined, { limit: 10, returnTotal: false }), {
    message: /no pageInfo\.endCursor/,
  })
})
