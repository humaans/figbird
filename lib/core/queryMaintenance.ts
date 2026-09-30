import {
  classifyStoredQuery,
  isProjectionQuery,
  isServerMaintained,
  usesFetchOwnedRows,
  type StoredQueryClass,
} from './queryClassification.js'
import { buildComparator, type ValueComparator } from './sort.js'
import {
  queryOfParams,
  type MatchResult,
  type QueryDescriptor,
  type QueryConfig,
} from './queryTypes.js'

export type FetchResponseMode = 'entity' | 'projection' | 'snapshot' | 'fetch-owned'

export interface QueryMaintenance {
  classification: StoredQueryClass
  matches: (item: unknown) => MatchResult
  matchesLocal: (item: unknown) => MatchResult
  compare: ((a: unknown, b: unknown) => number) | undefined
  limit: number | undefined
  skip: number
  isProjection: boolean
  responseMode: FetchResponseMode
  /** Preferred row ownership; missing IDs still force a query to retain its own values. */
  rowSource: 'entities' | 'values'
  /** Whether event replay may change membership through the local matcher. */
  mergeEvents: boolean
  /** Keep visible row values current when a membership merge cannot be proved. */
  replayVisibleEvents: boolean
  /** Whether a newer entity can be rejected by the fetched query's local predicate. */
  rebaseMembership: boolean
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
  compare,
  localOperators,
  matcher,
}: {
  desc: QueryDescriptor
  config: QueryConfig
  defaultSort: Record<string, number> | undefined
  compare: ValueComparator
  localOperators: ReadonlySet<string>
  matcher: (query: Record<string, unknown> | undefined) => (item: unknown) => MatchResult
}): QueryMaintenance {
  const query = queryOfParams(desc.params)
  const classification = classifyStoredQuery(desc.method, query, {
    server: config.server,
    allPages: 'allPages' in config && config.allPages === true,
    localOperators,
  })
  const isProjection = isProjectionQuery(query)
  const responseMode: FetchResponseMode =
    config.realtime === 'disabled'
      ? 'snapshot'
      : isProjection
        ? 'projection'
        : usesFetchOwnedRows(classification, config.realtime)
          ? 'fetch-owned'
          : 'entity'
  const { filters, sort, limit, skip } = splitWindow(query)
  const effectiveSort = sort ?? defaultSort
  // Local reads also serve queries with realtime disabled. Find matchers receive
  // only predicates here, while realtime matchers retain the original query input.
  let localMatcher: ((item: unknown) => MatchResult) | undefined
  return {
    classification,
    matches:
      config.realtime === 'merge' && classification !== 'server-authoritative'
        ? matcher(query)
        : () => false,
    matchesLocal: item =>
      (localMatcher ??= matcher(desc.method === 'find' ? filters : query))(item),
    compare: effectiveSort ? buildComparator(effectiveSort, compare) : undefined,
    limit,
    skip,
    isProjection,
    responseMode,
    rowSource:
      responseMode !== 'entity' || config.fetchPolicy === 'network-only' ? 'values' : 'entities',
    mergeEvents:
      config.realtime === 'merge' &&
      !(desc.method === 'find' && config.fetchPolicy === 'network-only'),
    replayVisibleEvents:
      config.realtime === 'refetch' ||
      config.fetchPolicy === 'network-only' ||
      isServerMaintained(classification),
    rebaseMembership: config.realtime === 'merge' && !isServerMaintained(classification),
  }
}
