/**
 * figbird/testing — an in-memory, Feathers-compatible mock client for testing apps
 * built on figbird without mocking figbird itself.
 *
 * ```ts
 * import { mockFeathers } from 'figbird/testing'
 *
 * const feathers = mockFeathers({
 *   issues: { data: { 1: { id: 1, title: 'Ship it', status: 'open' } } },
 * })
 * const figbird = new Figbird({ adapter: new FeathersAdapter(feathers), schema })
 *
 * // render your components, then simulate server-side changes:
 * feathers.service('issues').emit('patched', { id: 1, title: 'Shipped', status: 'closed' })
 * // and assert fetch behavior:
 * feathers.service('issues').counts.find
 * ```
 *
 * Services support CRUD (create/update/patch/remove emit the corresponding realtime
 * events), `get`/`find` with `$limit`/`$skip`, per-method call counters, and an
 * optional artificial `delay`. Options: `skipTotal` for servers that don't count
 * totals, and `queryAwareFind: true` to make `find` honor equality, `$in`, and
 * `$sort` filters — the default `find` ignores filters entirely, which keeps most
 * tests independent of matching semantics.
 *
 * No Node builtins are used, so this runs under any bundler or test runner.
 */

import type { FeathersClient } from './adapters/feathers.js'
import { buildComparator } from './core/sort.js'

export interface TestItem {
  id?: string | number
  _id?: string | number
  updatedAt?: string | Date | number | null
  [key: string]: unknown
}

export interface ServiceData {
  [key: string]: TestItem
}

export interface ServiceCounts {
  get: number
  find: number
  create: number
  patch: number
  update: number
  remove: number
}

interface FindParams {
  query?: {
    $limit?: number
    $skip?: number
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface FindResult {
  total?: number
  limit: number
  skip: number
  data: TestItem[]
}

interface ServiceOptions {
  /** Omit `total` from find envelopes, like servers that don't count. */
  skipTotal?: boolean
  /**
   * Make `find` honor equality, `$in`, and `$sort` filters. The default `find`
   * ignores filters entirely, which keeps most tests independent of matching
   * semantics.
   */
  queryAware?: boolean
  /**
   * How mutation-triggered realtime emits are deferred (they must not fire
   * synchronously inside the mutation promise, like a real socket wouldn't).
   * Defaults to a 1ms timeout; test harnesses can inject their own scheduler
   * to track pending emissions.
   */
  schedule?: (task: () => void) => void
}

const defaultSchedule = (task: () => void) => setTimeout(task, 1)

type Listener = (item: unknown) => void

/**
 * An in-memory Feathers-compatible service. `data` is keyed by id; mutations emit
 * the corresponding realtime event on the next tick, like a real transport would.
 */
export class MockService {
  name: string
  data: ServiceData
  counts: ServiceCounts
  delay: number
  options: ServiceOptions;
  [key: string]: unknown

  #listeners: Map<string, Set<Listener>> = new Map()
  #schedule: (task: () => void) => void

  constructor(name: string, data: ServiceData, options: ServiceOptions = {}) {
    this.name = name
    this.data = data
    this.counts = { get: 0, find: 0, create: 0, patch: 0, update: 0, remove: 0 }
    this.delay = 0
    this.options = options
    this.#schedule = options.schedule ?? defaultSchedule
  }

  on(event: string, listener: Listener): this {
    let set = this.#listeners.get(event)
    if (!set) {
      set = new Set()
      this.#listeners.set(event, set)
    }
    set.add(listener)
    return this
  }

  off(event: string, listener: Listener): this {
    this.#listeners.get(event)?.delete(listener)
    return this
  }

  removeListener(event: string, listener: Listener): this {
    return this.off(event, listener)
  }

  /** Simulate a server-side realtime event (delivered synchronously). */
  emit(event: string, item: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(item)
    }
  }

  setDelay(delay: number): void {
    this.delay = delay
  }

  get(id: string | number, _params?: FindParams): Promise<TestItem> {
    this.counts.get++
    const item = this.data[id]
    if (!item) {
      return Promise.reject(new Error(`Item with id ${id} not found`))
    }
    return Promise.resolve(item)
  }

  async find(params: FindParams = {}): Promise<FindResult> {
    this.counts.find++
    const query = params.query ?? {}
    const limit = (query.$limit as number | undefined) || 100
    const skip = (query.$skip as number | undefined) || 0

    let rows = Object.values(this.data).filter((item): item is TestItem => item !== undefined)
    if (this.options.queryAware) {
      rows = sortRows(
        rows.filter(item => matchesQuery(item, query)),
        query.$sort as Record<string, unknown> | undefined,
      )
    }

    if (this.delay) {
      await new Promise(resolve => setTimeout(resolve, this.delay))
    }

    const data = rows.slice(skip, skip + limit)
    return this.options.skipTotal
      ? { limit, skip, data }
      : { total: rows.length, limit, skip, data }
  }

  create(data: Partial<TestItem>, _params?: FindParams): Promise<TestItem>
  create(data: TestItem[], _params?: FindParams): Promise<TestItem[]>
  create(
    data: Partial<TestItem> | TestItem[],
    _params?: FindParams,
  ): Promise<TestItem | TestItem[]> {
    if (Array.isArray(data)) {
      this.counts.create += data.length
      const ids = data.map(datum => datum.id || datum._id)
      this.data = { ...this.data }
      for (const datum of data) {
        const itemId = datum.id || datum._id
        if (itemId !== undefined) {
          this.data[itemId] = { ...datum, updatedAt: datum.updatedAt || Date.now() }
          this.#schedule(() => this.emit('created', this.data[itemId]!))
        }
      }
      return Promise.all(
        ids.filter((id): id is string | number => id !== undefined).map(id => this.get(id)),
      )
    }
    this.counts.create++
    const id = data.id || data._id
    if (id === undefined) {
      return Promise.reject(new Error('Item must have an id or _id'))
    }
    this.data = { ...this.data, [id]: { ...data, updatedAt: data.updatedAt || Date.now() } }
    const mutatedItem = this.data[id]!
    this.#schedule(() => this.emit('created', mutatedItem))
    return Promise.resolve(mutatedItem)
  }

  patch(id: string | number, data: Partial<TestItem>, _params?: FindParams): Promise<TestItem> {
    this.counts.patch++
    const existingItem = this.data[id]
    if (!existingItem) {
      return Promise.reject(new Error(`Item with id ${id} not found`))
    }
    this.data = {
      ...this.data,
      [id]: { ...existingItem, ...data, updatedAt: data.updatedAt || Date.now() },
    }
    const mutatedItem = this.data[id]!
    this.#schedule(() => this.emit('patched', mutatedItem))
    return Promise.resolve(mutatedItem)
  }

  update(id: string | number, data: Partial<TestItem>, _params?: FindParams): Promise<TestItem> {
    this.counts.update++
    this.data = { ...this.data, [id]: { ...data, updatedAt: data.updatedAt || Date.now() } }
    const mutatedItem = this.data[id]!
    this.#schedule(() => this.emit('updated', mutatedItem))
    return Promise.resolve(mutatedItem)
  }

  remove(id: string | number, _params?: FindParams): Promise<TestItem> {
    this.counts.remove++
    this.data = { ...this.data }
    const mutatedItem = this.data[id]
    if (!mutatedItem) {
      return Promise.reject(new Error(`Item with id ${id} not found`))
    }
    delete this.data[id]
    this.#schedule(() => this.emit('removed', mutatedItem))
    return Promise.resolve(mutatedItem)
  }
}

export interface ServiceDetails {
  data: ServiceData
}

export function service(
  name: string,
  details: ServiceDetails,
  options?: ServiceOptions,
): MockService {
  return new MockService(name, details.data, options)
}

export type MockFeathersServices = Record<string, ServiceDetails>

export interface MockFeathersOptions {
  /** Make every service's `find` honor equality, `$in`, and `$sort` filters. */
  queryAwareFind?: boolean
  /** Make every service omit `total` from find envelopes. */
  skipTotal?: boolean
  /** Deferred-emission scheduler threaded to every service (see ServiceOptions). */
  schedule?: (task: () => void) => void
}

export interface MockFeathers extends FeathersClient {
  service(name: string): MockService
}

/**
 * Create an in-memory Feathers-compatible client from `{ serviceName: { data } }`.
 */
export function mockFeathers(
  services: MockFeathersServices,
  { queryAwareFind = false, skipTotal = false, schedule }: MockFeathersOptions = {},
): MockFeathers {
  const processedServices: Record<string, MockService> = {}
  for (const [name, details] of Object.entries(services)) {
    processedServices[name] = service(name, details, {
      skipTotal,
      queryAware: queryAwareFind,
      ...(schedule ? { schedule } : {}),
    })
  }

  return {
    service(name: string): MockService {
      return processedServices[name]!
    },
  } as MockFeathers
}

/** True when `item` satisfies the query's non-$ filters (`$in` and strict equality). */
export function matchesQuery(
  item: Record<string, unknown>,
  query: Record<string, unknown> = {},
): boolean {
  return Object.entries(query).every(([key, value]) => {
    if (key.startsWith('$')) return true
    const actual = item[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const op = value as { $in?: unknown[] }
      if (Array.isArray(op.$in)) {
        return op.$in.includes(actual)
      }
    }
    return actual === value
  })
}

/**
 * Sort rows by a `$sort` map using figbird's canonical comparator (lib/core/sort) —
 * the mock "server" must order rows exactly like figbird's own local window
 * maintenance, or realtime merges would appear to reorder server results.
 */
export function sortRows<T extends Record<string, unknown>>(
  rows: T[],
  sort: Record<string, unknown> | undefined,
): T[] {
  if (!sort) return rows
  return [...rows].sort(buildComparator(sort as Record<string, number>))
}
