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
import type { QueryAST } from './queryBuilder.js'
import type { SchemaRelationships } from './schema.js'

export type QueryNodeClass = 'local-exact' | 'server-window' | 'server-authoritative'

/**
 * The single source of truth for which `$`-keys the client understands, shared with
 * the adapter matcher (which derives its strip/preserve lists from these) so
 * classification can never promise an operator the matcher will reject.
 */
export const LOCAL_QUERY_OPERATORS = new Set([
  '$in',
  '$nin',
  '$lt',
  '$lte',
  '$gt',
  '$gte',
  '$ne',
  '$or',
])
export const SERVER_WINDOW_QUERY_FILTERS = new Set(['$limit', '$skip', '$sort'])
export const SERVER_ONLY_QUERY_FILTERS = new Set(['$select'])

/**
 * A single structured reason contributing to a query node's classification.
 * `code` is stable (assertable in tests, renderable in devtools); `detail` names the
 * specific operator or filter that triggered it.
 */
export interface ClassificationReason {
  code:
    | 'server-flag'
    | 'native-pagination'
    | 'select-projection'
    | 'server-only-operator'
    | 'window-filter'
    | 'snapshot'
  detail?: string
}

export interface ClassifyOptions {
  server?: boolean | undefined
  allPages?: boolean | undefined
  /**
   * Operator names the app has taught the client to evaluate (the adapter's custom
   * operator registry). They classify as local only at the top level of the query —
   * mirroring the adapter matcher, which peels custom operators off the top level;
   * nested usage (inside `$or`, or under a field) is server-authoritative.
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
  /** Override the default `.server()` reason when another plan owns server authority. */
  serverReasons?: readonly ClassificationReason[] | undefined
  /** `.snapshot()` — appends the snapshot reason (class is unaffected; realtime is manual). */
  snapshot?: boolean | undefined
  /**
   * An offset `.paginate()` root — each page runs as a `$limit`/`$skip` window,
   * so an otherwise local-exact node reports server-window.
   */
  paginatedRoot?: boolean | undefined
}

/**
 * Like `classifyQueryNode`, but says *why*: returns the classification together with
 * the structured reasons that produced it. Powers `figbird.explain()`.
 */
export function explainQueryNode(
  query: unknown,
  {
    server,
    serverReasons,
    allPages,
    localOperators,
    snapshot,
    paginatedRoot,
  }: ExplainNodeOptions = {},
): { class: QueryNodeClass; reasons: ClassificationReason[] } {
  const authoritative: ClassificationReason[] = []
  if (server) {
    authoritative.push(
      ...(serverReasons ?? [{ code: 'server-flag' as const, detail: '.server()' }]),
    )
  }

  const window: ClassificationReason[] = []
  walkQueryKeys(query, (key, top) => {
    if (!key.startsWith('$')) return
    if (SERVER_ONLY_QUERY_FILTERS.has(key)) {
      authoritative.push({ code: 'select-projection', detail: key })
    } else if (SERVER_WINDOW_QUERY_FILTERS.has(key)) {
      // allPages neutralizes windows: the full result set is fetched, so
      // membership is locally provable regardless of $limit/$skip/$sort.
      if (!allPages) window.push({ code: 'window-filter', detail: key })
    } else if (!LOCAL_QUERY_OPERATORS.has(key) && !(top && localOperators?.has(key))) {
      authoritative.push({ code: 'server-only-operator', detail: key })
    }
  })

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

/**
 * The one traversal every query inspection shares: visit each object key
 * (before its children), recursing through nested objects and arrays. `top` is
 * true only for keys of the root object — the level the adapter matcher peels
 * custom operators from.
 */
function walkQueryKeys(value: unknown, visit: (key: string, top: boolean) => void): void {
  walkQueryKeysAtDepth(value, visit, true)
}

function walkQueryKeysAtDepth(
  value: unknown,
  visit: (key: string, top: boolean) => void,
  top: boolean,
): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) walkQueryKeysAtDepth(item, visit, false)
    return
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    visit(key, top)
    walkQueryKeysAtDepth(child, visit, false)
  }
}

/** True when the query uses `$limit`/`$skip`/`$sort` anywhere. */
export function hasWindowFilters(value: unknown): boolean {
  let found = false
  walkQueryKeys(value, key => {
    if (SERVER_WINDOW_QUERY_FILTERS.has(key)) found = true
  })
  return found
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

/** One plan shared by paginated-root execution and static explanation. */
export interface RootPaginationPlan {
  kind: 'offset' | 'sequential'
  /** Sequential continuations and explicit `.server()` roots are server-authoritative. */
  server: boolean
  /** Structured reasons used by `figbird.explain()`. */
  serverReasons: ClassificationReason[]
}

export function planRootPagination(
  nativeSequential: boolean,
  explicitServer: boolean,
): RootPaginationPlan {
  const serverReasons: ClassificationReason[] = []
  if (nativeSequential) {
    serverReasons.push({
      code: 'native-pagination',
      detail: 'adapter-native sequential pagination',
    })
  }
  if (explicitServer) {
    serverReasons.push({ code: 'server-flag', detail: '.server()' })
  }
  return {
    kind: nativeSequential ? 'sequential' : 'offset',
    server: serverReasons.length > 0,
    serverReasons,
  }
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

/** One node of a `figbird.explain()` report. */
export interface ExplainNode {
  /** Root, dotted relation, or internal junction path (`'members#junction'`). */
  path: string
  service: string
  kind: 'find' | 'get' | 'paginate' | 'all'
  /** Present for an internal junction-service query in a two-hop relation. */
  role?: 'junction'
  class: QueryNodeClass
  reasons: ClassificationReason[]
  /** How realtime events on this node's service are handled. */
  realtime: 'merge' | 'refetch' | 'manual'
  /** Junction service name for transparent two-hop relations. */
  via?: string
}

export interface ExplainReport {
  nodes: ExplainNode[]
}

/** The realtime handling a node's class (and snapshot flag) implies. */
function nodeRealtime(snapshot: boolean, cls: QueryNodeClass): ExplainNode['realtime'] {
  return snapshot ? 'manual' : cls === 'local-exact' ? 'merge' : 'refetch'
}

/**
 * Walk a query AST into a flat explain report: one node per executed query (root,
 * relations, and junction hops), each carrying its classification and structured
 * reasons. Reads the same plans the runtime executes
 * (`rootAllPages`, `planRelation`, `explainQueryNode`) so the report provably
 * can't drift from what actually runs. `figbird.explain()` is the public wrapper.
 */
export function explainQuery(
  ast: QueryAST,
  relationships: SchemaRelationships | undefined,
  localOperatorsFor: (serviceName: string) => ReadonlySet<string>,
  hasNativePagination: (serviceName: string) => boolean,
): ExplainNode[] {
  const nodes: ExplainNode[] = []
  explainAst(ast, '(root)', true, nodes, relationships, localOperatorsFor, hasNativePagination)
  return nodes
}

function explainAst(
  ast: QueryAST,
  path: string,
  isRoot: boolean,
  nodes: ExplainNode[],
  relationships: SchemaRelationships | undefined,
  localOperatorsFor: (serviceName: string) => ReadonlySet<string>,
  hasNativePagination: (serviceName: string) => boolean,
): void {
  const snapshot = Boolean(ast.snapshot)
  const paginationPlan =
    isRoot && ast.kind === 'paginate'
      ? planRootPagination(hasNativePagination(ast.service), Boolean(ast.server))
      : null
  // Root fetch shape comes from the same plan the runtime executes (rootAllPages):
  // .all() drains every page, so window filters ($sort — the builder refuses
  // $limit/$skip) don't demote the class. Offset pagination is a server window;
  // native sequential pagination is server-authoritative.
  const explained = explainQueryNode(ast.query, {
    server: paginationPlan?.server ?? ast.server,
    ...(paginationPlan ? { serverReasons: paginationPlan.serverReasons } : {}),
    allPages: rootAllPages(ast.kind),
    localOperators: localOperatorsFor(ast.service),
    snapshot,
    paginatedRoot: paginationPlan?.kind === 'offset',
  })

  nodes.push({
    path,
    service: ast.service,
    kind: ast.kind,
    class: explained.class,
    reasons: explained.reasons,
    realtime: nodeRealtime(snapshot, explained.class),
  })

  explainRelations(ast, path, snapshot, nodes, relationships, localOperatorsFor)
}

/**
 * One walk for relations at every depth. `snapshot` is the root's — `.snapshot()`
 * freezes the root and every relation under it, so it propagates all the way down.
 */
function explainRelations(
  ast: QueryAST,
  path: string,
  snapshot: boolean,
  nodes: ExplainNode[],
  relationships: SchemaRelationships | undefined,
  localOperatorsFor: (serviceName: string) => ReadonlySet<string>,
): void {
  const serviceRelationships = relationships?.[ast.service] ?? {}
  for (const [relName, relAST] of Object.entries(ast.related)) {
    const relDef = serviceRelationships[relName]
    const relPath = path === '(root)' ? relName : `${path}.${relName}`
    const destService = relDef?.destService ?? relAST.service
    // The relation's fetch shape is read off the same plan the runtime executes
    // (planRelation) — explain can't drift from what actually runs.
    const plan = planRelation(relDef, relAST.query)
    const relQuery = {
      ...relAST.query,
      ...(relDef?.query ?? {}),
    }
    const relExplained = explainQueryNode(relQuery, {
      server: relAST.server,
      allPages: plan.allPages,
      localOperators: localOperatorsFor(destService),
    })
    if (plan.strategy === 'perParent') {
      relExplained.reasons = [
        ...relExplained.reasons,
        { code: 'window-filter', detail: 'per-parent window — one query per parent' },
      ]
    }
    if (relDef?.via) {
      const junctionService = relDef.via.destService
      const junctionExplained = explainQueryNode(relDef.via.query, {
        allPages: true,
        localOperators: localOperatorsFor(junctionService),
      })
      nodes.push({
        path: `${relPath}#junction`,
        service: junctionService,
        kind: 'find',
        role: 'junction',
        class: junctionExplained.class,
        reasons: junctionExplained.reasons,
        realtime: nodeRealtime(snapshot, junctionExplained.class),
      })
    }

    nodes.push({
      path: relPath,
      service: destService,
      kind: 'find',
      class: relExplained.class,
      reasons: relExplained.reasons,
      realtime: nodeRealtime(snapshot, relExplained.class),
      ...(relDef?.via ? { via: relDef.via.destService } : {}),
    })
    explainRelations(relAST, relPath, snapshot, nodes, relationships, localOperatorsFor)
  }
}
