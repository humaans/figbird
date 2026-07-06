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
 * A single structured reason contributing to a query node's classification.
 * `code` is stable (assertable in tests, renderable in devtools); `detail` names the
 * specific operator or filter that triggered it.
 */
export interface ClassificationReason {
  code: 'server-flag' | 'select-projection' | 'server-only-operator' | 'window-filter' | 'snapshot'
  detail?: string
}

export interface ClassifyOptions {
  server?: boolean | undefined
  allPages?: boolean | undefined
  /**
   * Operator names the app has taught the client to evaluate (the adapter's custom
   * operator registry) — they classify as local alongside the built-ins.
   */
  localOperators?: ReadonlySet<string> | undefined
}

/**
 * Classify a query node by how it can be maintained. `server: true` (the `.server()`
 * escape hatch) forces server-authoritative; `allPages: true` neutralises window
 * filters because the full result set is fetched, making membership locally provable;
 * `localOperators` extends the locally-evaluable operator set with adapter-registered
 * custom operators.
 */
export function classifyQueryNode(query: unknown, options: ClassifyOptions = {}): QueryNodeClass {
  return explainQueryNode(query, options).class
}

/**
 * Like `classifyQueryNode`, but says *why*: returns the classification together with
 * the structured reasons that produced it. Powers `figbird.explain()`.
 */
export function explainQueryNode(
  query: unknown,
  { server, allPages, localOperators }: ClassifyOptions = {},
): { class: QueryNodeClass; reasons: ClassificationReason[] } {
  const authoritative: ClassificationReason[] = []
  if (server) authoritative.push({ code: 'server-flag', detail: '.server()' })
  collectServerOnlyReasons(query, authoritative, localOperators)

  const window: ClassificationReason[] = []
  if (!allPages) collectWindowReasons(query, window)

  if (authoritative.length > 0) {
    return { class: 'server-authoritative', reasons: [...authoritative, ...window] }
  }
  if (window.length > 0) {
    return { class: 'server-window', reasons: window }
  }
  return { class: 'local-exact', reasons: [] }
}

function collectWindowReasons(value: unknown, reasons: ClassificationReason[]): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectWindowReasons(item, reasons)
    return
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SERVER_WINDOW_QUERY_FILTERS.has(key)) {
      reasons.push({ code: 'window-filter', detail: key })
    }
    collectWindowReasons(child, reasons)
  }
}

function collectServerOnlyReasons(
  value: unknown,
  reasons: ClassificationReason[],
  localOperators?: ReadonlySet<string>,
): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectServerOnlyReasons(item, reasons, localOperators)
    return
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith('$')) {
      if (SERVER_ONLY_QUERY_FILTERS.has(key)) {
        reasons.push({ code: 'select-projection', detail: key })
      } else if (
        !SERVER_WINDOW_QUERY_FILTERS.has(key) &&
        !LOCAL_QUERY_OPERATORS.has(key) &&
        !localOperators?.has(key)
      ) {
        reasons.push({ code: 'server-only-operator', detail: key })
      }
    }
    collectServerOnlyReasons(child, reasons, localOperators)
  }
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

/**
 * A stored query's classification: `desc`/`config` are frozen at materialize time,
 * so this is computed once and carried on the `Query` record. `'get'` marks get
 * queries, which have no find classification.
 */
export type StoredQueryClass = QueryNodeClass | 'get'

/**
 * A query the client must not merge realtime events into locally — anything
 * classified above local-exact refetches instead. Get queries always merge.
 */
export function isServerMaintained(classification: StoredQueryClass): boolean {
  return classification === 'server-window' || classification === 'server-authoritative'
}
