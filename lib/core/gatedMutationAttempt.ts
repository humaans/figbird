import type { ScheduledMutationControl } from './mutationQueue.js'

type AttemptState = 'pending' | 'running' | 'settled'

/** Owns the shared ready-wait, deferred gate, and cancel-before-start lifecycle. */
export class GatedMutationAttempt {
  readonly control: ScheduledMutationControl | undefined
  readonly promise: Promise<unknown>

  #state: AttemptState = 'pending'
  #dependencies = 0
  #readyListener: (() => void) | undefined
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
    return this.#dependencies === 0 && (!this.control || this.control.isReady())
  }

  whenReady(listener: () => void): void {
    if (!this.pending) return
    if (this.ready) {
      listener()
      return
    }
    this.#readyListener ??= listener
    this.#readyUnsub ??= this.control?.subscribeReady(() => this.#notifyIfReady())
  }

  /**
   * Hold transport until `dependency` fulfils or the returned release is called. A
   * rejected dependency keeps the attempt held; its owner decides whether to cancel it.
   */
  waitFor(dependency: Promise<unknown>): () => void {
    let held = true
    const release = () => {
      if (!held) return
      held = false
      this.#dependencies -= 1
      this.#notifyIfReady()
    }
    this.#dependencies += 1
    dependency.then(release, () => {})
    return release
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

  #notifyIfReady(): void {
    const listener = this.#readyListener
    if (!this.pending || !this.ready || !listener) return
    this.#clearReadyListener()
    listener()
  }

  #clearReadyListener(): void {
    this.#readyUnsub?.()
    this.#readyUnsub = undefined
    this.#readyListener = undefined
  }
}
