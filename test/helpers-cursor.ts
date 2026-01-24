import EventEmitter from 'events'
import type { FeathersClient } from '../lib/index.js'
import { queueTask } from './helpers.js'

interface TestItem {
  id?: string | number
  _id?: string | number
  updatedAt?: string | Date | number | null
  [key: string]: unknown
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
    cursor?: string
    $sort?: Record<string, 1 | -1>
    [key: string]: unknown
  }
  [key: string]: unknown
}

type PaginationMode = 'cursor' | 'offset'

interface CursorFindResult {
  data: TestItem[]
  hasNextPage?: boolean // Only present in cursor mode
  endCursor?: string | null // Only present in cursor mode
  total: number
  limit: number
  skip: number
}

interface CursorServiceOptions {
  data: TestItem[]
  pageSize: number
  failNextFind?: boolean
  /** Pagination mode: 'cursor' (default) returns endCursor/hasNextPage, 'offset' returns only skip/limit/total */
  mode?: PaginationMode
}

class CursorService extends EventEmitter {
  name: string
  #data: Map<string | number, TestItem>
  #originalOrder: (string | number)[]
  pageSize: number
  counts: ServiceCounts
  #failNextFind: boolean
  #mode: PaginationMode;
  [key: string]: unknown

  constructor(name: string, options: CursorServiceOptions) {
    super()
    this.name = name
    this.#data = new Map()
    this.#originalOrder = []
    for (const item of options.data) {
      const id = item.id ?? item._id
      if (id !== undefined) {
        this.#data.set(id, item)
        this.#originalOrder.push(id)
      }
    }
    this.pageSize = options.pageSize
    this.counts = {
      get: 0,
      find: 0,
      create: 0,
      patch: 0,
      update: 0,
      remove: 0,
    }
    this.#failNextFind = options.failNextFind ?? false
    this.#mode = options.mode ?? 'cursor'
  }

  get(id: string | number): Promise<TestItem> {
    this.counts.get++
    const item = this.#data.get(id)
    if (!item) {
      return Promise.reject(new Error(`Item with id ${id} not found`))
    }
    return Promise.resolve(item)
  }

  async find(params: FindParams = {}): Promise<CursorFindResult> {
    this.counts.find++

    if (this.#failNextFind) {
      this.#failNextFind = false
      return Promise.reject(new Error('Simulated fetch error'))
    }

    const limit = params.query?.$limit ?? this.pageSize
    const cursor = params.query?.cursor
    const skip = params.query?.$skip ?? 0

    // Get all items in original order
    const allItems = this.#originalOrder
      .map(id => this.#data.get(id))
      .filter((item): item is TestItem => item !== undefined)

    // Find starting index based on cursor (cursor mode) or $skip (offset mode)
    let startIndex = 0
    if (this.#mode === 'cursor' && cursor) {
      const cursorId = parseInt(cursor, 10)
      startIndex = this.#originalOrder.findIndex(id => id === cursorId)
      if (startIndex === -1) {
        startIndex = 0
      }
    } else if (this.#mode === 'offset') {
      startIndex = skip
    } else if (cursor) {
      // Cursor mode with cursor param
      const cursorId = parseInt(cursor, 10)
      startIndex = this.#originalOrder.findIndex(id => id === cursorId)
      if (startIndex === -1) {
        startIndex = 0
      }
    }

    // Get page of data
    const pageData = allItems.slice(startIndex, startIndex + limit)
    const hasNextPage = startIndex + limit < allItems.length
    const nextCursorId = hasNextPage ? this.#originalOrder[startIndex + limit] : null

    // Return different shape based on mode
    if (this.#mode === 'offset') {
      // Offset mode: only return skip/limit/total (no endCursor/hasNextPage)
      return Promise.resolve({
        data: pageData,
        total: allItems.length,
        limit,
        skip: startIndex,
      })
    }

    // Cursor mode: include endCursor and hasNextPage
    return Promise.resolve({
      data: pageData,
      hasNextPage,
      endCursor: nextCursorId !== null ? String(nextCursorId) : null,
      total: allItems.length,
      limit,
      skip: startIndex,
    })
  }

  create(data: Partial<TestItem>): Promise<TestItem>
  create(data: TestItem[]): Promise<TestItem[]>
  create(data: Partial<TestItem> | TestItem[]): Promise<TestItem | TestItem[]> {
    if (Array.isArray(data)) {
      const results: TestItem[] = []
      for (const item of data) {
        const id = item.id ?? item._id
        if (id !== undefined) {
          this.counts.create++
          const newItem = { ...item, updatedAt: item.updatedAt ?? Date.now() }
          this.#data.set(id, newItem)
          this.#originalOrder.push(id)
          results.push(newItem)
          queueTask(() => this.emit('created', newItem))
        }
      }
      return Promise.resolve(results)
    }
    this.counts.create++
    const id = data.id ?? data._id
    if (id === undefined) {
      return Promise.reject(new Error('Item must have an id or _id'))
    }
    const item = { ...data, updatedAt: data.updatedAt ?? Date.now() }
    this.#data.set(id, item)
    this.#originalOrder.push(id)
    const mutatedItem = this.#data.get(id)!
    queueTask(() => this.emit('created', mutatedItem))
    return Promise.resolve(mutatedItem)
  }

  patch(id: string | number, data: Partial<TestItem>): Promise<TestItem> {
    this.counts.patch++
    const existingItem = this.#data.get(id)
    if (!existingItem) {
      return Promise.reject(new Error(`Item with id ${id} not found`))
    }
    const updatedItem = { ...existingItem, ...data, updatedAt: data.updatedAt ?? Date.now() }
    this.#data.set(id, updatedItem)
    const mutatedItem = this.#data.get(id)!
    queueTask(() => this.emit('patched', mutatedItem))
    return Promise.resolve(mutatedItem)
  }

  update(id: string | number, data: Partial<TestItem>): Promise<TestItem> {
    this.counts.update++
    const updatedItem = { ...data, updatedAt: data.updatedAt ?? Date.now() }
    this.#data.set(id, updatedItem)
    const mutatedItem = this.#data.get(id)!
    queueTask(() => this.emit('updated', mutatedItem))
    return Promise.resolve(mutatedItem)
  }

  remove(id: string | number): Promise<TestItem> {
    this.counts.remove++
    const item = this.#data.get(id)
    if (!item) {
      return Promise.reject(new Error(`Item with id ${id} not found`))
    }
    this.#data.delete(id)
    this.#originalOrder = this.#originalOrder.filter(i => i !== id)
    queueTask(() => this.emit('removed', item))
    return Promise.resolve(item)
  }
}

interface MockCursorFeathersServices {
  [serviceName: string]: CursorServiceOptions
}

interface MockCursorFeathers extends FeathersClient {
  service(name: string): CursorService
}

export function mockCursorFeathers(services: MockCursorFeathersServices): MockCursorFeathers {
  const processedServices: Record<string, CursorService> = {}

  for (const [name, options] of Object.entries(services)) {
    processedServices[name] = new CursorService(name, options)
  }

  return {
    service(name: string): CursorService {
      return processedServices[name]!
    },
  }
}
