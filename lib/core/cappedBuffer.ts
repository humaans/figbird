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

  push(item: T): void {
    if (this.#capacity === 0) return
    const index = (this.#start + this.#length) % this.#capacity
    this.#items[index] = item
    if (this.#length < this.#capacity) {
      this.#length++
    } else {
      this.#start = (this.#start + 1) % this.#capacity
    }
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
