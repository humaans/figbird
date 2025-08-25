import EventEmitter from 'events'
import { JSDOM } from 'jsdom'
import { act, ReactElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import type { FeathersClient } from '../lib/index.js'

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

import type { FeathersItem } from '../lib/adapters/feathers-types.js'

interface ServiceData {
  [key: string]: FeathersItem
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
  data: FeathersItem[]
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

  get(id: string | number, _params?: FindParams): Promise<FeathersItem> {
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
      .filter((item): item is FeathersItem => item !== undefined)

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
  create(data: Partial<FeathersItem>, _params?: FindParams): Promise<FeathersItem>
  create(data: FeathersItem[], _params?: FindParams): Promise<FeathersItem[]>
  create(
    data: Partial<FeathersItem> | FeathersItem[],
    _params?: FindParams,
  ): Promise<FeathersItem | FeathersItem[]> {
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

  patch(
    id: string | number,
    data: Partial<FeathersItem>,
    _params?: FindParams,
  ): Promise<FeathersItem> {
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

  update(
    id: string | number,
    data: Partial<FeathersItem>,
    _params?: FindParams,
  ): Promise<FeathersItem> {
    this.counts.update++
    this.data = { ...this.data, [id]: { ...data, updatedAt: data.updatedAt || Date.now() } }
    const mutatedItem = this.data[id]!
    queueTask(() => this.emit('updated', mutatedItem))
    return Promise.resolve(mutatedItem)
  }

  remove(id: string | number, _params?: FindParams): Promise<FeathersItem> {
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
