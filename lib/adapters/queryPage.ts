import type { PageCursor, PageInfo } from './adapter.js'

export type PageContinuation =
  | { kind: 'done' }
  | { kind: 'offset'; offset: number }
  | { kind: 'cursor'; cursor: PageCursor }

/** The engine's page view, independent of the adapter's metadata envelope. */
export interface QueryPage {
  rows: unknown[]
  total: number | undefined
  continuation: PageContinuation
}

export const EMPTY_PAGE: QueryPage = { rows: [], total: undefined, continuation: { kind: 'done' } }

/**
 * The page size the server actually served. Feathers caps a requested `$limit` at
 * `paginate.max` and reports the effective limit, so a full capped page is not the
 * last one; the requested limit stands in when the server reports none.
 */
export function servedLimit(meta: unknown, requested: unknown): number | undefined {
  const reported = meta && typeof meta === 'object' && 'limit' in meta ? meta.limit : undefined
  if (typeof reported === 'number') return reported
  return typeof requested === 'number' ? requested : undefined
}

/** Normalize current rows as well as fetched rows, so realtime totals stay current. */
export function queryPage({
  rows,
  meta,
  query,
  pageInfo,
  allPages,
}: {
  rows: unknown[]
  meta: unknown
  query: Record<string, unknown> | undefined
  pageInfo?: PageInfo | undefined
  allPages: boolean
}): QueryPage {
  const metadata = meta && typeof meta === 'object' ? meta : {}
  const reportedTotal = pageInfo?.total ?? ('total' in metadata ? metadata.total : undefined)
  const total = typeof reportedTotal === 'number' && reportedTotal >= 0 ? reportedTotal : undefined
  if (pageInfo) {
    return {
      rows,
      total,
      continuation: pageInfo.hasMore
        ? { kind: 'cursor', cursor: pageInfo.endCursor }
        : { kind: 'done' },
    }
  }
  const limit = servedLimit(metadata, query?.$limit)
  const offset = typeof query?.$skip === 'number' ? query.$skip : 0
  return {
    rows,
    total,
    continuation:
      !allPages && typeof limit === 'number' && limit > 0 && rows.length >= limit
        ? { kind: 'offset', offset: offset + limit }
        : { kind: 'done' },
  }
}
