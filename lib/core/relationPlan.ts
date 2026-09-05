import type { QueryAST } from './queryBuilder.js'
import { planRelation } from './queryClassification.js'
import { relationKey } from './relationalAssembly.js'
import { resolveServicePath, type RelationshipDef, type Schema } from './schema.js'
import type { FindDescriptor, FindQueryConfig } from './queryTypes.js'

type RelationValue = string | number

interface RelationQueryPlan {
  descriptor(value: RelationValue | { $in: RelationValue[] }): FindDescriptor
  config: FindQueryConfig
}

interface PlannedRelation {
  key: string
  definition: RelationshipDef
  children: RelationPlan[]
  destination: RelationQueryPlan
}

export type RelationPlan =
  | { kind: 'missing'; key: string; name: string; service: string }
  | (PlannedRelation & { kind: 'fanIn' | 'perParent' })
  | (PlannedRelation & { kind: 'junction'; junction: RelationQueryPlan })

function queryPlan(
  schema: Schema,
  service: string,
  field: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  config: FindQueryConfig,
): RelationQueryPlan {
  const serviceName = resolveServicePath(schema, service)
  return {
    descriptor: value => ({
      serviceName,
      method: 'find',
      params: { query: { ...before, [field]: value, ...after } },
    }),
    config,
  }
}

/** Resolve immutable schema/AST decisions once; only source values vary at runtime. */
export function compileRelations(
  ast: QueryAST,
  schema: Schema,
  realtime: 'merge' | 'disabled',
  parentKey: string | null = null,
): RelationPlan[] {
  return Object.entries(ast.related).map(([name, child]) => {
    const key = relationKey(parentKey, name)
    const definition = schema.relationships?.[ast.service]?.[name]
    if (!definition) return { kind: 'missing', key, name, service: ast.service }
    const { strategy, allPages } = planRelation(definition, child.query)
    const hasSort = '$sort' in child.query || '$sort' in (definition.query ?? {})
    const sort =
      strategy !== 'perParent' &&
      !hasSort &&
      (definition.cardinality === 'one' || definition.cardinality === 'embedded' || definition.via)
        ? { $sort: { [definition.destField]: 1 } }
        : {}
    const common = {
      key,
      definition,
      children: compileRelations(child, schema, realtime, key),
      destination: queryPlan(
        schema,
        definition.destService,
        definition.destField,
        { ...child.query, ...sort },
        definition.query ?? {},
        {
          realtime,
          fetchPolicy: 'swr',
          ...(strategy !== 'perParent' && allPages ? { allPages: true } : {}),
          ...(child.server ? { server: true } : {}),
        },
      ),
    }
    if (strategy === 'junction' && definition.via) {
      const via = definition.via
      return {
        ...common,
        kind: 'junction',
        junction: queryPlan(schema, via.destService, via.destField, {}, via.query ?? {}, {
          realtime,
          fetchPolicy: 'swr',
          allPages: true,
        }),
      }
    }
    return { ...common, kind: strategy === 'perParent' ? 'perParent' : 'fanIn' }
  })
}
