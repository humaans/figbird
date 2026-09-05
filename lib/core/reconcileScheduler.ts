import type { TraceCause } from './events.js'

type Request = {
  force: boolean
  causes: readonly TraceCause[] | undefined
} & ({ kind: 'pending' | 'hidden' } | { kind: 'cooldown'; eligibleAt: number })

interface Entry {
  lastAt: number | undefined
  request: Request | undefined
}

type Decision = 'inactive' | 'deferred-hidden' | 'fetch-now' | 'coalesced'

interface SchedulerHost {
  prepare(queryId: string, force: boolean): 'missing' | 'inactive' | 'hidden' | 'local' | 'network'
  fetch(queryId: string, causes: readonly TraceCause[] | undefined): void
  pendingChanged(queryId: string, pending: boolean): void
  decision(queryId: string, decision: Decision, causes: readonly TraceCause[] | undefined): void
  merge(
    left: readonly TraceCause[] | undefined,
    right: readonly TraceCause[] | undefined,
  ): readonly TraceCause[] | undefined
}

/** Owns outstanding reconciliations and cooldowns; the store owns how queries resolve. */
export class ReconcileScheduler {
  readonly #entries = new Map<string, Entry>()
  readonly #host: SchedulerHost
  readonly #cooldown: number
  #timer: ReturnType<typeof setTimeout> | undefined
  #timerAt = Infinity

  constructor(cooldown: number, host: SchedulerHost) {
    this.#cooldown = cooldown
    this.#host = host
  }

  isPending(queryId: string): boolean {
    const request = this.#entries.get(queryId)?.request
    return request !== undefined && request.kind !== 'cooldown'
  }

  markPending(queryId: string): void {
    const entry = this.#entries.get(queryId)
    this.#set(queryId, {
      lastAt: entry?.lastAt,
      request: {
        kind: 'pending',
        force: entry?.request?.force ?? false,
        causes: entry?.request?.causes,
      },
    })
  }

  request(
    queryId: string,
    { force = false, causes }: { force?: boolean; causes?: readonly TraceCause[] } = {},
  ): void {
    const entry = this.#entries.get(queryId)
    const merged = this.#host.merge(entry?.request?.causes, causes)
    force ||= entry?.request?.force ?? false
    const disposition = this.#host.prepare(queryId, force)
    if (disposition === 'missing' || disposition === 'local') {
      this.forget(queryId)
      return
    }
    if (disposition === 'inactive' || disposition === 'hidden') {
      this.#set(queryId, {
        lastAt: entry?.lastAt,
        request: {
          kind: disposition === 'hidden' ? 'hidden' : 'pending',
          force,
          causes: merged,
        },
      })
      this.#host.decision(
        queryId,
        disposition === 'hidden' ? 'deferred-hidden' : 'inactive',
        merged,
      )
    } else {
      const now = Date.now()
      const eligibleAt = (entry?.lastAt ?? -Infinity) + this.#cooldown
      if (this.#cooldown <= 0 || now >= eligibleAt) {
        this.#set(queryId, { lastAt: now, request: undefined })
        this.#host.decision(queryId, 'fetch-now', merged)
        this.#host.fetch(queryId, merged)
      } else {
        this.#set(queryId, {
          lastAt: entry?.lastAt,
          request: { kind: 'cooldown', eligibleAt, force, causes: merged },
        })
        this.#host.decision(queryId, 'coalesced', causes)
        this.#schedule(eligibleAt)
      }
    }
  }

  /** A dispatched fetch consumes pending work but retains its cooldown history. */
  settle(queryId: string): void {
    const entry = this.#entries.get(queryId)
    if (entry?.lastAt === undefined) this.forget(queryId)
    else this.#set(queryId, { lastAt: entry.lastAt, request: undefined })
  }

  drainHidden(): Set<string> {
    const ids = [...this.#entries]
      .filter(([, entry]) => entry.request?.kind === 'hidden')
      .map(([id]) => id)
    for (const id of ids) this.request(id)
    return new Set(ids)
  }

  forget(queryId: string): void {
    const pending = this.isPending(queryId)
    this.#entries.delete(queryId)
    if (pending) this.#host.pendingChanged(queryId, false)
  }

  dispose(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#timerAt = Infinity
    this.#entries.clear()
  }

  #set(queryId: string, entry: Entry): void {
    const previous = this.isPending(queryId)
    this.#entries.set(queryId, entry)
    const pending = this.isPending(queryId)
    if (previous !== pending) this.#host.pendingChanged(queryId, pending)
  }

  #schedule(next: number): void {
    if (next >= this.#timerAt) return
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timerAt = next
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined
        this.#timerAt = Infinity
        const now = Date.now()
        const due = [...this.#entries].filter(
          ([, entry]) => entry.request?.kind === 'cooldown' && entry.request.eligibleAt <= now,
        )
        for (const [id, entry] of due) {
          if (this.#entries.get(id) === entry) this.request(id)
        }
        let next = Infinity
        for (const { request } of this.#entries.values()) {
          if (request?.kind === 'cooldown') next = Math.min(next, request.eligibleAt)
        }
        this.#schedule(next)
      },
      Math.max(0, next - Date.now()),
    )
    const timer = this.#timer as ReturnType<typeof setTimeout> & { unref?: () => void }
    timer.unref?.()
  }
}
