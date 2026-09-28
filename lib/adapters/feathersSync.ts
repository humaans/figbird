import type { AdapterConnectionEvent, EventHandlers } from './adapter.js'
import type { FeathersClient } from './feathers.js'
import { orderingComparator, type ServiceOrdering, type ValueComparator } from '../core/sort.js'
import { SYNC_CHANGE_TYPES, type SyncResult } from '../server/protocol.js'

/**
 * Opt into the experimental figbird sync protocol served by `figbird/server`.
 * See DESIGN.md "Sync Protocol (experimental)".
 */
export interface FeathersSyncOptions {
  /** Path the `figbirdSync` service is mounted at. Defaults to `figbird/sync`. */
  path?: string
  /** Row version field stamped by the `versioned` hooks. Defaults to `_v`. */
  versionField?: string
}

const DEFAULT_PATH = 'figbird/sync'

const CHANGE_TYPE_SET: ReadonlySet<string> = new Set(SYNC_CHANGE_TYPES)

function isSyncResult(value: unknown): value is SyncResult {
  const response = value as SyncResult | null
  return (
    typeof response?.cursor === 'number' &&
    Array.isArray(response.services) &&
    Array.isArray(response.changes) &&
    response.changes.every(
      change =>
        typeof change?.service === 'string' &&
        CHANGE_TYPE_SET.has(change.type) &&
        change.item !== null &&
        typeof change.item === 'object',
    )
  )
}

/**
 * Read the server's ordering declarations from a `figbirdSync` service and build
 * the matching value comparator, for `new Figbird({ compare })`.
 */
export async function loadServerOrdering(
  feathers: FeathersClient,
  path = DEFAULT_PATH,
): Promise<ValueComparator> {
  const ordering = await feathers.service(path).get('ordering')
  if (!ordering || typeof ordering !== 'object') {
    throw new Error(`Sync service "${path}" returned invalid ordering declarations`)
  }
  return orderingComparator(ordering as Record<string, ServiceOrdering>)
}

/**
 * The client half of the sync protocol, owned by a `FeathersAdapter` configured
 * with `sync`: it reads row versions, tracks the cursor from realtime events,
 * and replays missed changes into the store's realtime handlers on reconnect.
 */
export class FeathersSync {
  readonly #feathers: FeathersClient
  readonly #getId: (item: unknown) => string | number | undefined
  readonly #path: string
  readonly #versionField: string
  /** Highest row version seen on a realtime event: where a replay resumes. */
  #cursor: number | undefined
  /** The store's handlers per subscribed service, which replays feed. */
  #listeners = new Map<string, Set<EventHandlers>>()
  #connectionSubscribers = new Set<(event: AdapterConnectionEvent) => void>()
  #releaseTransport: (() => void) | undefined
  /** Counts transport transitions, so a replay can tell it spans another outage. */
  #connection = 0
  #replaying = false
  /** Versions of rows seen live while a replay is in flight, by service and id. */
  #liveDuringReplay: Map<string, number> | undefined

  constructor(
    feathers: FeathersClient,
    getId: (item: unknown) => string | number | undefined,
    { path = DEFAULT_PATH, versionField = '_v' }: FeathersSyncOptions,
  ) {
    this.#feathers = feathers
    this.#getId = getId
    this.#path = path
    this.#versionField = versionField
  }

  versionOf(item: unknown): number | undefined {
    if (!item || typeof item !== 'object') return undefined
    const value = (item as Record<string, unknown>)[this.#versionField]
    // bigint columns commonly serialize as strings
    const version = typeof value === 'string' && value !== '' ? Number(value) : value
    return typeof version === 'number' && Number.isSafeInteger(version) ? version : undefined
  }

  /**
   * Register the store's handlers for replays, and wrap them for the transport so
   * live events advance the cursor and guard rows against an in-flight replay.
   */
  track(serviceName: string, handlers: EventHandlers): { live: EventHandlers; release(): void } {
    let listeners = this.#listeners.get(serviceName)
    if (!listeners) this.#listeners.set(serviceName, (listeners = new Set()))
    listeners.add(handlers)

    const observe =
      (type: keyof EventHandlers) =>
      (item: unknown): void => {
        for (const row of Array.isArray(item) ? item : [item]) this.#observe(serviceName, row)
        handlers[type](item)
      }
    return {
      live: {
        created: observe('created'),
        updated: observe('updated'),
        patched: observe('patched'),
        removed: observe('removed'),
      },
      release: () => {
        listeners.delete(handlers)
        if (listeners.size === 0) this.#listeners.delete(serviceName)
      },
    }
  }

  /**
   * Multiplex the transport's connection events to the store's subscribers
   * through one transport listener, so each reconnect runs one replay. A
   * reconnect is reported once its replay settles, flagged `replayed` on success.
   */
  subscribeToConnectionEvents(
    handler: (event: AdapterConnectionEvent) => void,
    subscribeToTransport: (handler: (event: AdapterConnectionEvent) => void) => () => void,
  ): () => void {
    this.#connectionSubscribers.add(handler)
    this.#releaseTransport ??= subscribeToTransport(event => this.#connectionEvent(event))
    return () => {
      this.#connectionSubscribers.delete(handler)
      if (this.#connectionSubscribers.size > 0) return
      this.#releaseTransport?.()
      this.#releaseTransport = undefined
    }
  }

  #connectionEvent(event: AdapterConnectionEvent): void {
    if (event.type === 'disconnected' || event.type === 'reconnected') this.#connection++
    if (event.type !== 'reconnected') return this.#broadcast(event)
    // A reconnect during a replay falls back: the replay it interrupted can't
    // vouch for this outage.
    if (this.#replaying) return this.#broadcast(event)
    this.#replaying = true
    void this.#replayMissedEvents()
      .finally(() => {
        this.#replaying = false
        this.#liveDuringReplay = undefined
      })
      .then(replayed => this.#broadcast(replayed ? { ...event, replayed } : event))
  }

  #broadcast(event: AdapterConnectionEvent): void {
    for (const handler of this.#connectionSubscribers) handler(event)
  }

  #observe(serviceName: string, row: unknown): void {
    const version = this.versionOf(row)
    if (version === undefined) return
    if (this.#cursor === undefined || version > this.#cursor) this.#cursor = version
    const id = this.#getId(row)
    if (this.#liveDuringReplay && id !== undefined) {
      const key = replayKey(serviceName, id)
      this.#liveDuringReplay.set(
        key,
        Math.max(version, this.#liveDuringReplay.get(key) ?? -Infinity),
      )
    }
  }

  /**
   * Replay the changes missed while disconnected into the store's realtime
   * handlers. Resolves false when the store must reconcile instead: no cursor
   * yet, a truncated log, a subscribed service the server doesn't replay, a
   * disconnect before the answer arrived, or any failure.
   */
  async #replayMissedEvents(): Promise<boolean> {
    const since = this.#cursor
    const connection = this.#connection
    if (since === undefined) return false
    const services = [...this.#listeners.keys()]
    if (services.length === 0) return true
    const liveDuringReplay = new Map<string, number>()
    this.#liveDuringReplay = liveDuringReplay
    let response: unknown
    try {
      response = await this.#feathers.service(this.#path).find({ query: { since, services } })
    } catch {
      return false
    }
    if (connection !== this.#connection || !isSyncResult(response)) return false
    // A listened service the server doesn't version has no replayable history.
    if (!services.every(service => response.services.includes(service))) return false

    for (const change of response.changes) {
      const id = this.#getId(change.item)
      // A row event that arrived while the request was in flight is at least as
      // new as the replayed row, and a replayed row must not resurrect a row
      // removed meanwhile.
      const live =
        id === undefined ? undefined : liveDuringReplay.get(replayKey(change.service, id))
      const version = this.versionOf(change.item)
      if (live !== undefined && (version === undefined || version <= live)) continue
      // An id-only payload reaches the store as an invalidation: it reconciles the
      // queries that might hold the row instead of trusting a missing read.
      const type = change.type === 'invalidated' ? 'patched' : change.type
      for (const handlers of this.#listeners.get(change.service) ?? []) {
        handlers[type](change.item)
      }
    }
    if (this.#cursor === undefined || response.cursor > this.#cursor) {
      this.#cursor = response.cursor
    }
    return true
  }
}

function replayKey(serviceName: string, id: string | number): string {
  return `${serviceName}\u0000${String(id)}`
}
