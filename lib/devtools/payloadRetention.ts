export interface PayloadHandle {
  active: boolean
  cost: number
  evict: () => void
}

/** FIFO retention for expensive diagnostic values while their metadata lives longer. */
export class PayloadRetention {
  #activeCount = 0
  #cost = 0
  #items: PayloadHandle[] = []
  #start = 0

  constructor(
    readonly limit: number,
    readonly nodeLimit: number,
  ) {}

  retain(value: unknown, evict: () => void): PayloadHandle {
    const handle: PayloadHandle = {
      active: true,
      cost: payloadCost(value, this.nodeLimit + 1),
      evict,
    }
    this.#items.push(handle)
    this.#activeCount++
    this.#cost += handle.cost
    this.#vacuum()
    return handle
  }

  release(handle: PayloadHandle | undefined): void {
    if (!handle?.active) return
    handle.active = false
    this.#activeCount--
    this.#cost -= handle.cost
  }

  clear(): void {
    this.#activeCount = 0
    this.#cost = 0
    this.#items = []
    this.#start = 0
  }

  #vacuum(): void {
    while (this.#activeCount > this.limit || this.#cost > this.nodeLimit) {
      const handle = this.#items[this.#start++]
      if (!handle?.active) continue
      handle.active = false
      this.#activeCount--
      this.#cost -= handle.cost
      handle.evict()
    }
    if (this.#start > 512 && this.#start * 2 > this.#items.length) {
      this.#items = this.#items.slice(this.#start)
      this.#start = 0
    }
  }
}

/**
 * A bounded walk avoids serializing retained payloads just to estimate their cost.
 * Long strings are weighted too, so one flat payload cannot bypass the object budget.
 */
function payloadCost(value: unknown, maximum: number): number {
  const seen = new WeakSet<object>()
  const queue: unknown[] = [value]
  let cost = 0
  while (queue.length > 0 && cost < maximum) {
    const item = queue.pop()
    if (typeof item === 'string') {
      cost += Math.max(1, Math.ceil(item.length / 256))
      continue
    }
    cost++
    if (typeof item !== 'object' || item === null || seen.has(item)) continue
    seen.add(item)
    if (Array.isArray(item)) {
      const remaining = Math.max(0, maximum - cost)
      for (let index = Math.min(item.length, remaining) - 1; index >= 0; index--) {
        queue.push(item[index])
      }
      continue
    }
    if (item instanceof Map) {
      for (const [key, mapValue] of item) {
        queue.push(key, mapValue)
        if (queue.length + cost >= maximum) break
      }
      continue
    }
    if (item instanceof Set) {
      for (const setValue of item) {
        queue.push(setValue)
        if (queue.length + cost >= maximum) break
      }
      continue
    }
    const remaining = Math.max(0, maximum - cost)
    let inspected = 0
    for (const key in item) {
      if (!Object.prototype.hasOwnProperty.call(item, key)) continue
      if (inspected++ >= remaining) break
      try {
        queue.push((item as Record<string, unknown>)[key])
      } catch {
        // Ignore getters that cannot be inspected.
      }
    }
  }
  return Math.min(maximum, cost)
}
