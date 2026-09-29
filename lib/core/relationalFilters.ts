import type { QueryAST } from './queryBuilder.js'
import type { ClassificationReason } from './queryClassification.js'
import type { RelationshipDef, Schema } from './schema.js'
import { resolveServicePath } from './schema.js'
import {
  entityKey,
  type MatchResult,
  type ProcessedCacheEvent,
  type ServiceState,
} from './queryTypes.js'

/**
 * Relational filters — dotted-path predicates over related entities, e.g.
 * `q.issues.where({ 'assignee.teamId': 5 })`. The helpers here:
 *
 * - discover which dotted paths in a query traverse schema relations
 * - decide which of those the client can evaluate locally (paths through single-hop
 *   `one` relations); any other path makes the root server-maintained
 * - compute which services/fields the query therefore depends on
 * - materialize a parent item with its related entities (from cache) so the
 *   matcher can evaluate the dotted predicate locally
 * - decide whether a processed realtime event could change the query's result
 */

export interface RelationalFilterPath {
  path: string[]
  field: string
}

export interface RelationalFilterDependency {
  serviceName: string
  fields: Set<string>
}

export function hasRelationalFilter(schema: Schema, ast: QueryAST): boolean {
  return collectRelationalFilterPaths(schema, ast.service, ast.query).length > 0
}

export function collectRelationalFilterPaths(
  schema: Schema,
  serviceName: string,
  query: unknown,
): RelationalFilterPath[] {
  const paths: RelationalFilterPath[] = []
  collectRelationalFilterPathsInto(schema, serviceName, query, paths)
  return dedupeRelationalPaths(paths)
}

function collectRelationalFilterPathsInto(
  schema: Schema,
  serviceName: string,
  value: unknown,
  paths: RelationalFilterPath[],
): void {
  if (!value || typeof value !== 'object') return

  if (Array.isArray(value)) {
    for (const item of value) {
      collectRelationalFilterPathsInto(schema, serviceName, item, paths)
    }
    return
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith('$')) {
      collectRelationalFilterPathsInto(schema, serviceName, child, paths)
      continue
    }

    const relationPath = relationPathOf(schema, serviceName, key)
    if (relationPath.length > 0) {
      paths.push({ path: relationPath, field: key.split('.')[relationPath.length]! })
    }

    collectRelationalFilterPathsInto(schema, serviceName, child, paths)
  }
}

/** The schema relations a dotted filter key traverses — empty for a plain field. */
function relationPathOf(schema: Schema, serviceName: string, key: string): string[] {
  const segments = key.split('.')
  const relationPath: string[] = []
  let currentService = serviceName
  for (const segment of segments.slice(0, -1)) {
    const relDef = schema.relationships?.[currentService]?.[segment]
    if (!relDef) break
    relationPath.push(segment)
    currentService = relDef.destService
  }
  return relationPath
}

/** The logical operators of the local predicate language. */
const LOGICAL_OPERATORS = new Set(['$and', '$or'])

/** A dotted key of the query's predicate tree, with every operand it's compared to. */
interface RelationalFilterLeaf {
  path: string[]
  operands: unknown[]
}

/**
 * The dotted keys of the query's predicate tree — the root object and `$and`/`$or`
 * branches — keyed by filter key. Relation paths that also occur anywhere else
 * (e.g. inside a custom operator's operand) are opaque: nothing is known about how
 * they combine, so `substituteLeaves` can't bound them.
 */
function collectRelationalFilterLeaves(
  schema: Schema,
  serviceName: string,
  query: unknown,
  leaves = new Map<string, RelationalFilterLeaf>(),
  opaque = new Set<string>(),
): { leaves: Map<string, RelationalFilterLeaf>; opaque: Set<string> } {
  if (!isRecord(query)) return { leaves, opaque }
  for (const [key, child] of Object.entries(query)) {
    if (LOGICAL_OPERATORS.has(key) && Array.isArray(child)) {
      for (const branch of child) {
        collectRelationalFilterLeaves(schema, serviceName, branch, leaves, opaque)
      }
      continue
    }
    const relationPath = relationPathOf(schema, serviceName, key)
    if (relationPath.length > 0) {
      const leaf = leaves.get(key) ?? { path: relationPath, operands: [] }
      leaf.operands.push(child)
      leaves.set(key, leaf)
    }
    for (const nested of collectRelationalFilterPaths(schema, serviceName, child)) {
      opaque.add(nested.path.join('.'))
    }
  }
  return { leaves, opaque }
}

/**
 * Replace the given leaves with a constant predicate: always true drops the
 * conjunct, always false matches no value. The local predicate language is
 * monotone (`$and`, `$or`, per-field operators), so the two substitutions bound
 * every value the undecided leaves could take.
 */
function substituteLeaves(query: unknown, keys: ReadonlySet<string>, value: boolean): unknown {
  if (!isRecord(query)) return query
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(query)) {
    if (LOGICAL_OPERATORS.has(key) && Array.isArray(child)) {
      result[key] = child.map(branch => substituteLeaves(branch, keys, value))
    } else if (!keys.has(key)) {
      result[key] = child
    } else if (!value) {
      result[key] = { $in: [] }
    }
  }
  return result
}

/**
 * The local matcher for a query with relational filters. Each item is materialized
 * with its related rows from cache; a leaf whose relation path can't be resolved
 * is undecided. So is a leaf through a null FK whose predicate also matches a
 * missing relation (`$ne`, `$nin`, null equality): locally that is true, while a
 * server join usually excludes the row, so only the server can say. The item is
 * still decided when the query gives the same answer with every undecided leaf
 * true and with every one false — `{ status: 'closed', 'creator.name': 'Bob' }`
 * rejects an open issue whatever its creator — and is `'unknown'` otherwise.
 */
export function createRelationalFilterMatcher<TMeta extends Record<string, unknown>>(
  schema: Schema,
  getState: () => Map<string, ServiceState<TMeta>>,
  isIdField: (serviceName: string, field: string) => boolean,
  serviceName: string,
  query: unknown,
  compile: (query: unknown) => (item: unknown) => boolean,
): (item: unknown) => MatchResult {
  const match = compile(query)
  const paths = collectRelationalFilterPaths(schema, serviceName, query)
  if (paths.length === 0) return match
  const { leaves, opaque } = collectRelationalFilterLeaves(schema, serviceName, query)
  const matchesMissingRelation = new Set<string>()
  for (const [key, { path, operands }] of leaves) {
    const missing = { [path[0]!]: null }
    if (operands.some(operand => compile({ [key]: operand })(missing))) {
      matchesMissingRelation.add(key)
    }
  }
  // Few distinct undecided sets occur, so their bound matchers are compiled once.
  const bounds = new Map<string, { upper: (item: unknown) => boolean; lower: typeof match }>()

  return item => {
    const materialized = materializeRelationalFilterItem(
      { schema, state: getState(), isIdField },
      serviceName,
      item,
      paths,
    )
    const undecided: string[] = []
    for (const [key, { path }] of leaves) {
      const relation = path.join('.')
      if (
        materialized.unresolved.has(relation) ||
        (materialized.missing.has(relation) && matchesMissingRelation.has(key))
      ) {
        undecided.push(key)
      }
    }
    if (materialized.unresolved.size === 0 && undecided.length === 0) {
      return match(materialized.item)
    }
    for (const path of materialized.unresolved) {
      if (opaque.has(path)) return 'unknown'
    }
    const boundsKey = undecided.join('\0')
    let bound = bounds.get(boundsKey)
    if (!bound) {
      const keys = new Set(undecided)
      bound = {
        upper: compile(substituteLeaves(query, keys, true)),
        lower: compile(substituteLeaves(query, keys, false)),
      }
      bounds.set(boundsKey, bound)
    }
    const upper = bound.upper(materialized.item)
    return upper === bound.lower(materialized.item) ? upper : 'unknown'
  }
}

/**
 * Whether the client can follow a relation hop from its entity cache: a single-hop
 * `one` resolves to exactly one row (or none, for a null FK). A `many`, junction,
 * `embed`, or two-hop `one` filter asks whether *some* related row matches, which
 * needs the complete related set — only the server has it.
 */
function isLocalRelation(relDef: RelationshipDef): boolean {
  return relDef.cardinality === 'one' && !relDef.via
}

/**
 * Relational filter paths the client can't evaluate locally, as classification
 * reasons. Any reason makes the root server-maintained for membership: its own
 * realtime events reconcile it with the server, and the relational dependencies
 * below reconcile it when a related service changes.
 */
export function relationalFilterServerReasons(
  schema: Schema,
  ast: QueryAST,
): ClassificationReason[] {
  const reasons: ClassificationReason[] = []
  for (const { path, field } of collectRelationalFilterPaths(schema, ast.service, ast.query)) {
    let currentService = ast.service
    for (const relName of path) {
      const relDef = schema.relationships?.[currentService]?.[relName]
      if (!relDef) break
      if (!isLocalRelation(relDef)) {
        reasons.push({ code: 'relational-filter', detail: [...path, field].join('.') })
        break
      }
      currentService = relDef.destService
    }
  }
  return reasons
}

function dedupeRelationalPaths(paths: RelationalFilterPath[]): RelationalFilterPath[] {
  const seen = new Set<string>()
  const deduped: RelationalFilterPath[] = []
  for (const path of paths) {
    const key = `${path.path.join('.')}.${path.field}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(path)
  }
  return deduped
}

export function collectRelationalFilterDependencies(
  schema: Schema,
  ast: QueryAST,
  // The root query's filter paths — callers already hold them (they're also the
  // event-matching input), so they're passed in rather than re-derived here.
  paths: RelationalFilterPath[],
): RelationalFilterDependency[] {
  const byService = new Map<string, Set<string>>()
  const add = (serviceName: string, fields: string[]) => {
    const path = resolveServicePath(schema, serviceName)
    let set = byService.get(path)
    if (!set) {
      set = new Set()
      byService.set(path, set)
    }
    for (const field of fields) {
      set.add(field)
    }
  }

  for (const filterPath of paths) {
    let currentService = ast.service
    for (let i = 0; i < filterPath.path.length; i++) {
      const relName = filterPath.path[i]!
      const relDef = schema.relationships?.[currentService]?.[relName]
      if (!relDef) break

      if (relDef.via) {
        // Two hops: parent → intermediate (junction) → destination.
        add(currentService, [relDef.via.sourceField])
        add(relDef.via.destService, [relDef.via.destField, relDef.sourceField])
      } else {
        add(currentService, [relDef.sourceField])
      }

      const isLeaf = i === filterPath.path.length - 1
      add(relDef.destService, isLeaf ? [relDef.destField, filterPath.field] : [relDef.destField])

      currentService = relDef.destService
    }
  }

  return Array.from(byService, ([serviceName, fields]) => ({ serviceName, fields }))
}

export function shouldRefetchRelationalFilterQuery(
  schema: Schema,
  ast: QueryAST,
  // Derived from the static AST — precomputed once at subscription time by the
  // caller rather than re-derived on every processed event.
  dependencies: RelationalFilterDependency[],
  event: ProcessedCacheEvent,
): boolean {
  const dep = dependencies.find(item => item.serviceName === event.serviceName)
  if (!dep) return false

  // The store decides root rows itself: the relational matcher answers 'unknown'
  // for a row it can't evaluate, which reconciles the root there.
  if (event.serviceName === resolveServicePath(schema, ast.service)) return false

  if (event.type === 'created' || event.type === 'removed') return true

  return itemChangedFields(event.previousItem, event.item, dep.fields)
}

/** What relation hops are followed through: the schema, the entity cache, and its keys. */
interface CacheContext<TMeta extends Record<string, unknown>> {
  schema: Schema
  state: Map<string, ServiceState<TMeta>>
  isIdField: (serviceName: string, field: string) => boolean
}

/**
 * The item with its related rows from cache, and its relation paths (dotted) that
 * local state can't resolve, or that end at a null FK.
 */
function materializeRelationalFilterItem<TMeta extends Record<string, unknown>>(
  context: CacheContext<TMeta>,
  serviceName: string,
  item: unknown,
  paths: RelationalFilterPath[],
): { item: unknown; unresolved: Set<string>; missing: Set<string> } {
  let materialized = cloneRecord(item)
  const unresolved = new Set<string>()
  const missing = new Set<string>()
  for (const path of paths) {
    const result = materializeRelationPath(context, serviceName, materialized, path.path)
    if (result.kind === 'unresolved') {
      unresolved.add(path.path.join('.'))
      continue
    }
    if (result.kind === 'missing') missing.add(path.path.join('.'))
    materialized = result.item
  }
  return { item: materialized, unresolved, missing }
}

type MaterializedPath =
  | { kind: 'resolved' | 'missing'; item: Record<string, unknown> }
  | { kind: 'unresolved' }

function materializeRelationPath<TMeta extends Record<string, unknown>>(
  context: CacheContext<TMeta>,
  serviceName: string,
  item: Record<string, unknown>,
  path: string[],
): MaterializedPath {
  if (path.length === 0) return { kind: 'resolved', item }

  const [relName, ...rest] = path
  const relDef = relName ? context.schema.relationships?.[serviceName]?.[relName] : undefined
  if (!relName || !relDef) return { kind: 'unresolved' }

  const related = resolveRelatedItem(context, relDef, item)
  if (related === undefined) return { kind: 'unresolved' }
  // A null FK is a known absence: the path's predicates see a null relation.
  if (related === null) return { kind: 'missing', item: { ...item, [relName]: null } }

  const nextRelated =
    rest.length > 0
      ? materializeRelationPath(context, relDef.destService, cloneRecord(related), rest)
      : { kind: 'resolved' as const, item: related as Record<string, unknown> }
  if (nextRelated.kind === 'unresolved') return nextRelated
  return { kind: nextRelated.kind, item: { ...item, [relName]: nextRelated.item } }
}

/**
 * The row a relation hop points at: `null` when the FK is null (known: there is no
 * related row), `undefined` when local state can't tell — a hop the client can't
 * follow, an FK missing from the item, or a related row that isn't cached.
 */
function resolveRelatedItem<TMeta extends Record<string, unknown>>(
  { schema, state, isIdField }: CacheContext<TMeta>,
  relDef: RelationshipDef,
  item: Record<string, unknown>,
): unknown {
  if (!isLocalRelation(relDef)) return undefined
  const sourceValue = item[relDef.sourceField]
  if (sourceValue === null) return null
  if (typeof sourceValue !== 'string' && typeof sourceValue !== 'number') return undefined

  const destService = resolveServicePath(schema, relDef.destService)
  const destState = state.get(destService)
  if (!destState) return undefined

  // Fast path: the entity cache is keyed by adapter id, and destField is nearly always
  // that id field — a direct map hit avoids scanning the whole service. This runs
  // inside the matcher (per item, per relation path), so on a busy service the scan
  // below would make merge decisions O(items × entities).
  const direct = destState.entities.get(entityKey(sourceValue))
  // When destField is the id field, the map key is the only place the row can be,
  // and entity keys match a string FK '10' to id 10 the way the server's join does.
  if (isIdField(destService, relDef.destField)) return direct
  // Otherwise the map key and destField are different fields; verify the candidate.
  if (direct !== undefined && getFieldValue(direct, relDef.destField) === sourceValue) {
    return direct
  }

  for (const candidate of destState.entities.values()) {
    if (getFieldValue(candidate, relDef.destField) === sourceValue) {
      return candidate
    }
  }

  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {}
}

/**
 * Read a key field as a comparable value. The canonical read for cross-module key
 * comparisons — the relational engine keys assembly with it too.
 */
export function getFieldValue(item: unknown, field: string): string | number | undefined {
  if (!item || typeof item !== 'object') return undefined
  const value = (item as Record<string, unknown>)[field]
  return typeof value === 'string' || typeof value === 'number' ? value : undefined
}

function itemChangedFields(
  previousItem: unknown,
  nextItem: unknown,
  fields: ReadonlySet<string>,
): boolean {
  if (!previousItem || typeof previousItem !== 'object') return true
  if (!nextItem || typeof nextItem !== 'object') return true

  const prev = previousItem as Record<string, unknown>
  const next = nextItem as Record<string, unknown>
  for (const field of fields) {
    if (prev[field] !== next[field]) return true
  }
  return false
}
