import type { FigbirdEvent } from '../../lib/core/events.js'
import type {
  DevtoolsBridgeConnection,
  DevtoolsWireEvent,
  DevtoolsWireRead,
} from '../../lib/core/devtoolsBridge.js'

interface WireEnvelopeShape {
  protocol: 2
  version: number
  read: {
    cache?: unknown[]
    events: unknown[]
    inFlightMutations: unknown[]
    queries: unknown[]
    relational: unknown[]
  } | null
}

export interface ParsedWireRead {
  read: DevtoolsWireRead | null
  version: number
}

export function parseConnection(value: unknown): DevtoolsBridgeConnection | null {
  if (value === null || value === undefined) return null
  if (
    !isRecord(value) ||
    value.protocol !== 2 ||
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

export function parseWireRead(value: unknown): ParsedWireRead | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error('Figbird returned an invalid devtools snapshot')

  const envelope: unknown = JSON.parse(value)
  if (!isWireEnvelope(envelope)) throw new Error('Figbird returned an invalid devtools snapshot')

  // Protocol 2 defines the collection item shapes. The envelope check guards the
  // transport boundary without duplicating every domain type in the extension.
  return {
    read: envelope.read
      ? ({ ...envelope.read, cache: envelope.read.cache ?? [] } as unknown as DevtoolsWireRead)
      : null,
    version: envelope.version,
  }
}

export function decodeEvent(event: DevtoolsWireEvent): FigbirdEvent {
  switch (event.kind) {
    case 'fetch:error':
    case 'mutate:error':
    case 'action:error':
    case 'connection:error': {
      const error = new Error(event.error.message)
      error.name = event.error.name
      return { ...event, error }
    }
    case 'connection:reconnect-failed': {
      if (!event.error) return event
      const error = new Error(event.error.message)
      error.name = event.error.name
      return { ...event, error }
    }
    default:
      return event
  }
}

function isWireEnvelope(value: unknown): value is WireEnvelopeShape {
  if (!isRecord(value) || value.protocol !== 2 || typeof value.version !== 'number') return false
  if (value.read === null) return true
  if (!isRecord(value.read)) return false
  const read = value.read
  return (
    Array.isArray(read.events) &&
    Array.isArray(read.inFlightMutations) &&
    Array.isArray(read.queries) &&
    Array.isArray(read.relational)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
