import {
  entityKey,
  type EntityKey,
  type ItemId,
  type ProcessedRealtimeEvent,
} from './queryTypes.js'

/** Maximum retained events per service while one or more fetches are in flight. */
export const MAX_FETCH_JOURNAL_EVENTS = 1024

interface ActiveFetch {
  eventIndex: number
  overflowed: boolean
}

interface ServiceJournal {
  events: ProcessedRealtimeEvent[]
  activeFetches: Map<number, ActiveFetch>
}

export interface FetchJournalCursor {
  readonly serviceName: string
  readonly id: number
}

export interface FetchJournalSnapshot {
  readonly events: readonly ProcessedRealtimeEvent[]
  readonly overflowed: boolean
}

/**
 * Bounded event history for responses that race realtime updates.
 *
 * Every fetch receives a cursor into its service's shared journal. If retaining
 * the events needed by one cursor would exceed the limit, only that cursor is
 * marked unsafe. Its response must be discarded and reconciled; newer cursors
 * keep the bounded suffix they need and may still complete normally.
 */
export class FetchEventJournal {
  #services = new Map<string, ServiceJournal>()
  #nextCursorId = 1
  readonly #maxEvents: number

  constructor(maxEvents = MAX_FETCH_JOURNAL_EVENTS) {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) {
      throw new RangeError('Fetch event journal limit must be a positive safe integer')
    }
    this.#maxEvents = maxEvents
  }

  begin(serviceName: string): FetchJournalCursor {
    let journal = this.#services.get(serviceName)
    if (!journal) {
      journal = { events: [], activeFetches: new Map() }
      this.#services.set(serviceName, journal)
    } else {
      this.#compact(journal)
    }

    const cursor = { serviceName, id: this.#nextCursorId++ }
    journal.activeFetches.set(cursor.id, {
      eventIndex: journal.events.length,
      overflowed: false,
    })
    return cursor
  }

  read(cursor: FetchJournalCursor): FetchJournalSnapshot {
    const journal = this.#services.get(cursor.serviceName)
    const activeFetch = journal?.activeFetches.get(cursor.id)
    if (!journal || !activeFetch) {
      return { events: [], overflowed: true }
    }
    return {
      events: activeFetch.overflowed ? [] : journal.events.slice(activeFetch.eventIndex),
      overflowed: activeFetch.overflowed,
    }
  }

  end(cursor: FetchJournalCursor): void {
    const journal = this.#services.get(cursor.serviceName)
    if (!journal) return
    journal.activeFetches.delete(cursor.id)
    if (journal.activeFetches.size === 0) {
      this.#services.delete(cursor.serviceName)
    } else {
      this.#compact(journal)
    }
  }

  record(events: readonly ProcessedRealtimeEvent[]): void {
    for (const event of events) {
      const journal = this.#services.get(event.serviceName)
      if (!journal) continue

      const safeFetches = [...journal.activeFetches.values()].filter(fetch => !fetch.overflowed)
      if (safeFetches.length === 0) continue

      journal.events.push(event)
      let didOverflow = false
      for (const fetch of safeFetches) {
        if (journal.events.length - fetch.eventIndex > this.#maxEvents) {
          fetch.overflowed = true
          didOverflow = true
        }
      }
      if (didOverflow) this.#compact(journal)
    }
  }

  /** Discard the event prefix no safe active fetch still needs. */
  #compact(journal: ServiceJournal): void {
    const safeFetches = [...journal.activeFetches.values()].filter(fetch => !fetch.overflowed)
    if (safeFetches.length === 0) {
      journal.events = []
      return
    }

    const firstRequiredIndex = Math.min(...safeFetches.map(fetch => fetch.eventIndex))
    if (firstRequiredIndex === 0) return
    journal.events.splice(0, firstRequiredIndex)
    for (const fetch of safeFetches) {
      fetch.eventIndex -= firstRequiredIndex
    }
  }
}

export interface FetchRebasePlan {
  readonly events: readonly ProcessedRealtimeEvent[]
  readonly latestEventById: ReadonlyMap<EntityKey, ProcessedRealtimeEvent>
  readonly itemIds: ReadonlySet<EntityKey>
}

/** Drop journal events that the response is provably newer than. */
export function planFetchRebase({
  responseItems,
  journalEvents,
  getId,
  isItemStale,
}: {
  responseItems: readonly unknown[]
  journalEvents: readonly ProcessedRealtimeEvent[]
  getId: (item: unknown) => ItemId | undefined
  isItemStale: (current: unknown, next: unknown) => boolean
}): FetchRebasePlan {
  const responseItemsById = new Map<EntityKey, unknown>()
  for (const item of responseItems) {
    const itemId = getId(item)
    if (itemId !== undefined) responseItemsById.set(entityKey(itemId), item)
  }

  const latestJournalEventById = new Map<EntityKey, ProcessedRealtimeEvent>()
  for (const event of journalEvents) {
    latestJournalEventById.set(event.itemId, event)
  }

  // isItemStale(current, next) means `next` is older. If the event is older
  // than the response row, the server computed that row after the event and no
  // replay is needed. Missing or equal timestamps remain conservative.
  const supersededItemIds = new Set<EntityKey>()
  for (const [itemId, event] of latestJournalEventById) {
    const responseItem = responseItemsById.get(itemId)
    if (responseItem !== undefined && isItemStale(responseItem, event.item)) {
      supersededItemIds.add(itemId)
    }
  }

  const events = journalEvents.filter(event => !supersededItemIds.has(event.itemId))
  const latestEventById = new Map<EntityKey, ProcessedRealtimeEvent>()
  for (const event of events) {
    latestEventById.set(event.itemId, event)
  }

  return { events, latestEventById, itemIds: new Set(latestEventById.keys()) }
}

export interface RebasedResponse {
  readonly data: unknown
  readonly items: readonly unknown[]
  readonly itemIds: ReadonlySet<EntityKey>
}

export type FetchResponseMode = 'entity' | 'projection' | 'snapshot'

function overlayProjectionItem(
  responseItem: unknown,
  event: ProcessedRealtimeEvent,
): unknown | undefined {
  if (event.type === 'removed') return undefined
  if (
    !responseItem ||
    typeof responseItem !== 'object' ||
    Array.isArray(responseItem) ||
    !event.item ||
    typeof event.item !== 'object' ||
    Array.isArray(event.item)
  ) {
    return responseItem
  }

  const response = responseItem as Record<string, unknown>
  const projected = { ...response }
  const authoritative = event.item as Record<string, unknown>
  for (const key of Object.keys(response)) {
    if (Object.prototype.hasOwnProperty.call(authoritative, key)) {
      projected[key] = authoritative[key]
    }
  }
  return projected
}

/**
 * Rebase response values over newer cached entities for realtime-aware queries.
 * Snapshots preserve exact server values. Entity responses may reuse newer cached
 * rows. Projections apply known newer values only within the server-returned shape;
 * a partial row must never be promoted to canonical entity authority.
 */
export function rebaseResponseData({
  data,
  mode,
  latestEventById,
  entities,
  getId,
  isItemStale,
  canKeepCurrentItem,
}: {
  data: unknown
  mode: FetchResponseMode
  latestEventById: ReadonlyMap<EntityKey, ProcessedRealtimeEvent>
  entities: ReadonlyMap<EntityKey, unknown>
  getId: (item: unknown) => ItemId | undefined
  isItemStale: (current: unknown, next: unknown) => boolean
  canKeepCurrentItem: (item: unknown) => boolean
}): RebasedResponse {
  const rebaseItem = (item: unknown): unknown | undefined => {
    if (mode === 'snapshot') return item

    const itemId = getId(item)
    if (itemId === undefined) return item
    const key = entityKey(itemId)

    const journalEvent = latestEventById.get(key)
    if (mode === 'projection') {
      return journalEvent ? overlayProjectionItem(item, journalEvent) : item
    }

    const currentItem = entities.get(key)
    if (journalEvent) {
      // Preserve response membership until ordered replay updates meta and get
      // errors. The stale response value itself never replaces the cache value.
      return journalEvent.type === 'removed' ? item : (currentItem ?? item)
    }
    if (!currentItem || !isItemStale(currentItem, item)) return item
    return canKeepCurrentItem(currentItem) ? currentItem : undefined
  }

  const rebasedData = Array.isArray(data)
    ? data.reduce<unknown[]>((items, item) => {
        const rebasedItem = rebaseItem(item)
        if (rebasedItem !== undefined) items.push(rebasedItem)
        return items
      }, [])
    : data == null
      ? data
      : rebaseItem(data)
  const items = Array.isArray(rebasedData) ? rebasedData : rebasedData == null ? [] : [rebasedData]
  const itemIds = new Set<EntityKey>()
  for (const item of items) {
    const itemId = getId(item)
    if (itemId !== undefined) itemIds.add(entityKey(itemId))
  }

  return { data: rebasedData, items, itemIds }
}
