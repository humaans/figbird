import type { ProcessedRealtimeEvent } from './queryTypes.js'

type ItemId = string | number

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
  readonly latestEventById: ReadonlyMap<ItemId, ProcessedRealtimeEvent>
  readonly itemIds: ReadonlySet<ItemId>
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
  const responseItemsById = new Map<ItemId, unknown>()
  for (const item of responseItems) {
    const itemId = getId(item)
    if (itemId !== undefined) responseItemsById.set(itemId, item)
  }

  const latestJournalEventById = new Map<ItemId, ProcessedRealtimeEvent>()
  for (const event of journalEvents) {
    latestJournalEventById.set(event.itemId, event)
  }

  // isItemStale(current, next) means `next` is older. If the event is older
  // than the response row, the server computed that row after the event and no
  // replay is needed. Missing or equal timestamps remain conservative.
  const supersededItemIds = new Set<ItemId>()
  for (const [itemId, event] of latestJournalEventById) {
    const responseItem = responseItemsById.get(itemId)
    if (responseItem !== undefined && isItemStale(responseItem, event.item)) {
      supersededItemIds.add(itemId)
    }
  }

  const events = journalEvents.filter(event => !supersededItemIds.has(event.itemId))
  const latestEventById = new Map<ItemId, ProcessedRealtimeEvent>()
  for (const event of events) {
    latestEventById.set(event.itemId, event)
  }

  return { events, latestEventById, itemIds: new Set(latestEventById.keys()) }
}

export interface RebasedResponse {
  readonly data: unknown
  readonly items: readonly unknown[]
  readonly itemIds: ReadonlySet<ItemId>
}

/**
 * Rebase response values over newer cached entities for realtime-aware queries.
 * Some queries must keep their server response items unchanged: snapshots preserve
 * exact values, while projections preserve a partial row shape. Cache protection
 * remains a separate store concern.
 */
export function rebaseResponseData({
  data,
  preserveResponseItems,
  latestEventById,
  entities,
  getId,
  isItemStale,
  canKeepCurrentItem,
}: {
  data: unknown
  preserveResponseItems: boolean
  latestEventById: ReadonlyMap<ItemId, ProcessedRealtimeEvent>
  entities: ReadonlyMap<ItemId, unknown>
  getId: (item: unknown) => ItemId | undefined
  isItemStale: (current: unknown, next: unknown) => boolean
  canKeepCurrentItem: (item: unknown) => boolean
}): RebasedResponse {
  const rebaseItem = (item: unknown): unknown | undefined => {
    if (preserveResponseItems) return item

    const itemId = getId(item)
    if (itemId === undefined) return item

    const currentItem = entities.get(itemId)
    const journalEvent = latestEventById.get(itemId)
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
  const itemIds = new Set<ItemId>()
  for (const item of items) {
    const itemId = getId(item)
    if (itemId !== undefined) itemIds.add(itemId)
  }

  return { data: rebasedData, items, itemIds }
}
