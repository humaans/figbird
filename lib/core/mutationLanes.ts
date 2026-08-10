import type { EventType, MutationDescriptor, ProcessedRealtimeEvent } from './queryTypes.js'

export type ItemId = string | number

export const ABSENT = Symbol('figbird.absent')
export type ProjectedEntity = unknown | typeof ABSENT

export interface MutationLaneEntry {
  desc: MutationDescriptor
  optimistic: boolean
}

export interface MutationLane<TEntry extends MutationLaneEntry> {
  key: string
  serviceName: string
  id: ItemId
  base: ProjectedEntity
  visible: ProjectedEntity
  lastPresent: unknown | null
  entries: TEntry[]
  running: boolean
  deferredQueryIds: Set<string>
  deferredProcessedEvents: ProcessedRealtimeEvent[]
}

export interface ProjectionChange<TEntry extends MutationLaneEntry> {
  lane: MutationLane<TEntry>
  previous: ProjectedEntity
  next: ProjectedEntity
}

/** Owns each entity's confirmed base and folds its unsettled optimistic intents. */
export class MutationLanes<TEntry extends MutationLaneEntry> {
  readonly #lanes = new Map<string, MutationLane<TEntry>>()
  readonly #getId: (item: unknown) => ItemId | undefined

  constructor(getId: (item: unknown) => ItemId | undefined) {
    this.#getId = getId
  }

  get(serviceName: string, id: ItemId): MutationLane<TEntry> | undefined {
    return this.#lanes.get(this.#key(serviceName, id))
  }

  getByKey(key: string): MutationLane<TEntry> | undefined {
    return this.#lanes.get(key)
  }

  ensure(serviceName: string, id: ItemId, cached: unknown): MutationLane<TEntry> {
    const key = this.#key(serviceName, id)
    let lane = this.#lanes.get(key)
    if (lane) return lane

    const base = cached ?? ABSENT
    lane = {
      key,
      serviceName,
      id,
      base,
      visible: base,
      lastPresent: cached ?? null,
      entries: [],
      running: false,
      deferredQueryIds: new Set(),
      deferredProcessedEvents: [],
    }
    this.#lanes.set(key, lane)
    return lane
  }

  acceptAuthoritative(
    lane: MutationLane<TEntry>,
    type: EventType,
    item: unknown,
  ): ProjectionChange<TEntry>
  acceptAuthoritative(
    lane: MutationLane<TEntry>,
    type: EventType,
    item: unknown,
    isItemStale: (current: unknown, next: unknown) => boolean,
  ): ProjectionChange<TEntry> | null
  acceptAuthoritative(
    lane: MutationLane<TEntry>,
    type: EventType,
    item: unknown,
    isItemStale?: (current: unknown, next: unknown) => boolean,
  ): ProjectionChange<TEntry> | null {
    const previousBase = lane.base === ABSENT ? null : lane.base
    if (
      isItemStale &&
      (type === 'updated' || type === 'patched') &&
      previousBase &&
      isItemStale(previousBase, item)
    ) {
      return null
    }

    lane.base = type === 'removed' ? ABSENT : item
    if (type !== 'removed') lane.lastPresent = item
    return this.reproject(lane)
  }

  reproject(lane: MutationLane<TEntry>): ProjectionChange<TEntry> {
    const previous = lane.visible
    let next = lane.base
    for (const entry of lane.entries) {
      if (entry.optimistic) next = this.#applyIntent(next, entry.desc)
    }
    lane.visible = next
    if (next !== ABSENT) lane.lastPresent = next
    return { lane, previous, next }
  }

  release(lane: MutationLane<TEntry>): boolean {
    if (lane.running || lane.entries.length > 0) return false
    if (this.#lanes.get(lane.key) !== lane) return false
    this.#lanes.delete(lane.key)
    return true
  }

  overlayEvents(serviceName: string): ProcessedRealtimeEvent[] {
    const events: ProcessedRealtimeEvent[] = []
    for (const lane of this.#lanes.values()) {
      if (lane.serviceName !== serviceName || !lane.entries.some(entry => entry.optimistic))
        continue
      const previousItem = lane.base === ABSENT ? null : lane.base
      if (lane.visible === ABSENT) {
        if (!lane.lastPresent) continue
        events.push({
          origin: 'projection',
          serviceName,
          type: 'removed',
          item: lane.lastPresent,
          previousItem,
          itemId: lane.id,
          mutationLaneKey: lane.key,
        })
      } else {
        events.push({
          origin: 'projection',
          serviceName,
          type: lane.base === ABSENT ? 'created' : 'patched',
          item: lane.visible,
          previousItem,
          itemId: lane.id,
          mutationLaneKey: lane.key,
        })
      }
    }
    return events
  }

  #applyIntent(current: ProjectedEntity, desc: MutationDescriptor): ProjectedEntity {
    const explicit =
      desc.optimistic !== undefined && desc.optimistic !== true && desc.optimistic !== false
        ? desc.optimistic
        : null
    if (desc.method === 'create') return explicit ?? desc.data
    if (desc.method === 'remove') return ABSENT
    if (explicit !== null) return explicit

    const currentRecord =
      current !== ABSENT && current && typeof current === 'object'
        ? (current as Record<string, unknown>)
        : null
    const data = desc.data as Record<string, unknown>
    if (!currentRecord && this.#getId(data) === undefined) return current
    return { ...(currentRecord ?? {}), ...data }
  }

  #key(serviceName: string, id: ItemId): string {
    return JSON.stringify([serviceName, typeof id, id])
  }
}
