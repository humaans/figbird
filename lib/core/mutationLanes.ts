import type {
  EventType,
  MutationDescriptor,
  ProcessedProjectionEvent,
  ProcessedRealtimeEvent,
} from './queryTypes.js'

export type ItemId = string | number

export const ABSENT = Symbol('figbird.absent')
export type ProjectedEntity = unknown | typeof ABSENT

export interface MutationLaneEntry {
  desc: MutationDescriptor
  optimistic: boolean
}

/** Opaque identity for a lane; mutable lane state stays inside MutationLanes. */
export interface MutationLane {
  readonly key: string
  readonly serviceName: string
  readonly id: ItemId
}

interface MutationLaneState<TEntry extends MutationLaneEntry> extends MutationLane {
  base: ProjectedEntity
  visible: ProjectedEntity
  lastPresent: unknown | null
  entries: TEntry[]
  running: boolean
  deferredQueryIds: Set<string>
  deferredProjection: ProcessedProjectionEvent | null
}

export interface ProjectionChange {
  lane: MutationLane
  previous: ProjectedEntity
  next: ProjectedEntity
}

export interface AuthoritativeTransition {
  projection: ProjectionChange
  event: ProcessedRealtimeEvent
}

export type MutationOutcome = { ok: true; item: unknown } | { ok: false; error: Error }

export interface LaneSettlement<TEntry extends MutationLaneEntry> {
  projection: ProjectionChange
  cancelled: TEntry[]
  authoritativeEvent: ProcessedRealtimeEvent | null
}

export interface ReleasedLaneEffects {
  projection: ProcessedProjectionEvent | null
  queryIds: ReadonlySet<string>
}

/** Owns each entity's confirmed base and every transition of its mutation queue. */
export class MutationLanes<TEntry extends MutationLaneEntry> {
  readonly #lanes = new Map<string, MutationLaneState<TEntry>>()
  readonly #getId: (item: unknown) => ItemId | undefined

  constructor(getId: (item: unknown) => ItemId | undefined) {
    this.#getId = getId
  }

  get(serviceName: string, id: ItemId): MutationLane | undefined {
    return this.#lanes.get(this.#key(serviceName, id))
  }

  ensure(serviceName: string, id: ItemId, cached: unknown): MutationLane {
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
      deferredProjection: null,
    }
    this.#lanes.set(key, lane)
    return lane
  }

  enqueue(lane: MutationLane, entry: TEntry): ProjectionChange {
    const state = this.#require(lane)
    state.entries.push(entry)
    return this.#reproject(state)
  }

  peekNext(lane: MutationLane): TEntry | undefined {
    return this.#require(lane).entries[0]
  }

  predecessors(lane: MutationLane, entry: TEntry): readonly TEntry[] {
    const state = this.#require(lane)
    const index = state.entries.indexOf(entry)
    return index <= 0 ? [] : state.entries.slice(0, index)
  }

  replaceTail(
    lane: MutationLane,
    entry: TEntry,
    desc: MutationDescriptor,
  ): ProjectionChange | null {
    const state = this.#require(lane)
    if (state.entries.at(-1) !== entry) return null
    entry.desc = desc
    return this.#reproject(state)
  }

  cancel(lane: MutationLane, entry: TEntry): ProjectionChange | null {
    const state = this.#lanes.get(lane.key)
    if (state !== lane) return null
    const index = state.entries.indexOf(entry)
    if (index === -1) return null
    state.entries.splice(index, 1)
    return this.#reproject(state)
  }

  takeNext(lane: MutationLane): TEntry | undefined {
    const state = this.#require(lane)
    if (state.running) return undefined
    const entry = state.entries[0]
    if (entry) state.running = true
    return entry
  }

  settle(
    lane: MutationLane,
    entry: TEntry,
    outcome: MutationOutcome,
  ): LaneSettlement<TEntry> | null {
    const state = this.#lanes.get(lane.key)
    if (state !== lane) return null
    const index = state.entries.indexOf(entry)
    // Cancelled dependants reject their gates after the lane has forgotten them.
    if (index === -1) return null

    state.entries.splice(index, 1)
    state.running = false

    let cancelled: TEntry[] = []
    if (!outcome.ok && entry.desc.method === 'create') {
      cancelled = state.entries.splice(0)
    } else if (!outcome.ok && entry.desc.method === 'remove') {
      const nextCreate = state.entries.findIndex(queued => queued.desc.method === 'create')
      if (nextCreate !== -1) cancelled = state.entries.splice(nextCreate)
    } else if (outcome.ok && entry.desc.method === 'remove') {
      const nextCreate = state.entries.findIndex(queued => queued.desc.method === 'create')
      const end = nextCreate === -1 ? state.entries.length : nextCreate
      cancelled = state.entries.splice(0, end)
    }
    let authoritativeEvent: ProcessedRealtimeEvent | null = null

    if (outcome.ok) {
      const type = MUTATION_EVENT_TYPE[entry.desc.method]
      const previousItem = state.base === ABSENT ? null : state.base
      const eventItem =
        entry.desc.method === 'remove' ? (outcome.item ?? state.lastPresent) : outcome.item
      this.#setBase(state, type, outcome.item)
      if (eventItem !== null && eventItem !== undefined) {
        authoritativeEvent = {
          origin: 'authoritative',
          serviceName: state.serviceName,
          type,
          item: eventItem,
          previousItem,
          itemId: state.id,
        }
      }
    }

    return {
      projection: this.#reproject(state),
      cancelled,
      authoritativeEvent,
    }
  }

  acceptAuthoritative(lane: MutationLane, type: EventType, item: unknown): AuthoritativeTransition
  acceptAuthoritative(
    lane: MutationLane,
    type: EventType,
    item: unknown,
    isItemStale: (current: unknown, next: unknown) => boolean,
  ): AuthoritativeTransition | null
  acceptAuthoritative(
    lane: MutationLane,
    type: EventType,
    item: unknown,
    isItemStale?: (current: unknown, next: unknown) => boolean,
  ): AuthoritativeTransition | null {
    const state = this.#require(lane)
    const previousItem = state.base === ABSENT ? null : state.base
    if (
      isItemStale &&
      (type === 'updated' || type === 'patched') &&
      previousItem &&
      isItemStale(previousItem, item)
    ) {
      return null
    }

    this.#setBase(state, type, item)
    return {
      projection: this.#reproject(state),
      event: {
        origin: 'authoritative',
        serviceName: state.serviceName,
        type,
        item,
        previousItem,
        itemId: state.id,
      },
    }
  }

  deferQueryIds(laneKey: string, queryIds: Iterable<string>): boolean {
    const lane = this.#lanes.get(laneKey)
    if (!lane) return false
    for (const queryId of queryIds) lane.deferredQueryIds.add(queryId)
    return true
  }

  deferProjection(laneKey: string, event: ProcessedProjectionEvent): boolean {
    const lane = this.#lanes.get(laneKey)
    if (!lane) return false
    const first = lane.deferredProjection
    if (!first) {
      lane.deferredProjection = event
      return true
    }

    // A typing burst can produce hundreds of projections. Relational consumers
    // need one cumulative transition when the lane drains, not the full history.
    lane.deferredProjection = {
      ...event,
      type:
        event.type === 'removed' ? 'removed' : first.previousItem === null ? 'created' : 'patched',
      previousItem: first.previousItem,
    }
    return true
  }

  release(lane: MutationLane): ReleasedLaneEffects | null {
    const state = this.#require(lane)
    if (state.running || state.entries.length > 0) return null
    this.#lanes.delete(state.key)
    return {
      projection: state.deferredProjection,
      queryIds: state.deferredQueryIds,
    }
  }

  overlayEvents(serviceName: string): ProcessedProjectionEvent[] {
    const events: ProcessedProjectionEvent[] = []
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

  #setBase(state: MutationLaneState<TEntry>, type: EventType, item: unknown): void {
    state.base = type === 'removed' ? ABSENT : item
    if (type !== 'removed') state.lastPresent = item
  }

  #reproject(state: MutationLaneState<TEntry>): ProjectionChange {
    const previous = state.visible
    let next = state.base
    for (const entry of state.entries) {
      if (entry.optimistic) next = this.#applyIntent(next, entry.desc)
    }
    state.visible = next
    if (next !== ABSENT) state.lastPresent = next
    return { lane: state, previous, next }
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
    const data = (desc.optimisticPatch ?? desc.data) as Record<string, unknown>
    if (!currentRecord && this.#getId(data) === undefined) return current
    return { ...(currentRecord ?? {}), ...data }
  }

  #require(lane: MutationLane): MutationLaneState<TEntry> {
    const state = this.#lanes.get(lane.key)
    if (state !== lane) throw new Error(`figbird: inactive mutation lane ${lane.key}`)
    return state
  }

  #key(serviceName: string, id: ItemId): string {
    return JSON.stringify([serviceName, String(id)])
  }
}

export const MUTATION_EVENT_TYPE = {
  create: 'created',
  update: 'updated',
  patch: 'patched',
  remove: 'removed',
} as const satisfies Record<MutationDescriptor['method'], EventType>
