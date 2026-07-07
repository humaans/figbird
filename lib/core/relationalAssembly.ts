/**
 * Pure relational assembly. Given root rows, the query AST, the schema, and a map of
 * already-gathered relation data (one entry per dotted relation key), produce the
 * denormalized tree. This module never reads live query state — the caller
 * (RelationalQueryRef) gathers a coherent snapshot of every relation's data first
 * and passes it in, which is what makes assembly independently testable.
 */

import type { QueryAST } from './queryBuilder.js'
import { getFieldValue } from './relationalFilters.js'
import type { RelationshipDef, Schema } from './schema.js'

export type AssembledRelationData =
  | { kind: 'none' }
  | { kind: 'fanIn'; items: unknown[] }
  | { kind: 'junction'; items: unknown[]; junctionItems: unknown[] }
  | { kind: 'perParent'; byParent: Map<string, unknown[]> }

/**
 * The dotted key identifying one relation node across the engine (`"comments"`,
 * `"comments.reactions"`). Every walk — sync, gather, assembly — must key
 * identically, or relation subscriptions and their gathered data disconnect.
 */
export function relationKey(parentKey: string | null, relName: string): string {
  return parentKey ? `${parentKey}.${relName}` : relName
}

/**
 * Dedupe + sort + stable-encode a set of key values. The encoded key is what relation
 * subs compare to detect "same source set, nothing to re-fetch" — every sync path must
 * produce it identically or subscriptions churn.
 */
export function sourceSet(raw: (string | number)[]): { values: (string | number)[]; key: string } {
  const values = [...new Set(raw)].sort()
  return { values, key: JSON.stringify(values) }
}

/** Collect the deduped, sorted values of `fields` across parents, with the stable key. */
export function uniqueSourceValues(
  parentData: unknown[],
  fields: string[],
): { values: (string | number)[]; key: string } {
  return sourceSet(
    parentData
      .map(item => getFieldValue(item, fields))
      .filter((v): v is string | number => v !== undefined),
  )
}

/**
 * Read a list-of-ids field for `'embedded'` relations. The parent record is expected to
 * carry an array of `string | number` at `fields[0]`; non-array or missing values become
 * `undefined` so callers can treat them as "no edges from this parent". Compound keys are
 * not supported here — embedded relations are by definition single-key id lists.
 */
export function getFieldValueAsList(
  item: unknown,
  fields: string[],
): (string | number)[] | undefined {
  if (fields.length !== 1) return undefined
  const value = (item as Record<string, unknown>)[fields[0]!]
  if (!Array.isArray(value)) return undefined
  return value.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
}

/** Stable key for a parent source value (used by per-parent windowed relations). */
export function sourceValueKey(value: string | number): string {
  return JSON.stringify(value)
}

interface RelationIndex {
  byKey?: Map<string | number, unknown>
  listByKey?: Map<string | number, unknown[]>
  junctionsByParent?: Map<string | number, unknown[]>
}

/**
 * Build per-relation lookup indexes over the gathered relation data so per-parent
 * matching during assembly is a map lookup instead of a linear scan — O(parents +
 * relation rows) per assembly pass rather than O(parents × relation rows).
 *
 * - `byKey` maps a dest-key value to the first matching entity ('one'/'embedded'/junction dest).
 * - `listByKey` groups entities by dest-key value in result order ('many').
 * - `junctionsByParent` groups junction rows by the parent-side join value (two-hop).
 */
function buildIndexes(
  ast: QueryAST,
  parentKey: string | null,
  relationships: Record<string, RelationshipDef>,
  relationData: Map<string, AssembledRelationData>,
): Map<string, RelationIndex> {
  const indexes = new Map<string, RelationIndex>()

  for (const relName of Object.keys(ast.related)) {
    const relDef = relationships[relName]
    if (!relDef) continue

    const key = relationKey(parentKey, relName)
    const rel = relationData.get(key)
    // Per-parent data is already keyed by parent; 'none' has nothing to index.
    if (!rel || rel.kind === 'none' || rel.kind === 'perParent') continue

    if (rel.kind === 'junction') {
      const byKey = firstMatchIndex(rel.items, relDef.destField)
      const junctionsByParent = new Map<string | number, unknown[]>()
      for (const j of rel.junctionItems) {
        const p = getFieldValue(j, relDef.via!.destField)
        if (p === undefined) continue
        let list = junctionsByParent.get(p)
        if (!list) {
          list = []
          junctionsByParent.set(p, list)
        }
        list.push(j)
      }
      indexes.set(relName, { byKey, junctionsByParent })
    } else if (relDef.cardinality === 'one' || relDef.cardinality === 'embedded') {
      indexes.set(relName, { byKey: firstMatchIndex(rel.items, relDef.destField) })
    } else {
      const listByKey = new Map<string | number, unknown[]>()
      for (const entity of rel.items) {
        const k = getFieldValue(entity, relDef.destField)
        if (k === undefined) continue
        let list = listByKey.get(k)
        if (!list) {
          list = []
          listByKey.set(k, list)
        }
        list.push(entity)
      }
      indexes.set(relName, { listByKey })
    }
  }

  return indexes
}

// First match wins — mirrors a linear scan's short-circuit semantics.
function firstMatchIndex(items: unknown[], destField: string[]): Map<string | number, unknown> {
  const byKey = new Map<string | number, unknown>()
  for (const entity of items) {
    const k = getFieldValue(entity, destField)
    if (k !== undefined && !byKey.has(k)) byKey.set(k, entity)
  }
  return byKey
}

/**
 * Assemble the denormalized tree: for each root row, attach each declared relation's
 * matching rows (recursing into nested relations). Relations override same-named
 * fields on the parent — this is load-bearing for `embed`, where the parent's id-list
 * field expands into the materialized entities under the same key.
 */
export function assembleRelations(
  items: unknown[],
  ast: QueryAST,
  schema: Schema,
  relationData: Map<string, AssembledRelationData>,
  parentKey: string | null = null,
): unknown[] {
  const relationships = schema.relationships?.[ast.service] ?? {}
  const indexes = buildIndexes(ast, parentKey, relationships, relationData)

  return items.map(item => {
    const result = { ...(item as object) } as Record<string, unknown>

    for (const [relName, relAST] of Object.entries(ast.related)) {
      const key = relationKey(parentKey, relName)
      const relDef = relationships[relName]
      if (!relDef) continue

      const rel = relationData.get(key)
      const index = indexes.get(relName)
      const hasNested = Object.keys(relAST.related).length > 0

      let matchedItems: unknown[]

      if (rel?.kind === 'perParent') {
        const sourceValue = getFieldValue(item, relDef.sourceField)
        matchedItems =
          sourceValue === undefined ? [] : (rel.byParent.get(sourceValueKey(sourceValue)) ?? [])
      } else if (relDef.cardinality === 'embedded') {
        const sourceList = getFieldValueAsList(item, relDef.sourceField)
        matchedItems = []
        if (sourceList) {
          // Walk the parent's id list (preserves the server-chosen order) and look up
          // each id against the materialised dest set.
          for (const id of sourceList) {
            const found = index?.byKey?.get(id)
            if (found) matchedItems.push(found)
          }
        }
      } else if (relDef.via) {
        // Two-hop: walk this parent's junction rows, then collect dest items keyed
        // by the junction's outgoing FK.
        const parentJoinValue = getFieldValue(item, relDef.via.sourceField)
        const junctions =
          parentJoinValue === undefined ? undefined : index?.junctionsByParent?.get(parentJoinValue)
        matchedItems = []
        if (junctions) {
          for (const j of junctions) {
            const destId = getFieldValue(j, relDef.sourceField)
            if (destId === undefined) continue
            const found = index?.byKey?.get(destId)
            if (found) matchedItems.push(found)
          }
        }
        // A chained `one` resolves to the first (declared-selective) match, or null.
        if (relDef.cardinality === 'one') {
          let found: unknown = matchedItems[0] ?? null
          if (hasNested && found) {
            found = assembleRelations([found], relAST, schema, relationData, key)[0] ?? null
          }
          result[relName] = found
          continue
        }
      } else if (relDef.cardinality === 'one') {
        const sourceValue = getFieldValue(item, relDef.sourceField)
        const found = sourceValue === undefined ? null : (index?.byKey?.get(sourceValue) ?? null)
        result[relName] = found
        if (hasNested && found) {
          const assembled = assembleRelations([found], relAST, schema, relationData, key)
          result[relName] = assembled[0] ?? null
        }
        continue
      } else {
        // Single-hop many — every entity whose dest key matches this parent.
        const sourceValue = getFieldValue(item, relDef.sourceField)
        matchedItems = sourceValue === undefined ? [] : (index?.listByKey?.get(sourceValue) ?? [])
      }

      if (hasNested && matchedItems.length > 0) {
        matchedItems = assembleRelations(matchedItems, relAST, schema, relationData, key)
      }
      result[relName] = matchedItems
    }

    return result
  })
}
