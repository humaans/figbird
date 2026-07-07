/**
 * Query classification — the single place that decides how a query node can be
 * maintained by the client:
 *
 * - **local-exact** — membership/order/values are provable from local state; realtime
 *   events merge into the cached result via the matcher.
 * - **server-window** — the query is windowed (`$limit`/`$skip`/`$sort` without
 *   `allPages`); the predicate is still locally evaluable, but unseen rows may enter
 *   or leave the window invisibly. Events whose effect on the window is provable
 *   merge locally (see queryStore's window maintenance); anything unprovable
 *   triggers a server refetch.
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

/** Explain-only affordances layered on top of classification. */
export interface ExplainNodeOptions extends ClassifyOptions {
  /** `.snapshot()` — appends the snapshot reason (class is unaffected; realtime is manual). */
  snapshot?: boolean | undefined
  /**
   * A `.paginate()` root — each page runs as a `$limit`/`$skip` window, so an
   * otherwise local-exact node reports server-window.
   */
  paginatedRoot?: boolean | undefined
}

/**
 * Like `classifyQueryNode`, but says *why*: returns the classification together with
 * the structured reasons that produced it. Powers `figbird.explain()`.
 */
export function explainQueryNode(
  query: unknown,
  { server, allPages, localOperators, snapshot, paginatedRoot }: ExplainNodeOptions = {},
): { class: QueryNodeClass; reasons: ClassificationReason[] } {
  const authoritative: ClassificationReason[] = []
  if (server) authoritative.push({ code: 'server-flag', detail: '.server()' })
  collectServerOnlyReasons(query, authoritative, localOperators)

  const window: ClassificationReason[] = []
  if (!allPages) collectWindowReasons(query, window)

  let result: { class: QueryNodeClass; reasons: ClassificationReason[] }
  if (authoritative.length > 0) {
    result = { class: 'server-authoritative', reasons: [...authoritative, ...window] }
  } else if (window.length > 0) {
    result = { class: 'server-window', reasons: window }
  } else {
    result = { class: 'local-exact', reasons: [] }
  }

  if (snapshot) {
    result.reasons = [...result.reasons, { code: 'snapshot', detail: '.snapshot()' }]
  }
  if (paginatedRoot && result.class === 'local-exact') {
    result = {
      class: 'server-window',
      reasons: [
        ...result.reasons,
        { code: 'window-filter', detail: 'paginate() — each page is a $limit/$skip window' },
      ],
    }
  }
  return result
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

/** How a relation node is executed at runtime. */
export type RelationStrategy = 'junction' | 'perParent' | 'fanIn'

export interface RelationPlan {
  strategy: RelationStrategy
  /** The relation carries `$limit`/`$skip`/`$sort` — an explicit consumer window. */
  windowed: boolean
  /** allPages for the destination fetch (a junction's first hop is always exhaustive). */
  allPages: boolean
}

/**
 * The fetch plan for a relation node — the single statement of how the engine
 * executes relations, consumed by both the runtime (`RelationalQueryRef`) and
 * `figbird.explain()` so the two provably can't drift:
 *
 * - `via` set → two-hop junction fetch.
 * - windowed `many` → one query per parent (per-parent windows can't be expressed
 *   as a single find).
 * - everything else → one fan-in `IN(...)` query.
 *
 * Relations without explicit windowing drain every page (`allPages`) so the
 * parent's `IN(...)` set isn't silently truncated by the default page cap; an
 * explicit window is the consumer's intent and stays a single server-maintained
 * window.
 */
export function planRelation(
  relDef: { via?: unknown; cardinality?: string } | undefined,
  relQuery: unknown,
): RelationPlan {
  const windowed = hasWindowFilters(relQuery)
  const strategy: RelationStrategy = relDef?.via
    ? 'junction'
    : windowed && relDef?.cardinality === 'many'
      ? 'perParent'
      : 'fanIn'
  return { strategy, windowed, allPages: !windowed }
}

/** allPages for a root node: `.all()` drains every page; everything else is one page. */
export function rootAllPages(kind: string): boolean {
  return kind === 'all'
}

/**
 * True when every predicate in the query is evaluable by the local matcher.
 * Window filters are ignored — windowing doesn't affect whether a predicate can
 * be evaluated, only whether membership is provable.
 */
export function isLocallyEvaluable(query: unknown, localOperators?: ReadonlySet<string>): boolean {
  return classifyQueryNode(query, { allPages: true, localOperators }) === 'local-exact'
}

/**
 * A stored query's classification: `desc`/`config` are frozen at materialize time,
 * so this is computed once and carried on the `Query` record. `'get'` marks get
 * queries, which have no find classification.
 */
export type StoredQueryClass = QueryNodeClass | 'get'

/**
 * Classify a query at materialize time. Gets classify as 'get' — except when they
 * carry conditions the client can't evaluate (`.get(id).where({ $regex })`): those
 * are server-authoritative like any other non-local query, so realtime reconciles
 * them by refetch and the merge path never tries (and fails) to build a local
 * matcher for them. Gets deliberately ignore the `server` flag — a get is answered
 * by id either way. Finds classify per `classifyQueryNode`.
 */
export function classifyStoredQuery(
  method: 'get' | 'find',
  query: Record<string, unknown> | undefined,
  { server, allPages, localOperators }: ClassifyOptions = {},
): StoredQueryClass {
  if (method === 'get') {
    return query && Object.keys(query).length > 0 && !isLocallyEvaluable(query, localOperators)
      ? 'server-authoritative'
      : 'get'
  }
  return classifyQueryNode(query, { server, allPages, localOperators })
}

/**
 * A query the client must not merge realtime events into blindly. Server-window
 * queries merge the provable subset of events and refetch for the rest;
 * server-authoritative queries always refetch. Get queries always merge.
 */
export function isServerMaintained(classification: StoredQueryClass): boolean {
  return classification === 'server-window' || classification === 'server-authoritative'
}
