import EventEmitter from 'events'
import { JSDOM } from 'jsdom'
import type { ReactElement, ReactNode } from 'react'
import { act, createElement, StrictMode } from 'react'
import type { Root } from 'react-dom/client'
import { createRoot } from 'react-dom/client'
import {
  FeathersAdapter,
  Figbird,
  FigbirdProvider,
  type CustomOperator,
  type Schema,
} from '../lib/index.js'
import type { FeathersClient } from '../lib/index.js'

// Local test type for Feathers items
interface TestItem {
  id?: string | number
  _id?: string | number
  updatedAt?: string | Date | number | null
  [key: string]: unknown
}

interface DomHelpers {
  root: Root
  render: (el: ReactElement) => void
  unmount: () => void
  click: (el: Element) => void
  flush: (fn?: () => Promise<void> | void) => Promise<void>
  $: (sel: string) => Element | null
  $all: (sel: string) => Element[]
  act: typeof act
}

export function dom(): DomHelpers {
  const dom = new JSDOM('<!doctype html><div id="root"></div>')
  // JSDOM's DOMWindow interface doesn't perfectly match TypeScript's Window & typeof globalThis.
  // The double assertion pattern (as unknown as T) is the recommended approach when we need
  // to bridge incompatible types that we know are safe to use in our context.
  // This is necessary because JSDOM provides its own DOMWindow type that has slight differences
  // from the standard Window interface, but is functionally compatible for testing purposes.
  global.window = dom.window as unknown as Window & typeof globalThis
  const domNode = dom.window.document.getElementById('root')!
  const root = createRoot(domNode)

  function onError(event: Event): void {
    // Note: this will swallow reports about unhandled errors!
    // Use with extreme caution.
    console.log(event)
    event.preventDefault()
  }
  dom.window.addEventListener('error', onError)

  function render(el: ReactElement): void {
    act(() => {
      root.render(el)
    })
  }

  function unmount(): void {
    act(() => {
      root.unmount()
    })
  }

  function click(el: Element): void {
    act(() => {
      el.dispatchEvent(
        new dom.window.MouseEvent('click', {
          view: dom.window as unknown as Window,
          bubbles: true,
          cancelable: true,
        }),
      )
    })
  }

  function $(sel: string): Element | null {
    return dom.window.document.querySelector(sel)
  }

  function $all(sel: string): Element[] {
    return Array.from(dom.window.document.querySelectorAll(sel))
  }

  async function flush(fn?: () => Promise<void> | void): Promise<void> {
    await act(async () => {
      if (fn) {
        await fn()
      }
      await waitForEmissions()
    })
  }

  return { root, render, unmount, click, flush, $, $all, act }
}

export const swallowErrors = (yourTestFn: () => void): void => {
  const error = console.error
  console.error = () => {}
  yourTestFn()
  console.error = error
}

interface ServiceData {
  [key: string]: TestItem
}

interface ServiceOptions {
  skipTotal?: boolean
}

interface ServiceCounts {
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
    [key: string]: string | number | boolean | Date | undefined
  }
  [key: string]: unknown // Add to match FeathersParams
}

interface FindResult {
  total?: number
  limit: number
  skip: number
  data: TestItem[]
}

class Service extends EventEmitter {
  name: string
  data: ServiceData
  counts: ServiceCounts
  delay: number
  options: ServiceOptions;
  [key: string]: unknown // Add index signature for FeathersService compatibility

  constructor(name: string, data: ServiceData, options: ServiceOptions = {}) {
    super()
    this.name = name
    this.data = data
    this.counts = {
      get: 0,
      find: 0,
      create: 0,
      patch: 0,
      update: 0,
      remove: 0,
    }
    this.delay = 0
    this.options = options
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
    const limit = (params.query && params.query.$limit) || 100
    const skip = (params.query && params.query.$skip) || 0
    const keys = Object.keys(this.data)
    const data = keys
      .slice(skip)
      .slice(0, limit)
      .map(id => this.data[id])
      .filter((item): item is TestItem => item !== undefined)

    if (this.delay) {
      await new Promise(resolve => setTimeout(resolve, this.delay))
    }

    return Promise.resolve(
      this.options.skipTotal
        ? {
            limit,
            skip,
            data,
          }
        : {
            total: keys.length,
            limit,
            skip,
            data,
          },
    )
  }

  // Method overloads to match FeathersService but also support array creation for tests
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
          queueTask(() => this.emit('created', this.data[itemId]))
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
    queueTask(() => this.emit('created', mutatedItem))
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
    queueTask(() => this.emit('patched', mutatedItem))
    return Promise.resolve(mutatedItem)
  }

  update(id: string | number, data: Partial<TestItem>, _params?: FindParams): Promise<TestItem> {
    this.counts.update++
    this.data = { ...this.data, [id]: { ...data, updatedAt: data.updatedAt || Date.now() } }
    const mutatedItem = this.data[id]!
    queueTask(() => this.emit('updated', mutatedItem))
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
    queueTask(() => this.emit('removed', mutatedItem))
    return Promise.resolve(mutatedItem)
  }
}

// Extend the global namespace to include our custom properties
declare global {
  var __pendingEmissions: Set<object> | undefined
  var __emissionsResolves: Set<(value?: unknown) => void> | undefined
}

export function queueTask(task: () => void): void {
  if (!global.__pendingEmissions) {
    global.__pendingEmissions = new Set()
  }

  if (!global.__emissionsResolves) {
    global.__emissionsResolves = new Set()
  }

  const emissionId = {}

  global.__pendingEmissions.add(emissionId)

  setTimeout(() => {
    task()

    global.__pendingEmissions!.delete(emissionId)
    if (global.__pendingEmissions!.size === 0 && global.__emissionsResolves!.size > 0) {
      global.__emissionsResolves!.forEach(resolve => resolve())
      global.__emissionsResolves!.clear()
    }
  }, 1)
}

async function waitForEmissions(): Promise<void> {
  if (!global.__pendingEmissions?.size) return
  await new Promise(resolve => {
    if (global.__pendingEmissions!.size === 0) {
      resolve(undefined)
    } else {
      global.__emissionsResolves!.add(resolve)
    }
  })
}

interface ServiceDetails {
  data: ServiceData
}

export function service(name: string, details: ServiceDetails, options?: ServiceOptions): Service {
  return new Service(name, details.data, options)
}

interface MockFeathersServices {
  skipTotal?: boolean
  [serviceName: string]: ServiceDetails | boolean | undefined
}

interface MockFeathers extends FeathersClient {
  service(name: string): Service
}

export function mockFeathers(services: MockFeathersServices): MockFeathers {
  const skipTotal = !!services.skipTotal
  delete services.skipTotal

  const processedServices = Object.keys(services).reduce(
    (acc, name) => {
      if (typeof services[name] !== 'boolean') {
        acc[name] = service(name, services[name] as ServiceDetails, { skipTotal })
      }
      return acc
    },
    {} as Record<string, Service>,
  )

  const feathers = {
    service(name: string): Service {
      return processedServices[name]!
    },
  }

  return feathers
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

function compareSortableValues(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === undefined || a === null) return -1
  if (b === undefined || b === null) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b))
}

export function sortRows(
  rows: Record<string, unknown>[],
  sort: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  if (!sort) return rows
  const sortEntries = Object.entries(sort)
  return [...rows].sort((a, b) => {
    for (const [field, direction] of sortEntries) {
      const comparison = compareSortableValues(a[field], b[field])
      if (comparison !== 0) {
        return direction === -1 ? -comparison : comparison
      }
    }
    return 0
  })
}

/**
 * Replace each named service's `find` with one that honors `$limit`, `$skip`,
 * `$sort`, `$in`, and equality filters — the base mock's `find` ignores filters
 * entirely. Respects the service's `skipTotal` option.
 */
export function installQueryAwareFind(
  feathers: ReturnType<typeof mockFeathers>,
  serviceNames: readonly string[],
): void {
  for (const serviceName of serviceNames) {
    const service = feathers.service(serviceName)
    service.find = async (params?: { query?: Record<string, unknown> }) => {
      service.counts.find++
      const query = params?.query ?? {}
      const limit = (query.$limit as number | undefined) ?? 100
      const skip = (query.$skip as number | undefined) ?? 0
      const rows = Object.values(service.data)
        .filter((item): item is Record<string, unknown> => item !== undefined)
        .filter(item => matchesQuery(item, query))
      const sortedRows = sortRows(rows, query.$sort as Record<string, unknown> | undefined)
      const data = sortedRows.slice(skip, skip + limit)
      return service.options.skipTotal
        ? { limit, skip, data }
        : { total: sortedRows.length, limit, skip, data }
    }
  }
}

/**
 * Standard app factory for hook tests: a mock Feathers client behind a
 * FeathersAdapter + Figbird (realtime batching disabled so events apply
 * immediately), wrapped in StrictMode + FigbirdProvider.
 *
 * Pass `queryAwareFind: true` to install the filter-honoring `find` on every
 * service in the mock.
 */
export function createTestApp<S extends Schema>(
  schema: S,
  services: MockFeathersServices,
  {
    queryAwareFind = false,
    operators,
  }: { queryAwareFind?: boolean; operators?: Record<string, CustomOperator> } = {},
) {
  const serviceNames = Object.keys(services).filter(name => name !== 'skipTotal')
  const feathers = mockFeathers(services)
  if (queryAwareFind) installQueryAwareFind(feathers, serviceNames)

  const adapter = new FeathersAdapter(feathers, operators ? { operators } : {})
  const figbird = new Figbird({
    schema,
    adapter,
    eventBatchInterval: 0,
    // Keep existing tests deterministic: no reconcile cooldown unless a test
    // opts in with its own instance.
    reconcileCooldown: 0,
  })

  // Pin the provider's generics — createElement can't infer them from the figbird prop.
  const Provider = FigbirdProvider<S, typeof adapter>
  function App({ children }: { children?: ReactNode }) {
    // No JSX in this .ts file, and the provider's props type requires children,
    // so it must travel via the props object.
    // oxlint-disable-next-line react/no-children-prop
    return createElement(StrictMode, null, createElement(Provider, { figbird, children }))
  }

  return { App, figbird, feathers, adapter }
}
