import type { FigbirdEvent, FigbirdEvents } from './events.js'
import type { InspectedCacheService, InspectedQuery } from './figbird.js'
import type { InspectedRelationalQuery } from './relationalQuery.js'
import type { InFlightMutation, MutationActivity } from './mutationTracker.js'
import { CappedBuffer } from './cappedBuffer.js'
import { errorDetails } from './errors.js'

const BRIDGE_KEY = '__FIGBIRD_DEVTOOLS__'
const SESSION_TIMEOUT_MS = 5_000
const EVENT_LIMIT = 5_000
const STARTUP_CAPTURE_KEY = '__FIGBIRD_DEVTOOLS_CAPTURE_UNTIL__'
const STARTUP_CAPTURE_TTL_MS = 10_000
const PAYLOAD_MAX_DEPTH = 8
const PAYLOAD_MAX_ARRAY_ITEMS = 200
const PAYLOAD_MAX_OBJECT_PROPERTIES = 100
const PAYLOAD_MAX_NODES = 2_000
const PAYLOAD_MAX_STRING_CHARACTERS = 100_000
let cachedStartupCaptureUntil = 0

interface DevtoolsSource {
  events: FigbirdEvents
  mutating: MutationActivity
  inspect(): InspectedQuery[]
  inspectCache(): InspectedCacheService[]
  inspectRelational(): InspectedRelationalQuery[]
  editCacheEntity(
    serviceName: string,
    itemId: string | number,
    item: unknown,
  ): { ok: boolean; error?: string; traceId?: number }
  subscribeToStateChanges(fn: (state: unknown) => void): () => void
}

export interface DevtoolsWireError {
  message: string
  name: string
  details?: unknown
}

type ToWireEvent<E> = E extends unknown
  ? 'error' extends keyof E
    ? Omit<E, 'error'> &
        (E extends { error: Error } ? { error: DevtoolsWireError } : { error?: DevtoolsWireError })
    : E
  : never

export type DevtoolsWireEvent = ToWireEvent<FigbirdEvent>

export type DevtoolsWireQuery = Omit<InspectedQuery, 'fetchedAt' | 'query'> & {
  fetchedAt?: number | undefined
  query?: Record<string, unknown> | undefined
}

export interface DevtoolsBridgeConnection {
  instanceCount: number
  instanceId: number
  protocol: 2 | 3
  sessionId: string
}

export interface DevtoolsWireRead {
  cache?: InspectedCacheService[]
  events: DevtoolsWireEvent[]
  inFlightMutations?: readonly InFlightMutation[]
  queries?: DevtoolsWireQuery[]
  relational?: InspectedRelationalQuery[]
}

export interface DevtoolsWireEnvelope {
  protocol: 3
  version: number
  read: DevtoolsWireRead | null
}

interface DevtoolsBridgeSession {
  cacheDirty: boolean
  events: CappedBuffer<FigbirdEvent>
  expires: ReturnType<typeof setTimeout> | null
  mutationsDirty: boolean
  queriesDirty: boolean
  relationalDirty: boolean
  source: DevtoolsSource
  unsubscribe: () => void
  version: number
}

interface StartupCapture {
  events: CappedBuffer<FigbirdEvent>
  expires: ReturnType<typeof setTimeout>
  unsubscribe: () => void
}

interface DevtoolsPageBridge {
  protocol: 2 | 3
  connect(instanceId?: number): DevtoolsBridgeConnection | null
  disconnect(sessionId: string): void
  editCacheEntityJson(
    sessionId: string,
    serviceName: string,
    itemIdJson: string,
    itemJson: string,
  ): string
  readJson(sessionId: string, version: number | null): string | null
  register(source: DevtoolsSource): void
}

let fallbackBridge: DevtoolsPageBridge | undefined

/** Register a Figbird instance for browser extensions without starting collection. */
export function registerDevtoolsInstance(source: DevtoolsSource): void {
  if (typeof window === 'undefined' || typeof WeakRef === 'undefined') return
  getPageBridge().register(source)
}

function getPageBridge(): DevtoolsPageBridge {
  if (fallbackBridge) return fallbackBridge
  const globalRecord = globalThis as typeof globalThis & Record<string, unknown>
  const existing = globalRecord[BRIDGE_KEY]
  if (isPageBridge(existing)) return existing

  const bridge = createPageBridge()
  try {
    Object.defineProperty(globalRecord, BRIDGE_KEY, {
      configurable: true,
      enumerable: false,
      value: bridge,
    })
  } catch {
    fallbackBridge = bridge
  }
  return fallbackBridge ?? bridge
}

function isPageBridge(value: unknown): value is DevtoolsPageBridge {
  return (
    typeof value === 'object' &&
    value !== null &&
    'protocol' in value &&
    (value.protocol === 2 || value.protocol === 3) &&
    'register' in value &&
    typeof value.register === 'function' &&
    'connect' in value &&
    typeof value.connect === 'function' &&
    'readJson' in value &&
    typeof value.readJson === 'function' &&
    'editCacheEntityJson' in value &&
    typeof value.editCacheEntityJson === 'function'
  )
}

function createPageBridge(): DevtoolsPageBridge {
  const instances = new Map<number, WeakRef<DevtoolsSource>>()
  const sessions = new Map<string, DevtoolsBridgeSession>()
  const startupCaptures = new Map<number, StartupCapture>()
  let nextInstanceId = 1
  let nextSessionId = 1

  const closeSession = (sessionId: string): boolean => {
    const session = sessions.get(sessionId)
    if (!session) return false
    if (session.expires) clearTimeout(session.expires)
    session.unsubscribe()
    sessions.delete(sessionId)
    return true
  }

  const closeStartupCapture = (instanceId: number) => {
    const capture = startupCaptures.get(instanceId)
    if (!capture) return
    clearTimeout(capture.expires)
    capture.unsubscribe()
    startupCaptures.delete(instanceId)
  }

  const refreshExpiry = (sessionId: string, session: DevtoolsBridgeSession) => {
    if (session.expires) clearTimeout(session.expires)
    session.expires = setTimeout(() => closeSession(sessionId), SESSION_TIMEOUT_MS)
  }

  return {
    protocol: 3,

    register(source) {
      const instanceId = nextInstanceId++
      instances.set(instanceId, new WeakRef(source))
      const captureUntil = startupCaptureUntil()
      if (captureUntil <= Date.now()) return
      const events = new CappedBuffer<FigbirdEvent>(EVENT_LIMIT)
      const unsubscribe = source.events.subscribe(event => events.push(event))
      const expires = setTimeout(
        () => closeStartupCapture(instanceId),
        Math.max(0, captureUntil - Date.now()),
      )
      startupCaptures.set(instanceId, { events, expires, unsubscribe })
    },

    connect(instanceId) {
      refreshStartupCaptureMarker()
      removeCollectedInstances(instances, closeStartupCapture)
      const instance = resolveInstance(instances, instanceId)
      if (!instance) return null
      const [resolvedId, source] = instance
      const sessionId = `${Date.now().toString(36)}-${nextSessionId++}`
      const session: DevtoolsBridgeSession = {
        cacheDirty: true,
        events: new CappedBuffer(EVENT_LIMIT),
        expires: null,
        mutationsDirty: true,
        queriesDirty: true,
        relationalDirty: true,
        source,
        unsubscribe: () => {},
        version: 1,
      }
      const unsubscribers = [
        source.events.subscribe(event => {
          session.events.push(event)
          if (event.kind === 'cache:updated') session.cacheDirty = true
          session.version++
        }),
        source.mutating.subscribe(() => {
          session.mutationsDirty = true
          session.version++
        }),
        source.subscribeToStateChanges(() => {
          session.queriesDirty = true
          session.relationalDirty = true
          session.version++
        }),
      ]
      session.unsubscribe = () => {
        for (const unsubscribe of unsubscribers) unsubscribe()
      }
      const startupCapture = startupCaptures.get(resolvedId)
      if (startupCapture) {
        for (const event of startupCapture.events.toArray()) session.events.push(event)
        closeStartupCapture(resolvedId)
      }
      sessions.set(sessionId, session)
      refreshExpiry(sessionId, session)
      return {
        instanceCount: instances.size,
        instanceId: resolvedId,
        protocol: 3,
        sessionId,
      }
    },

    disconnect(sessionId) {
      const closed = closeSession(sessionId)
      if (closed && sessions.size === 0) {
        clearStartupCaptureMarker()
        for (const instanceId of startupCaptures.keys()) closeStartupCapture(instanceId)
      }
    },

    editCacheEntityJson(sessionId, serviceName, itemIdJson, itemJson) {
      const session = sessions.get(sessionId)
      if (!session) return '{"ok":false,"error":"Devtools session expired"}'
      refreshExpiry(sessionId, session)
      try {
        const itemId = JSON.parse(itemIdJson) as unknown
        if (typeof itemId !== 'string' && typeof itemId !== 'number') {
          return '{"ok":false,"error":"Entity ID must be a string or number"}'
        }
        const result = session.source.editCacheEntity(serviceName, itemId, JSON.parse(itemJson))
        session.cacheDirty = true
        session.queriesDirty = true
        session.relationalDirty = true
        session.version++
        return JSON.stringify(result)
      } catch (error) {
        return JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },

    readJson(sessionId, version) {
      const session = sessions.get(sessionId)
      if (!session) return null
      refreshStartupCaptureMarker()
      refreshExpiry(sessionId, session)
      if (version === session.version) {
        return `{"protocol":2,"version":${session.version},"read":null}`
      }
      const pendingEvents = session.events.toArray()
      const serialized = serializeWireEnvelope({
        protocol: 3,
        version: session.version,
        read: {
          ...(session.cacheDirty ? { cache: session.source.inspectCache() } : {}),
          events: pendingEvents.map(toWireEvent),
          ...(session.mutationsDirty
            ? { inFlightMutations: session.source.mutating.getSnapshot() }
            : {}),
          ...(session.queriesDirty ? { queries: session.source.inspect() } : {}),
          ...(session.relationalDirty ? { relational: session.source.inspectRelational() } : {}),
        },
      })
      session.events.clear()
      session.cacheDirty = false
      session.mutationsDirty = false
      session.queriesDirty = false
      session.relationalDirty = false
      return serialized
    },
  }
}

function resolveInstance(
  instances: ReadonlyMap<number, WeakRef<DevtoolsSource>>,
  requestedId: number | undefined,
): [number, DevtoolsSource] | null {
  if (requestedId !== undefined) {
    const source = instances.get(requestedId)?.deref()
    return source ? [requestedId, source] : null
  }
  const candidates = [...instances.entries()].sort(([a], [b]) => b - a)
  for (const [id, reference] of candidates) {
    const source = reference.deref()
    if (source) return [id, source]
  }
  return null
}

function removeCollectedInstances(
  instances: Map<number, WeakRef<DevtoolsSource>>,
  onRemove: (instanceId: number) => void,
): void {
  for (const [id, reference] of instances) {
    if (reference.deref()) continue
    instances.delete(id)
    onRemove(id)
  }
}

function startupCaptureUntil(): number {
  if (cachedStartupCaptureUntil > Date.now()) return cachedStartupCaptureUntil
  try {
    if (typeof sessionStorage === 'undefined') return 0
    const value = Number(sessionStorage.getItem(STARTUP_CAPTURE_KEY))
    cachedStartupCaptureUntil = Number.isFinite(value) ? value : 0
    return cachedStartupCaptureUntil
  } catch {
    return 0
  }
}

function refreshStartupCaptureMarker(): void {
  const currentTime = Date.now()
  if (cachedStartupCaptureUntil - currentTime > STARTUP_CAPTURE_TTL_MS / 2) return
  try {
    if (typeof sessionStorage === 'undefined') return
    cachedStartupCaptureUntil = currentTime + STARTUP_CAPTURE_TTL_MS
    sessionStorage.setItem(STARTUP_CAPTURE_KEY, String(cachedStartupCaptureUntil))
  } catch {
    // Storage can be unavailable in sandboxed frames. Live collection still works.
  }
}

function clearStartupCaptureMarker(): void {
  cachedStartupCaptureUntil = 0
  try {
    if (typeof sessionStorage === 'undefined') return
    sessionStorage.removeItem(STARTUP_CAPTURE_KEY)
  } catch {
    // Storage can be unavailable in sandboxed frames.
  }
}

function toWireEvent(event: FigbirdEvent): DevtoolsWireEvent {
  switch (event.kind) {
    case 'fetch:start':
      return event.params === undefined
        ? event
        : { ...event, params: sanitizeDevtoolsPayload(event.params) }
    case 'realtime':
      return event.item === undefined
        ? event
        : { ...event, item: sanitizeDevtoolsPayload(event.item) }
    case 'cache:updated':
      return {
        ...event,
        item: sanitizeDevtoolsPayload(event.item),
        previousItem:
          event.previousItem === null ? null : sanitizeDevtoolsPayload(event.previousItem),
      }
    case 'mutate:start':
    case 'mutate:update':
    case 'action:start':
      return event.args === undefined ? event : { ...event, args: sanitizeDevtoolsArgs(event.args) }
    case 'fetch:error':
    case 'mutate:error':
    case 'action:error':
    case 'connection:error':
      return {
        ...event,
        error: {
          message: event.error.message,
          name: event.error.name,
          details: sanitizeDevtoolsPayload(errorDetails(event.error)),
        },
      }
    case 'connection:reconnect-failed':
      return event.error
        ? {
            ...event,
            error: {
              message: event.error.message,
              name: event.error.name,
              details: sanitizeDevtoolsPayload(errorDetails(event.error)),
            },
          }
        : event
    default:
      return event
  }
}

interface PayloadBudget {
  nodes: number
  stringCharacters: number
}

function sanitizeDevtoolsArgs(args: readonly unknown[]): readonly unknown[] {
  const sanitized = sanitizeDevtoolsPayload(args)
  return Array.isArray(sanitized) ? sanitized : ['[Payload truncated]']
}

function sanitizeDevtoolsPayload(value: unknown): unknown {
  return sanitizePayloadValue(value, 0, new Set<object>(), {
    nodes: PAYLOAD_MAX_NODES,
    stringCharacters: PAYLOAD_MAX_STRING_CHARACTERS,
  })
}

function sanitizePayloadValue(
  value: unknown,
  depth: number,
  ancestors: Set<object>,
  budget: PayloadBudget,
): unknown {
  if (typeof value === 'string') return boundedString(value, budget)
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'undefined'
  ) {
    return value
  }
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'symbol')
    return value.description ? `[Symbol ${value.description}]` : '[Symbol]'
  if (typeof value === 'function') return value.name ? `[Function ${value.name}]` : '[Function]'
  if (depth >= PAYLOAD_MAX_DEPTH) return '[Max depth]'
  if (budget.nodes-- <= 0) return '[Payload truncated]'

  const object = value as object
  const hostDescription = describeHostObject(object)
  if (hostDescription) return hostDescription
  if (object instanceof Error) {
    return {
      message: boundedString(object.message, budget),
      name: boundedString(object.name, budget),
    }
  }
  if (object instanceof Date)
    return Number.isNaN(object.valueOf()) ? '[Invalid Date]' : object.toISOString()
  if (object instanceof RegExp) return String(object)
  if (ancestors.has(object)) return '[Circular]'

  ancestors.add(object)
  try {
    if (Array.isArray(object)) {
      const itemCount = Math.min(object.length, PAYLOAD_MAX_ARRAY_ITEMS)
      const result: unknown[] = []
      for (let index = 0; index < itemCount; index++) {
        result.push(sanitizePayloadValue(object[index], depth + 1, ancestors, budget))
      }
      if (object.length > itemCount) result.push(`[${object.length - itemCount} more items]`)
      return result
    }

    const keys = safeEnumerableKeys(object)
    const propertyCount = Math.min(keys.length, PAYLOAD_MAX_OBJECT_PROPERTIES)
    const result: Record<string, unknown> = {}
    for (let index = 0; index < propertyCount; index++) {
      const key = keys[index]!
      result[key] = sanitizePayloadValue(
        safePropertyValue(object, key),
        depth + 1,
        ancestors,
        budget,
      )
    }
    if (keys.length > propertyCount) {
      result['[truncated]'] = `${keys.length - propertyCount} more properties`
    }
    return result
  } finally {
    ancestors.delete(object)
  }
}

function boundedString(value: string, budget: PayloadBudget): string {
  const retained = Math.min(value.length, Math.max(0, budget.stringCharacters))
  budget.stringCharacters -= retained
  if (retained === value.length) return value
  return `${value.slice(0, retained)}… [${value.length - retained} characters omitted]`
}

function describeHostObject(value: object): string | null {
  const syntheticType = ownDataProperty(value, 'type')
  if (typeof syntheticType === 'string' && ownDataProperty(value, 'nativeEvent') !== undefined) {
    return `[SyntheticEvent ${syntheticType}]`
  }

  let tag: string
  try {
    tag = Object.prototype.toString.call(value).slice(8, -1)
  } catch {
    return '[Uninspectable object]'
  }
  try {
    if (typeof Node !== 'undefined' && value instanceof Node) return `[${tag}]`
    if (typeof Event !== 'undefined' && value instanceof Event) {
      const type = safePropertyValue(value, 'type')
      return typeof type === 'string' ? `[${tag} ${type}]` : `[${tag}]`
    }
  } catch {
    return '[Uninspectable host object]'
  }
  if (tag === 'Window' || tag === 'Document' || tag === 'Node' || tag === 'Text') {
    return `[${tag}]`
  }
  if (tag.endsWith('Element')) return `[${tag}]`
  if (tag.endsWith('Event')) {
    const type = safePropertyValue(value, 'type')
    return typeof type === 'string' ? `[${tag} ${type}]` : `[${tag}]`
  }
  if (
    tag === 'ArrayBuffer' ||
    tag === 'SharedArrayBuffer' ||
    (tag !== 'Array' && tag.endsWith('Array'))
  ) {
    const byteLength = safePropertyValue(value, 'byteLength')
    return typeof byteLength === 'number' ? `[${tag} ${byteLength} bytes]` : `[${tag}]`
  }
  if (tag === 'Blob' || tag === 'File') {
    const size = safePropertyValue(value, 'size')
    const name = tag === 'File' ? safePropertyValue(value, 'name') : undefined
    return `[${tag}${typeof name === 'string' ? ` ${name}` : ''}${typeof size === 'number' ? ` ${size} bytes` : ''}]`
  }
  if (
    tag === 'Map' ||
    tag === 'Set' ||
    tag === 'WeakMap' ||
    tag === 'WeakSet' ||
    tag === 'Promise'
  ) {
    const size = safePropertyValue(value, 'size')
    return `[${tag}${typeof size === 'number' ? `(${size})` : ''}]`
  }
  return null
}

function safeEnumerableKeys(value: object): string[] {
  try {
    return Object.keys(value)
  } catch {
    return []
  }
}

function safePropertyValue(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key]
  } catch (error) {
    return `[Property threw: ${error instanceof Error ? error.message : String(error)}]`
  }
}

function ownDataProperty(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && 'value' in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function serializeWireEnvelope(envelope: DevtoolsWireEnvelope): string {
  const ancestors: object[] = []
  const serialized = JSON.stringify(envelope, function (_key, value: unknown): unknown {
    if (value instanceof Error) return { message: value.message, name: value.name }
    if (typeof value === 'bigint') return String(value)
    if (typeof value !== 'object' || value === null) return value

    while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop()
    if (ancestors.includes(value)) return '[Circular]'
    ancestors.push(value)
    return value
  })
  if (serialized === undefined) throw new Error('Could not serialize the devtools snapshot')
  return serialized
}
