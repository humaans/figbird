import type { FigbirdEvent } from '../../lib/core/events.js'
import type { InFlightMutation } from '../../lib/core/mutationTracker.js'
import type { InspectedRelationalQuery } from '../../lib/core/relationalQuery.js'
import type {
  DevtoolsBridgeConnection,
  DevtoolsWireError,
  DevtoolsWireEvent,
  DevtoolsWireInspection,
  DevtoolsWireRead,
} from '../../lib/core/devtoolsBridge.js'

export function parseConnection(value: unknown): DevtoolsBridgeConnection | null {
  if (value === null || value === undefined) return null
  if (
    !isRecord(value) ||
    value.protocol !== 1 ||
    typeof value.instanceCount !== 'number' ||
    typeof value.instanceId !== 'number' ||
    typeof value.sessionId !== 'string'
  ) {
    throw new Error('Figbird returned an invalid devtools connection')
  }
  return {
    instanceCount: value.instanceCount,
    instanceId: value.instanceId,
    protocol: value.protocol,
    sessionId: value.sessionId,
  }
}

export function parseWireRead(value: unknown): DevtoolsWireRead | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error('Figbird returned an invalid devtools snapshot')

  const parsed: unknown = JSON.parse(value)
  if (!isWireRead(parsed)) throw new Error('Figbird returned an invalid devtools snapshot')
  return parsed
}

export function decodeEvent(event: DevtoolsWireEvent): FigbirdEvent {
  switch (event.kind) {
    case 'fetch:error':
    case 'mutate:error':
    case 'action:error': {
      const error = new Error(event.error.message)
      error.name = event.error.name
      return { ...event, error }
    }
    default:
      return event
  }
}

function isWireRead(value: unknown): value is DevtoolsWireRead {
  return (
    isRecord(value) &&
    isArrayOf(value.events, isWireEvent) &&
    isArrayOf(value.inFlightMutations, isInFlightMutation) &&
    isWireInspection(value.inspection) &&
    isArrayOf(value.queries, isWireQuery) &&
    isArrayOf(value.relational, isInspectedRelationalQuery)
  )
}

function isWireEvent(value: unknown): value is DevtoolsWireEvent {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case 'fetch:error':
    case 'mutate:error':
    case 'action:error':
      return isWireError(value.error)
    case 'fetch:start':
    case 'fetch:end':
    case 'reconcile:started':
    case 'realtime':
    case 'mutate:start':
    case 'mutate:end':
    case 'mutate:rollback':
    case 'action:start':
    case 'action:end':
      return true
    default:
      return false
  }
}

function isWireError(value: unknown): value is DevtoolsWireError {
  return isRecord(value) && typeof value.message === 'string' && typeof value.name === 'string'
}

function isInFlightMutation(value: unknown): value is InFlightMutation {
  return (
    isRecord(value) &&
    typeof value.mutationId === 'number' &&
    typeof value.serviceName === 'string' &&
    typeof value.method === 'string' &&
    (value.id === undefined || typeof value.id === 'string' || typeof value.id === 'number')
  )
}

function isWireQuery(value: unknown): value is DevtoolsWireRead['queries'][number] {
  return (
    isRecord(value) &&
    typeof value.queryId === 'string' &&
    typeof value.generation === 'number' &&
    typeof value.serviceName === 'string' &&
    (value.method === 'find' || value.method === 'get') &&
    (value.resourceId === undefined ||
      typeof value.resourceId === 'string' ||
      typeof value.resourceId === 'number') &&
    (value.query === undefined || isRecord(value.query)) &&
    (value.classification === 'local-exact' ||
      value.classification === 'server-window' ||
      value.classification === 'server-authoritative' ||
      value.classification === 'get') &&
    (value.status === 'loading' || value.status === 'success' || value.status === 'error') &&
    typeof value.isFetching === 'boolean' &&
    typeof value.itemCount === 'number' &&
    (value.fetchedAt === undefined || typeof value.fetchedAt === 'number') &&
    typeof value.subscriberCount === 'number' &&
    typeof value.fetchCount === 'number' &&
    typeof value.errorCount === 'number' &&
    (value.lastDurationMs === undefined || typeof value.lastDurationMs === 'number') &&
    typeof value.totalDurationMs === 'number'
  )
}

function isInspectedRelationalQuery(value: unknown): value is InspectedRelationalQuery {
  return (
    isRecord(value) &&
    typeof value.key === 'string' &&
    (value.name === undefined || typeof value.name === 'string') &&
    typeof value.service === 'string' &&
    isQueryAst(value.ast) &&
    isArrayOf(value.nodes, isInspectedRelationalNode)
  )
}

function isInspectedRelationalNode(
  value: unknown,
): value is InspectedRelationalQuery['nodes'][number] {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.queryId === 'string' &&
    (value.role === undefined || value.role === 'junction')
  )
}

function isQueryAst(value: unknown): value is InspectedRelationalQuery['ast'] {
  return (
    isRecord(value) &&
    typeof value.service === 'string' &&
    (value.kind === 'find' ||
      value.kind === 'get' ||
      value.kind === 'paginate' ||
      value.kind === 'all') &&
    (value.resourceId === undefined ||
      typeof value.resourceId === 'string' ||
      typeof value.resourceId === 'number') &&
    isRecord(value.query) &&
    (value.cardinality === 'one' || value.cardinality === 'many') &&
    isRecord(value.related) &&
    Object.values(value.related).every(isQueryAst) &&
    (value.server === undefined || typeof value.server === 'boolean') &&
    (value.snapshot === undefined || typeof value.snapshot === 'boolean') &&
    (value.pageSize === undefined || typeof value.pageSize === 'number') &&
    (value.returnTotal === undefined || typeof value.returnTotal === 'boolean')
  )
}

function isWireInspection(value: unknown): value is DevtoolsWireInspection {
  return (
    isRecord(value) &&
    typeof value.active === 'boolean' &&
    typeof value.version === 'number' &&
    (value.label === undefined || typeof value.label === 'string') &&
    (value.queryCounts === undefined || isNumberRecord(value.queryCounts)) &&
    (value.supported === undefined || typeof value.supported === 'boolean') &&
    (value.truncated === undefined || typeof value.truncated === 'boolean')
  )
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every(item => typeof item === 'number')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isArrayOf<T>(value: unknown, predicate: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every(predicate)
}
