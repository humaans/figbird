import type { QueryAST } from '../core/queryBuilder.js'
import type { DevtoolsSnapshot, QueryRecord } from './collector.js'
import { compactJson } from './format.js'

export interface QueryOwner {
  operationKey: string
  label: string
  path: string
}

export interface UnderlyingFetch {
  owner: QueryOwner
  query: QueryRecord
}

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
  kind: 'relational' | 'standalone'
  query: QueryRecord
  rootFetches: QueryRecord[]
  underlying: UnderlyingFetch[]
  relationalKeys: ReadonlySet<string>
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
    const label = group.name || group.service || group.key
    const rootFetches = uniqueQueries(
      group.nodes
        .filter(node => node.path === '(root)')
        .map(node => queryById.get(node.queryId))
        .filter((query): query is QueryRecord => query !== undefined),
    )
    if (rootFetches.length === 0) continue

    const underlyingByOwner = new Map<string, UnderlyingFetch>()
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

      addScope(scopesByQueryId, node.queryId, {
        kind: 'nested',
        operationKey: group.key,
        label: `nested: ${node.path}`,
        title: group.name
          ? `nested relation ${node.path} for ${group.name}`
          : `nested relation ${node.path}`,
      })
      const query = queryById.get(node.queryId)
      if (!query) continue
      const owner = { operationKey: group.key, label, path: node.path }
      underlyingByOwner.set(`${node.path}:${node.queryId}`, { owner, query })
    }

    operations.push({
      key: group.key,
      kind: 'relational',
      query: aggregateRootFetches(group.key, rootFetches),
      rootFetches,
      underlying: [...underlyingByOwner.values()],
      relationalKeys: new Set([group.key]),
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
      kind: 'standalone',
      query,
      rootFetches: [query],
      underlying: [],
      relationalKeys: new Set([query.queryId]),
    })
  }

  return { operations, scopesByQueryId }
}

function aggregateRootFetches(key: string, roots: QueryRecord[]): QueryRecord {
  if (roots.length === 1) return roots[0]!
  const latest = roots.reduce((current, query) =>
    (query.fetchedAt ?? -Infinity) > (current.fetchedAt ?? -Infinity) ? query : current,
  )
  const lastError = roots
    .map(query => query.lastError)
    .filter((error): error is NonNullable<QueryRecord['lastError']> => error !== undefined)
    .sort((a, b) => b.at - a.at)[0]

  return {
    queryId: key,
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
