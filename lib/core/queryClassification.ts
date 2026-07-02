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

const LOCAL_QUERY_OPERATORS = new Set(['$in', '$nin', '$lt', '$lte', '$gt', '$gte', '$ne', '$or'])
const SERVER_WINDOW_QUERY_FILTERS = new Set(['$limit', '$skip', '$sort'])
const SERVER_ONLY_QUERY_FILTERS = new Set(['$select'])

export function hasServerMaintainedQuerySemantics(
  value: unknown,
  { includeWindowFilters }: { includeWindowFilters: boolean },
): boolean {
  if (!value || typeof value !== 'object') {
    return false
  }

  if (Array.isArray(value)) {
    return value.some(item => hasServerMaintainedQuerySemantics(item, { includeWindowFilters }))
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith('$')) {
      if (SERVER_ONLY_QUERY_FILTERS.has(key)) {
        return true
      }

      if (SERVER_WINDOW_QUERY_FILTERS.has(key)) {
        return includeWindowFilters
      }

      if (!LOCAL_QUERY_OPERATORS.has(key)) {
        return true
      }
    }

    if (hasServerMaintainedQuerySemantics(child, { includeWindowFilters })) {
      return true
    }
  }

  return false
}

export function isServerMaintainedFindQuery(
  desc: FindDescriptor,
  config: { server?: boolean; allPages?: boolean },
): boolean {
  if (config.server) {
    return true
  }

  const query = (desc.params as { query?: Record<string, unknown> } | undefined)?.query
  return query
    ? hasServerMaintainedQuerySemantics(query, {
        includeWindowFilters: !config.allPages,
      })
    : false
}
