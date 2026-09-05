import {
  classifyStoredQuery,
  isProjectionQuery,
  type StoredQueryClass,
} from './queryClassification.js'
import { buildComparator } from './sort.js'
import { queryOfParams, type QueryDescriptor, type QueryConfig } from './queryTypes.js'

export interface QueryMaintenance {
  classification: StoredQueryClass
  matches: (item: unknown) => boolean
  matchesLocal: (item: unknown) => boolean
  compare: ((a: unknown, b: unknown) => number) | undefined
  limit: number | undefined
  skip: number
  isProjection: boolean
}

/** Split window operators off a query so the rest can feed the local matcher. */
function splitWindow(q: Record<string, unknown> | undefined): {
  filters: Record<string, unknown> | undefined
  sort: Record<string, number> | undefined
  limit: number | undefined
  skip: number
} {
  if (!q) return { filters: undefined, sort: undefined, limit: undefined, skip: 0 }
  const { $sort, $limit, $skip, ...filters } = q
  return {
    filters: Object.keys(filters).length > 0 ? filters : undefined,
    sort: $sort as Record<string, number> | undefined,
    limit: $limit as number | undefined,
    skip: ($skip as number | undefined) ?? 0,
  }
}

/** Resolve immutable query rules once, preserving the distinct matcher inputs. */
export function compileQueryMaintenance({
  desc,
  config,
  defaultSort,
  localOperators,
  matcher,
}: {
  desc: QueryDescriptor
  config: QueryConfig
  defaultSort: Record<string, number> | undefined
  localOperators: ReadonlySet<string>
  matcher: (query: Record<string, unknown> | undefined) => (item: unknown) => boolean
}): QueryMaintenance {
  const query = queryOfParams(desc.params)
  const classification = classifyStoredQuery(desc.method, query, {
    server: config.server,
    allPages: 'allPages' in config && config.allPages === true,
    localOperators,
  })
  const { filters, sort, limit, skip } = splitWindow(query)
  const effectiveSort = sort ?? defaultSort
  // Local reads also serve queries with realtime disabled. Find matchers receive
  // only predicates here, while realtime matchers retain the original query input.
  let localMatcher: ((item: unknown) => boolean) | undefined
  return {
    classification,
    matches:
      config.realtime === 'merge' && classification !== 'server-authoritative'
        ? matcher(query)
        : () => false,
    matchesLocal: item =>
      (localMatcher ??= matcher(desc.method === 'find' ? filters : query))(item),
    compare: effectiveSort ? buildComparator(effectiveSort) : undefined,
    limit,
    skip,
    isProjection: isProjectionQuery(query),
  }
}
