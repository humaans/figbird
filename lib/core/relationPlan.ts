import type { QueryAST } from './queryBuilder.js'
import {
  explainQueryNode,
  planRootPagination,
  rootAllPages,
  rootServerReasons,
  type ExplainNode,
  type QueryNodeClass,
} from './queryClassification.js'
import { relationalFilterServerReasons } from './relationalFilters.js'
import { resolveServicePath, type RelationshipDef, type Schema } from './schema.js'
import type { FindDescriptor, FindQueryConfig } from './queryTypes.js'

type RelationValue = string | number

export interface RelationQueryPlan {
  service: string
  serviceName: string
  /** The destination field the source values are matched against. */
  field: string
  query: Record<string, unknown>
  descriptor(value: RelationValue | { $in: RelationValue[] }): FindDescriptor
  config: FindQueryConfig
}

interface PlannedRelation {
  name: string
  key: string
  definition: RelationshipDef
  /** The refinement's or definition's `$sort`, which each parent's items follow. */
  sort: Record<string, number> | null
  /**
   * An unsorted `embed` window, applied to each parent's list in assembly. Parents
   * read their ids up to `fetchEnd`, and the matched items are sliced to
   * `[start, end)`; a filtered window reads the whole list, as any id may not match.
   */
  listWindow: { start: number; end: number | undefined; fetchEnd: number | undefined } | null
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
  const bind = (value: RelationValue | { $in: RelationValue[] }) => ({
    ...before,
    [field]: value,
    ...after,
  })
  return {
    service,
    serviceName,
    field,
    query: bind({ $in: [] }),
    descriptor: value => ({
      serviceName,
      method: 'find',
      params: { query: bind(value) },
    }),
    config,
  }
}

function embedWindow(query: Record<string, unknown>): NonNullable<PlannedRelation['listWindow']> {
  const start = (query.$skip as number | undefined) ?? 0
  const limit = query.$limit as number | undefined
  const end = limit === undefined ? undefined : start + limit
  const filtered = Object.keys(query).some(
    key => key !== '$limit' && key !== '$skip' && key !== '$select',
  )
  return { start, end, fetchEnd: filtered ? undefined : end }
}

/** A list window is applied in assembly, so its destination fetch carries none. */
function unwindowed(
  query: Record<string, unknown>,
  listWindow: PlannedRelation['listWindow'],
): Record<string, unknown> {
  if (!listWindow) return query
  return Object.fromEntries(
    Object.entries(query).filter(([key]) => key !== '$limit' && key !== '$skip'),
  )
}

/** Resolve immutable schema/AST decisions once; only source values vary at runtime. */
export function compileRelations(
  ast: QueryAST,
  schema: Schema,
  realtime: 'merge' | 'disabled',
  parentKey: string | null = null,
): RelationPlan[] {
  return Object.entries(ast.related).map(([name, child]) => {
    const key = parentKey ? `${parentKey}.${name}` : name
    const definition = schema.relationships?.[ast.service]?.[name]
    if (!definition) return { kind: 'missing', key, name, service: ast.service }
    const query = { ...child.query, ...definition.query }
    const explicitSort = (query.$sort as Record<string, number> | undefined) ?? null
    const windowed = '$limit' in query || '$skip' in query
    // An unsorted embed window follows each parent's list order, so it is a slice of
    // the list: one shared `$in` fetch, windowed per parent in assembly.
    const listWindow =
      windowed && definition.cardinality === 'embedded' && !explicitSort ? embedWindow(query) : null
    // Other windows apply to each parent, so they can't ride on one shared `$in` fetch.
    // The builder rejects windows on junction relations, which have no per-parent find.
    const perParent = windowed && !listWindow
    const strategy = definition.via ? 'junction' : perParent ? 'perParent' : 'fanIn'
    const allPages = !perParent
    const sort =
      strategy !== 'perParent' &&
      !explicitSort &&
      (definition.cardinality === 'one' || definition.cardinality === 'embedded' || definition.via)
        ? { $sort: { [definition.destField]: 1 } }
        : {}
    const common = {
      name,
      key,
      definition,
      sort: explicitSort,
      listWindow,
      children: compileRelations(child, schema, realtime, key),
      destination: queryPlan(
        schema,
        definition.destService,
        definition.destField,
        { ...unwindowed(child.query, listWindow), ...sort },
        unwindowed(definition.query ?? {}, listWindow),
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

/** Explain the same resolved queries used by subscriptions and assembly. */
export function explainQuery(
  ast: QueryAST,
  schema: Schema,
  localOperatorsFor: (serviceName: string) => ReadonlySet<string>,
  hasNativePagination: (serviceName: string) => boolean,
): ExplainNode[] {
  const snapshot = Boolean(ast.snapshot)
  const rootReasons = rootServerReasons(
    Boolean(ast.server),
    relationalFilterServerReasons(schema, ast),
  )
  const pagination =
    ast.kind === 'paginate'
      ? planRootPagination(hasNativePagination(ast.service), rootReasons)
      : null
  const serverReasons = pagination?.serverReasons ?? rootReasons
  const root = explainQueryNode(ast.query, {
    server: serverReasons.length > 0,
    serverReasons,
    allPages: rootAllPages(ast.kind),
    localOperators: localOperatorsFor(ast.service),
    snapshot,
    paginatedRoot: pagination?.kind === 'offset',
  })
  const nodes: ExplainNode[] = [
    {
      path: '(root)',
      service: ast.service,
      kind: ast.kind,
      class: root.class,
      reasons: root.reasons,
      realtime: realtime(root.class),
    },
  ]
  visit(compileRelations(ast, schema, snapshot ? 'disabled' : 'merge'))
  return nodes

  function realtime(classification: QueryNodeClass): ExplainNode['realtime'] {
    return snapshot ? 'manual' : classification === 'local-exact' ? 'merge' : 'refetch'
  }

  function explain(plan: RelationQueryPlan) {
    return explainQueryNode(plan.query, {
      server: plan.config.server,
      allPages: plan.config.allPages,
      localOperators: localOperatorsFor(plan.service),
    })
  }

  function visit(plans: RelationPlan[]): void {
    for (const plan of plans) {
      if (plan.kind === 'missing') continue
      if (plan.kind === 'junction') {
        const explained = explain(plan.junction)
        nodes.push({
          path: `${plan.key}#junction`,
          service: plan.junction.service,
          kind: 'find',
          role: 'junction',
          class: explained.class,
          reasons: explained.reasons,
          realtime: realtime(explained.class),
        })
      }
      const explained = explain(plan.destination)
      if (plan.kind === 'perParent') {
        explained.reasons.push({
          code: 'window-filter',
          detail: 'per-parent window — one query per parent',
        })
      }
      nodes.push({
        path: plan.key,
        service: plan.destination.service,
        kind: 'find',
        class: explained.class,
        reasons: explained.reasons,
        realtime: realtime(explained.class),
        ...(plan.kind === 'junction' ? { via: plan.junction.service } : {}),
      })
      visit(plan.children)
    }
  }
}
