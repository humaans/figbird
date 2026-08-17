import type { DevtoolsBridgeConnection, DevtoolsWireRead } from '../../lib/core/devtoolsBridge.js'
import type { RemoteCollectorFrame } from '../../lib/devtools/collector.js'
import { ExtensionInspectionSession } from './inspection.js'
import { decodeEvent, parseConnection, parseWireRead } from './protocol.js'

const ACTIVE_POLL_INTERVAL_MS = 250
const IDLE_POLL_INTERVAL_MS = 1_000
const BRIDGE_EXPRESSION = 'globalThis["__FIGBIRD_DEVTOOLS__"]'

type Evaluate = (expression: string) => Promise<unknown>

interface InspectedWindowApi {
  eval(
    expression: string,
    callback: (result: unknown, exceptionInfo?: { isException?: boolean; value?: string }) => void,
  ): void
}

declare const chrome: { devtools: { inspectedWindow: InspectedWindowApi } }

export class ExtensionSession {
  readonly inspection: ExtensionInspectionSession

  #connection: DevtoolsBridgeConnection | null = null
  #evaluate: Evaluate
  #generation = 0
  #instanceId: number | null = null
  #polling = false
  #running = false
  #status = 'Waiting for Figbird'
  #statusListeners = new Set<() => void>()
  #timer: ReturnType<typeof setInterval> | null = null
  #version: number | null = null
  #resetListeners = new Set<() => void>()
  #readListeners = new Set<(frame: RemoteCollectorFrame) => void>()

  constructor(evaluate: Evaluate = evaluateInspectedWindow) {
    this.#evaluate = evaluate
    this.inspection = new ExtensionInspectionSession(evaluate, () => this.#connection !== null)
  }

  getStatus = (): string => this.#status

  subscribeStatus = (listener: () => void): (() => void) => {
    this.#statusListeners.add(listener)
    return () => this.#statusListeners.delete(listener)
  }

  subscribeReset = (listener: () => void): (() => void) => {
    this.#resetListeners.add(listener)
    return () => this.#resetListeners.delete(listener)
  }

  subscribeRead = (listener: (frame: RemoteCollectorFrame) => void): (() => void) => {
    this.#readListeners.add(listener)
    return () => this.#readListeners.delete(listener)
  }

  editCacheEntity = async (
    serviceName: string,
    itemId: string | number,
    item: unknown,
  ): Promise<{ ok: boolean; error?: string; traceId?: number }> => {
    try {
      const sessionId = this.#connection?.sessionId
      if (!sessionId) return { ok: false, error: 'Figbird is not connected' }
      const expression = `${BRIDGE_EXPRESSION}?.editCacheEntityJson(${JSON.stringify(sessionId)},${JSON.stringify(serviceName)},${JSON.stringify(JSON.stringify(itemId))},${JSON.stringify(JSON.stringify(item))})`
      const value = await this.#evaluate(expression)
      if (typeof value !== 'string') return { ok: false, error: 'Invalid cache edit response' }
      const parsed: unknown = JSON.parse(value)
      if (!isCacheEditResult(parsed)) return { ok: false, error: 'Invalid cache edit response' }
      return parsed
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    const generation = ++this.#generation
    if (this.#polling) {
      this.#schedulePoll(generation, ACTIVE_POLL_INTERVAL_MS)
      return
    }
    void this.#poll(generation)
  }

  stop(): void {
    this.#running = false
    this.#generation++
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    this.#version = null
    this.inspection.stop()
    const sessionId = this.#connection?.sessionId
    this.#connection = null
    if (sessionId) void this.#disconnect(sessionId)
  }

  resetForNavigation(): void {
    const restart = this.#running
    this.stop()
    this.#instanceId = null
    this.inspection.reset()
    for (const listener of this.#resetListeners) listener()
    if (restart) this.start()
  }

  async #poll(generation: number): Promise<void> {
    if (this.#polling) {
      if (generation === this.#generation) this.#schedulePoll(generation, ACTIVE_POLL_INTERVAL_MS)
      return
    }
    this.#polling = true
    let nextDelay = IDLE_POLL_INTERVAL_MS
    try {
      if (!this.#connection) {
        const connection = parseConnection(await this.#evaluate(`${BRIDGE_EXPRESSION}?.connect()`))
        if (generation !== this.#generation) {
          if (connection) await this.#disconnect(connection.sessionId)
          return
        }
        if (!connection) {
          this.#setStatus('Waiting for Figbird')
          return
        }
        if (this.#instanceId !== null && connection.instanceId !== this.#instanceId) {
          this.inspection.reset()
          for (const listener of this.#resetListeners) listener()
        }
        this.#instanceId = connection.instanceId
        this.#connection = connection
        this.#setConnectedStatus(connection)
      }

      const sessionId = JSON.stringify(this.#connection.sessionId)
      const poll = parseWireRead(
        await this.#evaluate(`${BRIDGE_EXPRESSION}?.readJson(${sessionId},${this.#version})`),
      )
      if (generation !== this.#generation) return
      if (!poll) {
        this.#dropConnection()
        this.inspection.reset()
        this.#setStatus('Reconnecting')
        return
      }
      this.#version = poll.version
      this.#setConnectedStatus(this.#connection)
      if (poll.read) {
        nextDelay = ACTIVE_POLL_INTERVAL_MS
        this.#publishRead(poll.read)
      }
      await this.inspection.refresh()
    } catch {
      if (generation !== this.#generation) return
      this.inspection.reset()
      this.#setStatus('Cannot inspect this page')
    } finally {
      this.#polling = false
      if (generation === this.#generation) this.#schedulePoll(generation, nextDelay)
    }
  }

  #schedulePoll(generation: number, delay: number): void {
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.#poll(generation)
    }, delay)
  }

  #dropConnection(): void {
    this.#connection = null
    this.#version = null
  }

  #setConnectedStatus(connection: DevtoolsBridgeConnection): void {
    this.#setStatus(
      connection.instanceCount > 1
        ? `Connected · instance ${connection.instanceId} of ${connection.instanceCount}`
        : 'Connected',
    )
  }

  async #disconnect(sessionId: string): Promise<void> {
    await this.#evaluate(`${BRIDGE_EXPRESSION}?.disconnect(${JSON.stringify(sessionId)})`).catch(
      () => {},
    )
  }

  #setStatus(status: string): void {
    if (status === this.#status) return
    this.#status = status
    for (const listener of this.#statusListeners) listener()
  }

  #publishRead(read: DevtoolsWireRead): void {
    const frame: RemoteCollectorFrame = {
      events: read.events.map(decodeEvent),
      ...(read.queries
        ? {
            queries: read.queries.map(query => ({
              ...query,
              fetchedAt: query.fetchedAt,
              query: query.query ?? {},
            })),
          }
        : {}),
      ...(read.cache ? { cache: read.cache } : {}),
      ...(read.relational ? { relational: read.relational } : {}),
    }
    for (const listener of this.#readListeners) listener(frame)
  }
}

function isCacheEditResult(
  value: unknown,
): value is { ok: boolean; error?: string; traceId?: number } {
  if (typeof value !== 'object' || value === null || !('ok' in value)) return false
  if (typeof value.ok !== 'boolean') return false
  if ('error' in value && value.error !== undefined && typeof value.error !== 'string') return false
  return !('traceId' in value) || value.traceId === undefined || typeof value.traceId === 'number'
}

function evaluateInspectedWindow(expression: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(expression, (result, exceptionInfo) => {
      if (exceptionInfo?.isException) {
        reject(new Error(exceptionInfo.value ?? 'Evaluation failed'))
      } else {
        resolve(result)
      }
    })
  })
}
