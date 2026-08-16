export class CappedBuffer<T> {
  readonly #capacity: number
  readonly #items: Array<T | undefined>
  #length = 0
  #start = 0

  constructor(capacity: number) {
    this.#capacity = Math.max(0, Math.floor(capacity))
    this.#items = new Array<T | undefined>(this.#capacity)
  }

  get length(): number {
    return this.#length
  }

  push(item: T): T | undefined {
    if (this.#capacity === 0) return item
    const index = (this.#start + this.#length) % this.#capacity
    const evicted = this.#length === this.#capacity ? this.#items[index] : undefined
    this.#items[index] = item
    if (this.#length < this.#capacity) {
      this.#length++
    } else {
      this.#start = (this.#start + 1) % this.#capacity
    }
    return evicted
  }

  first(): T | undefined {
    return this.#length === 0 ? undefined : this.#items[this.#start]
  }

  shift(): T | undefined {
    if (this.#length === 0) return undefined
    const item = this.#items[this.#start]
    this.#items[this.#start] = undefined
    this.#start = (this.#start + 1) % this.#capacity
    this.#length--
    return item
  }

  clear(): void {
    this.#items.fill(undefined)
    this.#length = 0
    this.#start = 0
  }

  drain(): T[] {
    const items = this.toArray()
    this.clear()
    return items
  }

  toArray(): T[] {
    return Array.from(
      { length: this.#length },
      (_, index) => this.#items[(this.#start + index) % this.#capacity]!,
    )
  }
}
