import type { QueryAST } from '../core/queryBuilder.js'
import type { DevtoolsSnapshot, QueryRecord } from './collector.js'
import { compactJson } from './format.js'

export interface UnderlyingFetch {
  path: string
  role?: 'junction'
  query: QueryRecord
}

export type QuerySummary = Omit<QueryRecord, 'generation' | 'queryId'>

export interface QueryComposition {
  detail: string
  operation: string
  planDetail: string
  title: string
}

export interface EventQueryScope {
  kind: 'root' | 'nested' | 'standalone'
  operationKey: string
  label: string
  title: string
}

export interface DevtoolsOperation {
  key: string
  summary: QuerySummary
  rootFetches: QueryRecord[]
  underlying: UnderlyingFetch[]
  composition?: QueryComposition
}

export interface DevtoolsModel {
  operations: DevtoolsOperation[]
  scopesByQueryId: ReadonlyMap<string, readonly EventQueryScope[]>
}

export function buildDevtoolsModel(snapshot: DevtoolsSnapshot): DevtoolsModel {
  const queryById = new Map(snapshot.queries.map(query => [query.queryId, query]))
  const ownedQueryIds = new Set<string>()
  const scopesByQueryId = new Map<string, EventQueryScope[]>()
  const operations: DevtoolsOperation[] = []

  for (const group of snapshot.relational) {
    const rootFetches = uniqueQueries(
      group.nodes
        .filter(node => node.path === '(root)')
        .map(node => queryById.get(node.queryId))
        .filter((query): query is QueryRecord => query !== undefined),
    )
    if (rootFetches.length === 0) continue

    const underlyingByPath = new Map<string, UnderlyingFetch>()
    for (const node of group.nodes) {
      ownedQueryIds.add(node.queryId)
      if (node.path === '(root)') {
        addScope(scopesByQueryId, node.queryId, {
          kind: 'root',
          operationKey: group.key,
          label: 'root',
          title: group.name ? `root query for ${group.name}` : 'root relational query',
        })
        continue
      }

      const roleLabel = node.role === 'junction' ? `${node.path} junction` : node.path
      addScope(scopesByQueryId, node.queryId, {
        kind: 'nested',
        operationKey: group.key,
        label: `nested: ${roleLabel}`,
        title: group.name
          ? `nested relation ${roleLabel} for ${group.name}`
          : `nested relation ${roleLabel}`,
      })
      const query = queryById.get(node.queryId)
      if (!query) continue
      underlyingByPath.set(`${node.path}:${node.role ?? ''}:${node.queryId}`, {
        path: node.path,
        ...(node.role ? { role: node.role } : {}),
        query,
      })
    }

    operations.push({
      key: group.key,
      summary: summarizeRootFetches(rootFetches),
      rootFetches,
      underlying: [...underlyingByPath.values()],
      composition: describeComposition(group.ast, group.name),
    })
  }

  for (const query of snapshot.queries) {
    if (ownedQueryIds.has(query.queryId)) continue
    addScope(scopesByQueryId, query.queryId, {
      kind: 'standalone',
      operationKey: query.queryId,
      label: 'standalone',
      title: 'standalone query',
    })
    operations.push({
      key: query.queryId,
      summary: querySummary(query),
      rootFetches: [query],
      underlying: [],
    })
  }

  return { operations, scopesByQueryId }
}

function summarizeRootFetches(roots: QueryRecord[]): QuerySummary {
  if (roots.length === 1) return querySummary(roots[0]!)
  const latest = roots.reduce((current, query) =>
    (query.fetchedAt ?? -Infinity) > (current.fetchedAt ?? -Infinity) ? query : current,
  )
  const lastError = roots
    .map(query => query.lastError)
    .filter((error): error is NonNullable<QueryRecord['lastError']> => error !== undefined)
    .sort((a, b) => b.at - a.at)[0]

  return {
    present: roots.some(query => query.present),
    serviceName: latest.serviceName,
    method: latest.method,
    ...(latest.resourceId !== undefined ? { resourceId: latest.resourceId } : {}),
    query: latest.query,
    classification: latest.classification,
    status: roots.some(query => query.status === 'error')
      ? 'error'
      : roots.some(query => query.status === 'loading')
        ? 'loading'
        : 'success',
    isFetching: roots.some(query => query.isFetching),
    itemCount: roots.reduce((count, query) => count + query.itemCount, 0),
    fetchedAt: latest.fetchedAt,
    subscriberCount: Math.max(...roots.map(query => query.subscriberCount)),
    fetchCount: roots.reduce((count, query) => count + query.fetchCount, 0),
    errorCount: roots.reduce((count, query) => count + query.errorCount, 0),
    totalDurationMs: roots.reduce((duration, query) => duration + query.totalDurationMs, 0),
    spans: roots.flatMap(query => query.spans).sort((a, b) => a.startAt - b.startAt),
    realtimeSeen: Math.max(...roots.map(query => query.realtimeSeen)),
    reconciles: roots.reduce((count, query) => count + query.reconciles, 0),
    ...(latest.lastDurationMs !== undefined ? { lastDurationMs: latest.lastDurationMs } : {}),
    ...(lastError ? { lastError } : {}),
  }
}

function querySummary({
  generation: _generation,
  queryId: _queryId,
  ...summary
}: QueryRecord): QuerySummary {
  return summary
}

function uniqueQueries(queries: QueryRecord[]): QueryRecord[] {
  return [...new Map(queries.map(query => [query.queryId, query])).values()]
}

function addScope(
  scopes: Map<string, EventQueryScope[]>,
  queryId: string,
  scope: EventQueryScope,
): void {
  const current = scopes.get(queryId) ?? []
  if (
    !current.some(
      item =>
        item.operationKey === scope.operationKey &&
        item.kind === scope.kind &&
        item.title === scope.title,
    )
  ) {
    current.push(scope)
  }
  scopes.set(queryId, current)
}

function describeComposition(ast: QueryAST, name?: string): QueryComposition {
  const head = formatAstHead(ast)
  const rootQuery = compactAstQuery(ast.query)
  const related = relationPaths(ast)
  const parts = [
    head,
    rootQuery,
    related.length > 0 ? `with ${formatList(related)}` : '',
    ast.server ? 'server' : '',
    ast.snapshot ? 'snapshot' : '',
  ].filter(Boolean)
  return {
    detail: parts.join(' · '),
    operation: `${ast.service}.${head}`,
    planDetail: [rootQuery || 'all', related.length > 0 ? `with ${formatList(related)}` : '']
      .filter(Boolean)
      .join(' · '),
    title: [name, astToTitle(ast)].filter(Boolean).join('\n'),
  }
}

function astToTitle(ast: QueryAST, path = '(root)'): string {
  const query = compactAstQuery(ast.query)
  const line = [
    `${path}: ${ast.service}.${formatAstHead(ast)}`,
    query,
    ast.server ? 'server' : '',
    ast.snapshot ? 'snapshot' : '',
  ]
    .filter(Boolean)
    .join(' · ')
  const children = Object.entries(ast.related).flatMap(([name, child]) =>
    astToTitle(child, path === '(root)' ? name : `${path}.${name}`).split('\n'),
  )
  return [line, ...children].join('\n')
}

function formatAstHead(ast: QueryAST): string {
  if (ast.kind === 'get') return `get(${formatAstValue(ast.resourceId)})`
  if (ast.kind === 'paginate') return `paginate(${ast.pageSize ?? '?'})`
  return ast.kind
}

function compactAstQuery(query: QueryAST['query']): string {
  return Object.keys(query).length > 0 ? compactJson(query) : ''
}

function relationPaths(ast: QueryAST, prefix = ''): string[] {
  return Object.entries(ast.related).flatMap(([name, child]) => {
    const path = prefix ? `${prefix}.${name}` : name
    return [path, ...relationPaths(child, path)]
  })
}

function formatAstValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === undefined) return '?'
  return String(value)
}

function formatList(values: string[]): string {
  if (values.length <= 3) return values.join(', ')
  return `${values.slice(0, 3).join(', ')} +${values.length - 3}`
}
