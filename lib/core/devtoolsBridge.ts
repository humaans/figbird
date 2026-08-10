import { installElementPicker } from './devtoolsInspection.js'
import type { FigbirdEvent, FigbirdEvents } from './events.js'
import type { InspectedQuery } from './figbird.js'
import type { InspectedRelationalQuery } from './relationalQuery.js'
import type { InFlightMutation, MutationActivity } from './mutationTracker.js'

const BRIDGE_KEY = '__FIGBIRD_DEVTOOLS__'
const SESSION_TIMEOUT_MS = 5_000
const EVENT_LIMIT = 1_000

interface DevtoolsSource {
  events: FigbirdEvents
  mutating: MutationActivity
  inspect(): InspectedQuery[]
  inspectRelational(): InspectedRelationalQuery[]
}

export interface DevtoolsWireError {
  message: string
  name: string
}

type ToWireEvent<E> = E extends { error: Error }
  ? Omit<E, 'error'> & { error: DevtoolsWireError }
  : E

export type DevtoolsWireEvent = ToWireEvent<FigbirdEvent>

export interface DevtoolsWireInspection {
  active: boolean
  label?: string
  queryCounts?: Record<string, number>
  supported?: boolean
  truncated?: boolean
  version: number
}

export type DevtoolsWireQuery = Omit<InspectedQuery, 'fetchedAt' | 'query'> & {
  fetchedAt?: number | undefined
  query?: Record<string, unknown> | undefined
}

export interface DevtoolsBridgeConnection {
  instanceCount: number
  instanceId: number
  protocol: 1
  sessionId: string
}

export interface DevtoolsWireRead {
  events: DevtoolsWireEvent[]
  inFlightMutations: readonly InFlightMutation[]
  inspection: DevtoolsWireInspection
  queries: DevtoolsWireQuery[]
  relational: InspectedRelationalQuery[]
}

interface DevtoolsBridgeSession {
  events: FigbirdEvent[]
  expires: ReturnType<typeof setTimeout> | null
  inspection: DevtoolsWireInspection
  pickerCleanup: (() => void) | null
  source: DevtoolsSource
  unsubscribe: () => void
}

interface DevtoolsPageBridge {
  protocol: 1
  connect(instanceId?: number): DevtoolsBridgeConnection | null
  disconnect(sessionId: string): void
  readJson(sessionId: string): string | null
  register(source: DevtoolsSource): void
  startInspecting(sessionId: string, accent?: string): boolean
  stopInspecting(sessionId: string): void
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
    value.protocol === 1 &&
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
    session.pickerCleanup?.()
    session.unsubscribe()
    sessions.delete(sessionId)
  }

  const refreshExpiry = (sessionId: string, session: DevtoolsBridgeSession) => {
    if (session.expires) clearTimeout(session.expires)
    session.expires = setTimeout(() => closeSession(sessionId), SESSION_TIMEOUT_MS)
  }

  return {
    protocol: 1,

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
        events: [],
        expires: null,
        inspection: { active: false, version: 0 },
        pickerCleanup: null,
        source,
        unsubscribe: () => {},
      }
      session.unsubscribe = source.events.subscribe(event => {
        session.events.push(event)
        if (session.events.length > EVENT_LIMIT) {
          session.events.splice(0, session.events.length - EVENT_LIMIT)
        }
      })
      sessions.set(sessionId, session)
      refreshExpiry(sessionId, session)
      return {
        instanceCount: instances.size,
        instanceId: resolvedId,
        protocol: 1,
        sessionId,
      }
    },

    disconnect(sessionId) {
      closeSession(sessionId)
    },

    readJson(sessionId) {
      const session = sessions.get(sessionId)
      if (!session) return null
      refreshExpiry(sessionId, session)
      const read: DevtoolsWireRead = {
        events: session.events.splice(0).map(toWireEvent),
        inFlightMutations: session.source.mutating.getSnapshot(),
        inspection: session.inspection,
        queries: session.source.inspect(),
        relational: session.source.inspectRelational(),
      }
      return serializeWireRead(read)
    },

    startInspecting(sessionId, accent = '#1d65d8') {
      const session = sessions.get(sessionId)
      if (!session) return false
      session.pickerCleanup?.()
      session.inspection = { active: true, version: session.inspection.version + 1 }
      session.pickerCleanup = installElementPicker(accent, result => {
        session.pickerCleanup = null
        session.inspection = result
          ? {
              active: false,
              label: result.label,
              queryCounts: Object.fromEntries(result.queryCounts),
              supported: result.supported,
              truncated: result.truncated,
              version: session.inspection.version + 1,
            }
          : { active: false, version: session.inspection.version + 1 }
      })
      return true
    },

    stopInspecting(sessionId) {
      const session = sessions.get(sessionId)
      if (!session) return
      session.pickerCleanup?.()
      session.pickerCleanup = null
      session.inspection = { active: false, version: session.inspection.version + 1 }
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

function serializeWireRead(read: DevtoolsWireRead): string {
  const ancestors: object[] = []
  const serialized = JSON.stringify(read, function (_key, value: unknown): unknown {
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
