import type { FindDescriptor } from './queryTypes.js'

/**
 * Query classification — the single place that decides how a query node can be
 * maintained by the client:
 *
 * - **local-exact** — membership/order/values are provable from local state; realtime
 *   events merge into the cached result via the matcher.
 * - **server-window** — the query is windowed (`$limit`/`$skip`/`$sort` without
 *   `allPages`); visible rows are known but unseen rows may enter or leave, so events
 *   trigger a server refetch instead of a local merge.
 * - **server-authoritative** — membership/order/values depend on server-only logic
 *   (`.server()`, `$select`, or operators the local matcher cannot evaluate); events
 *   always trigger a refetch.
 */
export type QueryNodeClass = 'local-exact' | 'server-window' | 'server-authoritative'

const LOCAL_QUERY_OPERATORS = new Set(['$in', '$nin', '$lt', '$lte', '$gt', '$gte', '$ne', '$or'])
const SERVER_WINDOW_QUERY_FILTERS = new Set(['$limit', '$skip', '$sort'])
const SERVER_ONLY_QUERY_FILTERS = new Set(['$select'])

/**
 * Classify a query node by how it can be maintained. `server: true` (the `.server()`
 * escape hatch) forces server-authoritative; `allPages: true` neutralises window
 * filters because the full result set is fetched, making membership locally provable.
 */
export function classifyQueryNode(
  query: unknown,
  { server, allPages }: { server?: boolean | undefined; allPages?: boolean | undefined } = {},
): QueryNodeClass {
  if (server) return 'server-authoritative'
  if (scanForServerOnlySemantics(query)) return 'server-authoritative'
  if (!allPages && hasWindowFilters(query)) return 'server-window'
  return 'local-exact'
}

/** True when the query uses `$limit`/`$skip`/`$sort` anywhere. */
export function hasWindowFilters(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false

  if (Array.isArray(value)) {
    return value.some(item => hasWindowFilters(item))
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SERVER_WINDOW_QUERY_FILTERS.has(key)) return true
    if (hasWindowFilters(child)) return true
  }

  return false
}

function scanForServerOnlySemantics(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false

  if (Array.isArray(value)) {
    return value.some(item => scanForServerOnlySemantics(item))
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith('$')) {
      if (SERVER_ONLY_QUERY_FILTERS.has(key)) return true
      if (!SERVER_WINDOW_QUERY_FILTERS.has(key) && !LOCAL_QUERY_OPERATORS.has(key)) return true
    }
    if (scanForServerOnlySemantics(child)) return true
  }

  return false
}

/**
 * A find query the client must not merge realtime events into locally — anything
 * classified above local-exact refetches instead.
 */
export function isServerMaintainedFindQuery(
  desc: FindDescriptor,
  config: { server?: boolean; allPages?: boolean },
): boolean {
  const query = (desc.params as { query?: Record<string, unknown> } | undefined)?.query
  return (
    classifyQueryNode(query, { server: config.server, allPages: config.allPages }) !== 'local-exact'
  )
}
