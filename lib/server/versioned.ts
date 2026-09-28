import type { ChangeLog } from './changeLog.js'
import type { ChangeType } from './protocol.js'
import type { Sequencer } from './sequencer.js'

/** The slice of a Feathers `HookContext` the version hooks read and write. */
export interface VersionedHookContext {
  readonly path: string
  readonly method: string
  readonly service: unknown
  data?: unknown
  result?: unknown
  dispatch?: unknown
}

export type VersionedHook = (context: VersionedHookContext) => Promise<void>

export interface VersionedOptions {
  /** Row field holding the sequence of the row's last write. Defaults to `_v`. */
  field?: string
  sequencer: Sequencer
  log: ChangeLog
}

const METHOD_CHANGES: Record<string, ChangeType> = {
  create: 'created',
  update: 'updated',
  patch: 'patched',
  remove: 'removed',
}

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Stamp every write with the next change sequence and record it in the change
 * log. Register it after the service's own hooks, so the stamp is added once the
 * data is validated and resolved and the log append runs last:
 *
 * ```ts
 * app.service('people').hooks(versioned({ sequencer, log }))
 * ```
 *
 * create/update/patch store `data[field]`: each created row gets its own
 * sequence, and a multi-row patch shares one. A removal assigns a fresh sequence
 * to the removed result, so the `removed` event carries a newer version than any
 * earlier event for the row. Custom methods and reads are left alone.
 */
export function versioned({ field = '_v', sequencer, log }: VersionedOptions): {
  before: Record<'create' | 'update' | 'patch', VersionedHook[]>
  after: Record<'create' | 'update' | 'patch' | 'remove', VersionedHook[]>
} {
  // The sequences stamped on each call's data, for results that don't echo the
  // field back (a `$select` without it, say): the write must be logged either way.
  const stamped = new WeakMap<VersionedHookContext, number[]>()

  const stampData: VersionedHook = async context => {
    const seqs: number[] = []
    const stamp = async (data: unknown): Promise<unknown> => {
      if (!isRow(data)) return data
      const seq = await sequencer.next()
      seqs.push(seq)
      return { ...data, [field]: seq }
    }
    if (Array.isArray(context.data)) {
      const rows: unknown[] = []
      for (const data of context.data) rows.push(await stamp(data))
      context.data = rows
    } else {
      context.data = await stamp(context.data)
    }
    stamped.set(context, seqs)
  }

  const record: VersionedHook = async context => {
    const type = METHOD_CHANGES[context.method]
    if (!type) return
    if (type === 'removed') {
      const seq = await sequencer.next()
      const restamp = (value: unknown) =>
        Array.isArray(value)
          ? value.map(row => (isRow(row) ? { ...row, [field]: seq } : row))
          : isRow(value)
            ? { ...value, [field]: seq }
            : value
      context.result = restamp(context.result)
      if (context.dispatch !== undefined) context.dispatch = restamp(context.dispatch)
    }
    const idField = serviceIdField(context.service)
    const rows: unknown[] = Array.isArray(context.result) ? context.result : [context.result]
    const seqs = stamped.get(context) ?? []
    for (const [index, row] of rows.entries()) {
      if (!isRow(row)) continue
      const version = row[field]
      const seq = typeof version === 'number' ? version : (seqs[index] ?? seqs[0])
      const id = row[idField]
      if (seq === undefined || (typeof id !== 'string' && typeof id !== 'number')) continue
      await log.append({ seq, service: context.path, id, type })
    }
  }

  return {
    before: { create: [stampData], update: [stampData], patch: [stampData] },
    after: { create: [record], update: [record], patch: [record], remove: [record] },
  }
}

/** Feathers database adapters expose their primary key as `service.id`. */
export function serviceIdField(service: unknown): string {
  const id = isRow(service) ? service.id : undefined
  return typeof id === 'string' ? id : 'id'
}
