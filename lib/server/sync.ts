import type { ServiceOrdering } from '../core/sort.js'
import type { ChangeEntry, ChangeLog } from './changeLog.js'
import type { SyncChange, SyncResult } from './protocol.js'
import type { Sequencer } from './sequencer.js'
import { serviceIdField } from './versioned.js'

/** The slice of Feathers `Params` the sync service reads and forwards. */
export interface SyncParams {
  query?: Record<string, unknown>
  [key: string]: unknown
}

export interface FigbirdSyncOptions {
  log: ChangeLog
  /** The sequencer passed to `versioned`. */
  sequencer: Sequencer
  /** Service paths a client may sync. Anything else is ignored. */
  services: readonly string[]
  /** Per-service ordering declarations served from `get('ordering')`. */
  ordering?: Record<string, ServiceOrdering>
  /** Row version field, as passed to `versioned`. Defaults to `_v`. */
  field?: string
  /**
   * How far before the client's cursor to replay, in sequence units. A sequence
   * is taken before the write and logged after it commits, so a slow write can
   * be logged — and emitted — after faster writes with higher sequences. Any
   * write that takes less than the overlap is replayed; re-sending changes the
   * client already has is harmless, since versions reject stale rows. Defaults
   * to 30 seconds for a sequencer with `unitsPerMs`, and is required otherwise.
   */
  overlap?: number
  /** Ids per authorized `$in` read. Defaults to 100. */
  batchSize?: number
}

class SyncServiceError extends Error {
  readonly code: number
  readonly className: string

  constructor(name: string, code: number, className: string, message: string) {
    super(message)
    this.name = name
    this.code = code
    this.className = className
  }
}

/**
 * The log no longer holds every change since the requested cursor. Shaped like
 * a Feathers `Gone` error, so clients see `{ name: 'Gone', code: 410 }` and fall
 * back to refetching.
 */
export class SyncTruncatedError extends SyncServiceError {
  constructor(since: number) {
    super('Gone', 410, 'gone', `figbird sync: changes since ${since} are no longer retained`)
  }
}

interface ReadableService {
  find(params: SyncParams): Promise<unknown>
}

interface SyncApplication {
  service(path: string): unknown
}

/**
 * A Feathers service that replays the changes a reconnecting client missed:
 *
 * ```ts
 * app.use('figbird/sync', figbirdSync({ log, services: ['people', 'teams'] }))
 * ```
 *
 * `find({ query: { since, services? } })` answers the latest change per row
 * since the cursor. Current rows are read back through the app's own services
 * with the caller's params, so a caller only receives rows it could read anyway;
 * only logged removals are reported as removed. A changed row the read-back
 * doesn't return — unreadable, or outside the service's default scope, which an
 * `$in` read can't reproduce — is reported as `invalidated`, id only, and the
 * client reconciles the queries that might hold it. Removals and invalidations
 * reveal that an id changed; clients act only on ids they hold. `get('ordering')`
 * serves the ordering declarations.
 */
export function figbirdSync({
  log,
  sequencer,
  services,
  ordering = {},
  field = '_v',
  overlap = timeDefault(sequencer, 'overlap', 30_000),
  batchSize = 100,
}: FigbirdSyncOptions): {
  setup(app: SyncApplication): Promise<void>
  find(params?: SyncParams): Promise<SyncResult>
  get(id: string | number): Promise<Record<string, ServiceOrdering>>
} {
  const allowed = new Set(services)
  let app: SyncApplication | undefined

  const readRows = async (
    service: ReadableService,
    idField: string,
    ids: Array<string | number>,
    params: SyncParams,
  ): Promise<Map<string, Record<string, unknown>>> => {
    const rows = new Map<string, Record<string, unknown>>()
    for (let start = 0; start < ids.length; start += batchSize) {
      const chunk = ids.slice(start, start + batchSize)
      const result = await service.find({
        ...params,
        query: { [idField]: { $in: chunk }, $limit: chunk.length },
        paginate: false,
      })
      const data = Array.isArray(result) ? result : (result as { data?: unknown } | null)?.data
      if (!Array.isArray(data)) continue
      for (const row of data as Array<Record<string, unknown>>) {
        rows.set(String(row[idField]), row)
      }
    }
    return rows
  }

  return {
    async setup(application) {
      app = application
    },

    async find(params = {}) {
      if (!app) throw new Error('figbird sync: the service was used before app.setup()')
      const since = Number(params.query?.since)
      if (!Number.isSafeInteger(since) || since < 0) {
        throw new SyncServiceError(
          'BadRequest',
          400,
          'bad-request',
          'figbird sync: `since` must be a non-negative integer',
        )
      }
      const requested = parseServices(params.query?.services)
      const names = requested ? requested.filter(name => allowed.has(name)) : [...allowed]

      const entries = await log.since(Math.max(0, since - overlap))
      if (entries === 'truncated') throw new SyncTruncatedError(since)

      let cursor = since
      const latest = new Map<string, Map<string, ChangeEntry>>(names.map(name => [name, new Map()]))
      for (const entry of entries) {
        cursor = Math.max(cursor, entry.seq)
        const byId = latest.get(entry.service)
        const previous = byId?.get(String(entry.id))
        if (byId && (!previous || entry.seq >= previous.seq)) byId.set(String(entry.id), entry)
      }

      // The caller's own params, so its permissions decide which rows it reads.
      const forwarded: SyncParams = { ...params }
      delete forwarded.query
      const services = new Map<string, { idField: string; rows: Map<string, SyncChange['item']> }>()
      for (const [name, byId] of latest) {
        if (byId.size === 0) continue
        const service = app.service(name)
        const idField = serviceIdField(service)
        const written = [...byId.values()].filter(entry => entry.type !== 'removed')
        const ids = written.map(entry => entry.id)
        const rows = await readRows(service as ReadableService, idField, ids, forwarded)
        services.set(name, { idField, rows })
      }

      const changes = [...latest.values()]
        .flatMap(byId => [...byId.values()])
        .sort((a, b) => a.seq - b.seq)
        .map((entry): SyncChange => {
          const { idField, rows } = services.get(entry.service)!
          const change = { service: entry.service, id: entry.id }
          if (entry.type === 'removed') {
            return { ...change, type: 'removed', item: { [idField]: entry.id, [field]: entry.seq } }
          }
          const row = rows.get(String(entry.id))
          return row
            ? { ...change, type: entry.type, item: row }
            : { ...change, type: 'invalidated', item: { [idField]: entry.id } }
        })
      return { cursor, services: names, changes }
    },

    async get(id) {
      if (id === 'ordering') return ordering
      throw new SyncServiceError('NotFound', 404, 'not-found', `figbird sync: no resource "${id}"`)
    },
  }
}

/** A default expressed in wall-clock time, for sequencers that track it. */
function timeDefault(sequencer: Sequencer, option: string, ms: number): number {
  if (sequencer.unitsPerMs === undefined) {
    throw new Error(
      `figbirdSync(): pass \`${option}\` in sequence units — the sequencer has no \`unitsPerMs\``,
    )
  }
  return ms * sequencer.unitsPerMs
}

function parseServices(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  const names = typeof value === 'string' ? value.split(',') : value
  if (!Array.isArray(names) || !names.every(name => typeof name === 'string')) {
    throw new SyncServiceError(
      'BadRequest',
      400,
      'bad-request',
      'figbird sync: `services` must be a list of service paths',
    )
  }
  return names
}
