import type { ScheduledMutationControl } from './mutationQueue.js'

type AttemptState = 'pending' | 'running' | 'settled'

/** Owns the shared ready-wait, deferred gate, and cancel-before-start lifecycle. */
export class GatedMutationAttempt {
  readonly control: ScheduledMutationControl | undefined
  readonly promise: Promise<unknown>

  #state: AttemptState = 'pending'
  #readyUnsub: (() => void) | undefined
  #resolve!: (value: unknown) => void
  #reject!: (error: unknown) => void

  constructor(control?: ScheduledMutationControl) {
    this.control = control
    this.promise = new Promise<unknown>((resolve, reject) => {
      this.#resolve = resolve
      this.#reject = reject
    })
  }

  get pending(): boolean {
    return this.#state === 'pending'
  }

  get ready(): boolean {
    return !this.control || this.control.isReady()
  }

  whenReady(listener: () => void): void {
    if (!this.pending) return
    if (this.ready) {
      listener()
      return
    }
    this.#readyUnsub ??= this.control!.subscribeReady(() => {
      this.#clearReadyListener()
      if (this.pending) listener()
    })
  }

  start(run: () => Promise<unknown>): boolean {
    if (!this.pending || !this.ready) return false
    this.#state = 'running'
    this.#clearReadyListener()
    run().then(
      value => {
        this.#state = 'settled'
        this.#resolve(value)
      },
      error => {
        this.#state = 'settled'
        this.#reject(error)
      },
    )
    return true
  }

  cancel(error: Error): boolean {
    if (!this.pending) return false
    this.#state = 'settled'
    this.#clearReadyListener()
    this.#reject(error)
    return true
  }

  #clearReadyListener(): void {
    this.#readyUnsub?.()
    this.#readyUnsub = undefined
  }
}
