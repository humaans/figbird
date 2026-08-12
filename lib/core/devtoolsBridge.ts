import type { FigbirdEvent, FigbirdEvents } from './events.js'
import type { InspectedQuery } from './figbird.js'
import type { InspectedRelationalQuery } from './relationalQuery.js'
import type { InFlightMutation, MutationActivity } from './mutationTracker.js'
import { CappedBuffer } from './cappedBuffer.js'

const BRIDGE_KEY = '__FIGBIRD_DEVTOOLS__'
const SESSION_TIMEOUT_MS = 5_000
const EVENT_LIMIT = 1_000

interface DevtoolsSource {
  events: FigbirdEvents
  mutating: MutationActivity
  inspect(): InspectedQuery[]
  inspectRelational(): InspectedRelationalQuery[]
  subscribeToStateChanges(fn: (state: unknown) => void): () => void
}

export interface DevtoolsWireError {
  message: string
  name: string
}

type ToWireEvent<E> = E extends { error: Error }
  ? Omit<E, 'error'> & { error: DevtoolsWireError }
  : E

export type DevtoolsWireEvent = ToWireEvent<FigbirdEvent>

export type DevtoolsWireQuery = Omit<InspectedQuery, 'fetchedAt' | 'query'> & {
  fetchedAt?: number | undefined
  query?: Record<string, unknown> | undefined
}

export interface DevtoolsBridgeConnection {
  instanceCount: number
  instanceId: number
  protocol: 2
  sessionId: string
}

export interface DevtoolsWireRead {
  events: DevtoolsWireEvent[]
  inFlightMutations: readonly InFlightMutation[]
  queries: DevtoolsWireQuery[]
  relational: InspectedRelationalQuery[]
}

export interface DevtoolsWireEnvelope {
  protocol: 2
  version: number
  read: DevtoolsWireRead | null
}

interface DevtoolsBridgeSession {
  events: CappedBuffer<FigbirdEvent>
  expires: ReturnType<typeof setTimeout> | null
  source: DevtoolsSource
  unsubscribe: () => void
  version: number
}

interface DevtoolsPageBridge {
  protocol: 2
  connect(instanceId?: number): DevtoolsBridgeConnection | null
  disconnect(sessionId: string): void
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
    value.protocol === 2 &&
    'register' in value &&
    typeof value.register === 'function' &&
    'connect' in value &&
    typeof value.connect === 'function' &&
    'readJson' in value &&
    typeof value.readJson === 'function'
  )
}

function createPageBridge(): DevtoolsPageBridge {
  const instances = new Map<number, WeakRef<DevtoolsSource>>()
  const sessions = new Map<string, DevtoolsBridgeSession>()
  let nextInstanceId = 1
  let nextSessionId = 1

  const closeSession = (sessionId: string) => {
    const session = sessions.get(sessionId)
    if (!session) return
    if (session.expires) clearTimeout(session.expires)
    session.unsubscribe()
    sessions.delete(sessionId)
  }

  const refreshExpiry = (sessionId: string, session: DevtoolsBridgeSession) => {
    if (session.expires) clearTimeout(session.expires)
    session.expires = setTimeout(() => closeSession(sessionId), SESSION_TIMEOUT_MS)
  }

  return {
    protocol: 2,

    register(source) {
      instances.set(nextInstanceId++, new WeakRef(source))
    },

    connect(instanceId) {
      removeCollectedInstances(instances)
      const instance = resolveInstance(instances, instanceId)
      if (!instance) return null
      const [resolvedId, source] = instance
      const sessionId = `${Date.now().toString(36)}-${nextSessionId++}`
      const session: DevtoolsBridgeSession = {
        events: new CappedBuffer(EVENT_LIMIT),
        expires: null,
        source,
        unsubscribe: () => {},
        version: 1,
      }
      const unsubscribers = [
        source.events.subscribe(event => {
          session.events.push(event)
          session.version++
        }),
        source.mutating.subscribe(() => session.version++),
        source.subscribeToStateChanges(() => session.version++),
      ]
      session.unsubscribe = () => {
        for (const unsubscribe of unsubscribers) unsubscribe()
      }
      sessions.set(sessionId, session)
      refreshExpiry(sessionId, session)
      return {
        instanceCount: instances.size,
        instanceId: resolvedId,
        protocol: 2,
        sessionId,
      }
    },

    disconnect(sessionId) {
      closeSession(sessionId)
    },

    readJson(sessionId, version) {
      const session = sessions.get(sessionId)
      if (!session) return null
      refreshExpiry(sessionId, session)
      if (version === session.version) {
        return `{"protocol":2,"version":${session.version},"read":null}`
      }
      return serializeWireEnvelope({
        protocol: 2,
        version: session.version,
        read: {
          events: session.events.drain().map(toWireEvent),
          inFlightMutations: session.source.mutating.getSnapshot(),
          queries: session.source.inspect(),
          relational: session.source.inspectRelational(),
        },
      })
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

function removeCollectedInstances(instances: Map<number, WeakRef<DevtoolsSource>>): void {
  for (const [id, reference] of instances) {
    if (!reference.deref()) instances.delete(id)
  }
}

function toWireEvent(event: FigbirdEvent): DevtoolsWireEvent {
  switch (event.kind) {
    case 'fetch:error':
    case 'mutate:error':
    case 'action:error':
      return {
        ...event,
        error: { message: event.error.message, name: event.error.name },
      }
    default:
      return event
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
