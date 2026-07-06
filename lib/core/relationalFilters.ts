import type { QueryAST } from './queryBuilder.js'
import type { RelationshipDef, Schema } from './schema.js'
import { resolveServicePath } from './schema.js'
import type { ProcessedRealtimeEvent, ServiceState } from './queryTypes.js'

/**
 * Relational filters — dotted-path predicates over related entities, e.g.
 * `q.issues.where({ 'assignee.teamId': 5 })`. The helpers here:
 *
 * - discover which dotted paths in a query traverse schema relations
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

  const relationships = schema.relationships?.[serviceName] ?? {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith('$')) {
      collectRelationalFilterPathsInto(schema, serviceName, child, paths)
      continue
    }

    const segments = key.split('.')
    if (segments.length <= 1) {
      collectRelationalFilterPathsInto(schema, serviceName, child, paths)
      continue
    }

    const relationPath: string[] = []
    let currentService = serviceName
    for (const segment of segments.slice(0, -1)) {
      const relDef = schema.relationships?.[currentService]?.[segment]
      if (!relDef) break
      relationPath.push(segment)
      currentService = relDef.destService
    }

    if (relationPath.length > 0 && relationships[relationPath[0]!]) {
      paths.push({ path: relationPath, field: segments[relationPath.length]! })
    }

    collectRelationalFilterPathsInto(schema, serviceName, child, paths)
  }
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

  for (const filterPath of collectRelationalFilterPaths(schema, ast.service, ast.query)) {
    let currentService = ast.service
    for (let i = 0; i < filterPath.path.length; i++) {
      const relName = filterPath.path[i]!
      const relDef = schema.relationships?.[currentService]?.[relName]
      if (!relDef || relDef.cardinality !== 'one' || relDef.via) break

      add(currentService, relDef.sourceField)

      const isLeaf = i === filterPath.path.length - 1
      add(relDef.destService, isLeaf ? [...relDef.destField, filterPath.field] : relDef.destField)

      currentService = relDef.destService
    }
  }

  return Array.from(byService, ([serviceName, fields]) => ({ serviceName, fields }))
}

export function shouldRefetchRelationalFilterQuery<TMeta extends Record<string, unknown>>(
  schema: Schema,
  state: Map<string, ServiceState<TMeta>>,
  ast: QueryAST,
  // Both derived from the static AST — precomputed once at subscription time by the
  // caller rather than re-derived on every processed event.
  paths: RelationalFilterPath[],
  dependencies: RelationalFilterDependency[],
  event: ProcessedRealtimeEvent,
): boolean {
  const dep = dependencies.find(item => item.serviceName === event.serviceName)
  if (!dep) return false

  if (event.serviceName === resolveServicePath(schema, ast.service)) {
    if (event.type === 'removed') return false
    if (paths.length === 0) return false
    const materialized = materializeRelationalFilterItem(
      schema,
      state,
      ast.service,
      event.item,
      paths,
    )
    return !materialized.complete
  }

  if (event.type === 'created' || event.type === 'removed') return true

  return itemChangedFields(event.previousItem, event.item, dep.fields)
}

export function materializeRelationalFilterItem<TMeta extends Record<string, unknown>>(
  schema: Schema,
  state: Map<string, ServiceState<TMeta>>,
  serviceName: string,
  item: unknown,
  paths: RelationalFilterPath[],
): { item: unknown; complete: boolean } {
  let materialized = cloneRecord(item)
  for (const path of paths) {
    const result = materializeRelationPath(schema, state, serviceName, materialized, path.path)
    if (!result.complete) {
      return { item: materialized, complete: false }
    }
    materialized = result.item
  }
  return { item: materialized, complete: true }
}

function materializeRelationPath<TMeta extends Record<string, unknown>>(
  schema: Schema,
  state: Map<string, ServiceState<TMeta>>,
  serviceName: string,
  item: Record<string, unknown>,
  path: string[],
): { item: Record<string, unknown>; complete: boolean } {
  if (path.length === 0) return { item, complete: true }

  const [relName, ...rest] = path
  const relDef = relName ? schema.relationships?.[serviceName]?.[relName] : undefined
  if (!relName || !relDef) return { item, complete: false }

  const related = resolveRelatedItem(schema, state, relDef, item)
  if (!related) return { item, complete: false }

  const nextRelated =
    rest.length > 0
      ? materializeRelationPath(schema, state, relDef.destService, cloneRecord(related), rest)
      : { item: related, complete: true }

  if (!nextRelated.complete) {
    return { item, complete: false }
  }

  return {
    item: {
      ...item,
      [relName]: nextRelated.item,
    },
    complete: true,
  }
}

function resolveRelatedItem<TMeta extends Record<string, unknown>>(
  schema: Schema,
  state: Map<string, ServiceState<TMeta>>,
  relDef: RelationshipDef,
  item: unknown,
): unknown | null {
  if (relDef.cardinality !== 'one' || relDef.via) return null
  const sourceValue = getFieldValue(item, relDef.sourceField)
  if (sourceValue === undefined) return null

  const destState = state.get(resolveServicePath(schema, relDef.destService))
  if (!destState) return null

  // Fast path: the entity cache is keyed by adapter id, and destField is nearly always
  // that id field — a direct map hit avoids scanning the whole service. This runs
  // inside the matcher (per item, per relation path), so on a busy service the scan
  // below would make merge decisions O(items × entities). The candidate is verified
  // against destField before returning, since the map key and destField are not
  // guaranteed to be the same field.
  const direct = destState.entities.get(sourceValue)
  if (direct !== undefined && getFieldValue(direct, relDef.destField) === sourceValue) {
    return direct
  }

  for (const candidate of destState.entities.values()) {
    if (getFieldValue(candidate, relDef.destField) === sourceValue) {
      return candidate
    }
  }

  return null
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
}

/**
 * Read a possibly-compound key field as a comparable value. The canonical encoding for
 * cross-module key comparisons — the relational engine keys assembly with it too.
 *
 * Compound keys use JSON.stringify for an unambiguous encoding so that two distinct
 * tuples cannot collide even if individual values contain separator characters.
 * (E.g. values ['a|b', 'c'] and ['a', 'b|c'] must produce different keys.)
 */
export function getFieldValue(item: unknown, fields: string[]): string | number | undefined {
  if (!item || typeof item !== 'object') return undefined
  const record = item as Record<string, unknown>
  if (fields.length === 1) {
    const value = record[fields[0]!]
    return typeof value === 'string' || typeof value === 'number' ? value : undefined
  }

  const values = fields.map(field => record[field])
  if (values.some(value => value === undefined || value === null)) return undefined
  return JSON.stringify(values)
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
