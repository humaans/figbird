import { useLayoutEffect } from 'react'
import test from 'ava'
import { Suspense, useState } from 'react'
import {
  createSchema,
  cursorPagination,
  FeathersAdapter,
  Figbird,
  service,
  useWindowQuery,
  type FeathersClient,
  type FeathersParams,
  type FeathersService,
  type WindowQueryState,
  type WindowRange,
} from '../lib/index.js'
import { dom, it } from './dom.js'
import { createTestApp } from './helpers.js'

interface Item {
  [key: string]: unknown
  id: number
  ownerId: number
  rank: number
  title: string
}

interface ItemService {
  item: Item
}

interface Owner {
  id: number
  name: string
}

interface OwnerService {
  item: Owner
}

const schema = createSchema({
  services: {
    items: service<ItemService>(),
    owners: service<OwnerService>(),
  },
  relationships: {
    items: ({ one }) => ({
      owner: one({ sourceField: 'ownerId', destService: 'owners', destField: 'id' }),
    }),
  },
})

function makeRows(count: number): Item[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    ownerId: (index % 2) + 1,
    rank: index + 1,
    title: `Item ${index + 1}`,
  }))
}

function keyed<T extends { id: number }>(rows: T[]): Record<string, T> {
  return Object.fromEntries(rows.map(row => [row.id, row]))
}

interface TestWindowRef<T> {
  subscribe(
    listener: (state: WindowQueryState<T>) => void,
    options: { range: WindowRange; staleTime?: number },
  ): () => void
  getSnapshot(range: WindowRange): WindowQueryState<T>
  refetch(): void
}

function readSettledWindow<T>(ref: TestWindowRef<T>, range: WindowRange, staleTime?: number) {
  let unsubscribe = () => {}
  const promise = new Promise<WindowQueryState<T>>(resolve => {
    const check = () => {
      const state = ref.getSnapshot(range)
      if (state.status === 'error' || (state.status === 'success' && !state.isFetching)) {
        resolve(state)
      }
    }
    unsubscribe = ref.subscribe(check, { range, ...(staleTime !== undefined ? { staleTime } : {}) })
    check()
  })
  return { promise, unsubscribe: () => unsubscribe() }
}

test('window query: offset jumps directly, assembles relations, and evicts distant pages', async t => {
  const rows = makeRows(120)
  const { figbird } = createTestApp(schema, {
    items: { data: keyed(rows) },
    owners: {
      data: {
        1: { id: 1, name: 'Ada' },
        2: { id: 2, name: 'Grace' },
      },
    },
  })
  const ref = figbird.window(figbird.q.items.orderBy('rank', 'asc').related('owner'), {
    pageSize: 10,
    preloadPages: 1,
    maxPages: 3,
  })

  const first = readSettledWindow(ref, { start: 50, end: 55 })
  const firstState = await first.promise
  t.is(firstState.status, 'success')
  if (firstState.status !== 'success') return
  t.is(firstState.total, 120)
  t.is(firstState.data.get(50)?.id, 51)
  t.is(firstState.data.get(50)?.owner?.name, 'Ada')
  t.deepEqual(
    figbird
      .inspect()
      .filter(query => query.serviceName === 'items')
      .map(query => query.query?.$skip)
      .sort((a, b) => Number(a) - Number(b)),
    [40, 50, 60],
  )

  first.unsubscribe()
  const second = readSettledWindow(ref, { start: 90, end: 95 })
  const secondState = await second.promise
  await new Promise<void>(resolve => queueMicrotask(() => resolve()))
  t.is(secondState.status, 'success')
  t.true(ref.getSnapshot({ start: 90, end: 95 }).data.size <= 30)
  t.is(ref.getSnapshot({ start: 90, end: 95 }).data.get(90)?.id, 91)
  t.is(ref.getSnapshot({ start: 90, end: 95 }).data.get(90)?.owner?.name, 'Ada')
  second.unsubscribe()
})

test('window query: retention never evicts pages required by active readers', async t => {
  const { figbird } = createTestApp(schema, {
    items: { data: keyed(makeRows(80)) },
    owners: { data: {} },
  })
  const ref = figbird.window(figbird.q.items.orderBy('rank', 'asc'), {
    pageSize: 10,
    preloadPages: 0,
    maxPages: 1,
  })

  const top = readSettledWindow(ref, { start: 0, end: 5 })
  const deep = readSettledWindow(ref, { start: 50, end: 55 })
  await Promise.all([top.promise, deep.promise])

  const data = ref.getSnapshot({ start: 0, end: 5 }).data
  t.is(data.get(0)?.id, 1)
  t.is(data.get(50)?.id, 51)
  t.is(data.size, 20)
  top.unsubscribe()
  deep.unsubscribe()
})

test('window query: concurrent cold reads stay warm beyond the page retention budget', async t => {
  const { figbird, feathers } = createTestApp(schema, {
    items: { data: keyed(makeRows(80)) },
    owners: { data: {} },
  })
  const ref = figbird.window(figbird.q.items.orderBy('rank', 'asc'), {
    pageSize: 10,
    preloadPages: 0,
    maxPages: 1,
  })
  const top = { start: 0, end: 5 }
  const deep = { start: 50, end: 55 }

  await Promise.all([ref.suspensePromise(top), ref.suspensePromise(deep)])
  await new Promise<void>(resolve => queueMicrotask(resolve))

  t.is(ref.getSnapshot(top).status, 'success')
  t.is(ref.getSnapshot(deep).status, 'success')
  t.is(feathers.service('items').counts.find, 2)

  await ref.suspensePromise(top)
  t.is(feathers.service('items').counts.find, 2)
  ref.releaseColdStart(top)
  ref.releaseColdStart(deep)
})

test('window query: settled cold reads survive delayed retries and remain bounded', async t => {
  const { figbird, feathers } = createTestApp(schema, {
    items: { data: keyed(makeRows(20)) },
    owners: { data: {} },
  })
  const query = figbird.q.items.orderBy('rank', 'asc')
  const config = { pageSize: 10, preloadPages: 0, maxPages: 2 }
  const abandoned = figbird.window(query, config)

  await abandoned.suspensePromise({ start: 0, end: 5 })
  await new Promise(resolve => setTimeout(resolve, 10))
  const retry = figbird.window(query, config)

  t.is(retry, abandoned)
  t.is(retry.getSnapshot({ start: 0, end: 5 }).status, 'success')
  t.is(feathers.service('items').counts.find, 1)

  const pressure = Array.from({ length: 20 }, (_, index) => {
    const ref = figbird.window(query, {
      pageSize: 100 + index,
      preloadPages: 0,
      maxPages: 2,
    })
    return ref.suspensePromise({ start: 0, end: 1 })
  })
  await Promise.all(pressure)

  t.not(figbird.window(query, config), abandoned)
})

test('window query: abandoned ranges have a separate bounded retry cache', async t => {
  const { figbird } = createTestApp(schema, {
    items: { data: keyed(makeRows(240)) },
    owners: { data: {} },
  })
  const ref = figbird.window(figbird.q.items.orderBy('rank', 'asc'), {
    pageSize: 10,
    preloadPages: 0,
    maxPages: 1,
  })
  const visible = readSettledWindow(ref, { start: 0, end: 5 })
  await visible.promise

  const abandonedRanges = Array.from({ length: 21 }, (_, index) => ({
    start: (index + 1) * 10,
    end: (index + 1) * 10 + 5,
  }))
  for (const range of abandonedRanges) await ref.suspensePromise(range)
  await new Promise<void>(resolve => queueMicrotask(resolve))

  const data = ref.getSnapshot({ start: 0, end: 5 }).data
  t.is(data.size, 210)
  t.is(data.get(0)?.id, 1)
  t.false(data.has(10))
  t.is(data.get(210)?.id, 211)

  for (const range of abandonedRanges) ref.releaseColdStart(range)
  visible.unsubscribe()
})

test('window query: retained pages follow the strictest active reader', async t => {
  const { figbird, feathers } = createTestApp(schema, {
    items: { data: keyed(makeRows(20)) },
    owners: { data: {} },
  })
  const range = { start: 0, end: 5 }
  const ref = figbird.window(figbird.q.items.orderBy('rank', 'asc'), {
    pageSize: 10,
    preloadPages: 0,
    maxPages: 2,
  })
  const lenient = readSettledWindow(ref, range)
  await lenient.promise
  const service = feathers.service('items')
  const initialFetches = service.counts.find

  const addStrictReader = (expectedFetches: number) => {
    let unsubscribe = () => {}
    const settled = new Promise<void>(resolve => {
      const check = () => {
        const state = ref.getSnapshot(range)
        if (
          service.counts.find >= expectedFetches &&
          state.status === 'success' &&
          !state.isFetching
        ) {
          resolve()
        }
      }
      unsubscribe = ref.subscribe(check, { range, staleTime: 0 })
      check()
    })
    return { settled, unsubscribe: () => unsubscribe() }
  }

  const firstStrict = addStrictReader(initialFetches + 1)
  await firstStrict.settled
  t.is(service.counts.find, initialFetches + 1)
  firstStrict.unsubscribe()
  await new Promise<void>(resolve => queueMicrotask(resolve))

  const secondStrict = addStrictReader(initialFetches + 2)
  await secondStrict.settled
  t.is(service.counts.find, initialFetches + 2)

  secondStrict.unsubscribe()
  lenient.unsubscribe()
})

it('useWindowQuery: each hook gets an independent first-window Suspense lifecycle', async t => {
  const rows = makeRows(80)
  const { App, feathers, figbird } = createTestApp(schema, {
    items: { data: keyed(rows) },
    owners: { data: {} },
  })
  const { render, flush, act, $, unmount } = dom()
  let showSecond = () => {}
  let moveFirst = () => {}
  const query = figbird.q.items.orderBy('rank', 'asc')
  const config = { pageSize: 10, preloadPages: 0, maxPages: 3 }
  const ref = figbird.window(query, config)

  function Reader({ className, range }: { className: string; range: WindowRange }) {
    const options = { ...config, range }
    const tagged = useWindowQuery(query, { ...options, suspense: false })
    const { data, error } = useWindowQuery(query, options)
    return (
      <div className={className} data-status={tagged.status} data-error={error?.message}>
        {Array.from(data.values(), row => row.id).join(',')}
      </div>
    )
  }

  function Harness() {
    const [second, setSecond] = useState(false)
    const [firstStart, setFirstStart] = useState(0)
    useLayoutEffect(() => {
      showSecond = () => setSecond(true)
      moveFirst = () => setFirstStart(20)
    })
    return (
      <>
        <Suspense fallback={<div className='first-loading' />}>
          <Reader className='first' range={{ start: firstStart, end: firstStart + 5 }} />
        </Suspense>
        {second ? (
          <Suspense fallback={<div className='second-loading' />}>
            <Reader className='second' range={{ start: 50, end: 55 }} />
          </Suspense>
        ) : null}
      </>
    )
  }

  render(
    <App>
      <Harness />
    </App>,
  )
  await flush()
  t.truthy($('.first'))

  feathers.service('items').setDelay(40)
  act(showSecond)
  t.truthy($('.second-loading'))
  t.falsy($('.second'))

  await flush(() => new Promise(resolve => setTimeout(resolve, 60)))
  t.truthy($('.second'))
  t.falsy($('.second-loading'))
  const items = feathers.service('items')
  const workingFind = items.find.bind(items)
  const failure = new Error('window refresh failed')
  items.find = () => Promise.reject(failure)
  await flush(() => ref.refetch())
  const warm = ref.getSnapshot({ start: 0, end: 5 })
  t.is(warm.status, 'success')
  t.is(warm.error, failure)
  t.false(warm.isFetching)
  t.is(warm.data.get(0)?.id, 1)
  t.is($('.first')?.getAttribute('data-status'), 'success')
  t.is($('.first')?.getAttribute('data-error'), failure.message)
  t.falsy($('.first-loading'))
  await ref.suspensePromise({ start: 0, end: 5 })

  items.find = workingFind
  await flush(async () => {
    ref.refetch()
    await new Promise(resolve => setTimeout(resolve, 60))
  })
  t.is(ref.getSnapshot({ start: 0, end: 5 }).error, null)
  t.is($('.first')?.getAttribute('data-error'), null)

  act(moveFirst)
  t.truthy($('.first'))
  t.falsy($('.first-loading'))
  t.is($('.first')?.getAttribute('data-status'), 'loading')
  await flush(() => new Promise(resolve => setTimeout(resolve, 60)))
  t.is($('.first')?.getAttribute('data-status'), 'success')
  t.is(ref.getSnapshot({ start: 20, end: 25 }).data.get(20)?.id, 21)
  unmount()
})

interface CursorCall {
  after: string | null
  limit: number
}

function createCursorWindowApp(initialRows: Item[]) {
  let rows = initialRows
  const calls: CursorCall[] = []
  const listeners = new Map<string, Set<(item: unknown) => void>>()
  const cursorService = {
    async find(params: FeathersParams = {}) {
      const query = (params.query ?? {}) as Record<string, unknown>
      const after = (query.$after as string | null) ?? null
      const requestedLimit = query.$limit as number
      calls.push({ after, limit: requestedLimit })
      const start = after ? Number(after.slice('cursor:'.length)) : 0
      // Deliberately return short, non-terminal pages to prove that absolute
      // checkpoints follow actual row counts rather than requested page size.
      const data = rows.slice(start, start + Math.min(2, requestedLimit))
      const end = start + data.length
      return {
        data,
        limit: requestedLimit,
        hasPreviousPage: start > 0,
        hasNextPage: end < rows.length,
        startCursor: data.length > 0 ? `cursor:${start}` : null,
        endCursor: data.length > 0 ? `cursor:${end}` : null,
        ...(query.$total ? { total: rows.length } : {}),
      }
    },
    on(event: string, listener: (item: unknown) => void) {
      const eventListeners = listeners.get(event) ?? new Set()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
    },
    off(event: string, listener: (item: unknown) => void) {
      listeners.get(event)?.delete(listener)
    },
  }
  const feathers: FeathersClient = {
    service: () => cursorService as unknown as FeathersService,
  }
  const adapter = new FeathersAdapter(feathers, {
    pagination: { items: cursorPagination() },
  })
  const figbird = new Figbird({ schema, adapter, retry: false, eventBatchInterval: 0 })
  return {
    calls,
    figbird,
    replaceRows(next: Item[]) {
      rows = next
    },
  }
}

test('window query: cursor strategy walks short pages and rebuilds invalid checkpoints', async t => {
  const app = createCursorWindowApp(makeRows(8))
  const ref = app.figbird.window(app.figbird.q.items.orderBy('rank', 'asc'), {
    pageSize: 3,
    preloadPages: 0,
    maxPages: 4,
  })
  const range = { start: 5, end: 6 }
  const read = readSettledWindow(ref, range)
  const initial = await read.promise
  t.is(initial.status, 'success')
  if (initial.status !== 'success') return
  t.is(initial.data.get(5)?.id, 6)
  t.deepEqual(
    app.calls.map(call => call.after),
    [null, 'cursor:2', 'cursor:4'],
  )

  const cached = readSettledWindow(ref, { start: 2, end: 3 })
  await cached.promise
  t.is(app.calls.length, 3)
  cached.unsubscribe()

  const callsBeforeRefetch = app.calls.length
  app.replaceRows([{ id: 99, ownerId: 1, rank: 0, title: 'Inserted' }, ...makeRows(8)])
  ref.refetch()
  await new Promise<void>(resolve => {
    const unsubscribe = ref.subscribe(
      state => {
        if (state.status === 'success' && state.data.get(5)?.id === 5 && !state.isFetching) {
          unsubscribe()
          resolve()
        }
      },
      { range },
    )
  })

  t.true(app.calls.length > callsBeforeRefetch)
  t.is(ref.getSnapshot(range).data.get(5)?.id, 5)
  t.true(app.calls.slice(callsBeforeRefetch).some(call => call.after === null))
  t.true(app.calls.slice(callsBeforeRefetch).some(call => call.after === 'cursor:4'))
  read.unsubscribe()
})
