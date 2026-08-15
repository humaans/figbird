import type { FigbirdEvent, FigbirdEvents } from '../../lib/core/events.js'
import type { InspectedQuery } from '../../lib/core/figbird.js'
import type { InFlightMutation, MutationActivity } from '../../lib/core/mutationTracker.js'
import type { InspectedRelationalQuery } from '../../lib/core/relationalQuery.js'
import type { DevtoolsBridgeConnection, DevtoolsWireRead } from '../../lib/core/devtoolsBridge.js'
import type { FigbirdLikeForDevtools } from '../../lib/devtools/collector.js'
import { ExtensionInspectionSession } from './inspection.js'
import { decodeEvent, parseConnection, parseWireRead } from './protocol.js'

const POLL_INTERVAL_MS = 250
const BRIDGE_EXPRESSION = 'globalThis["__FIGBIRD_DEVTOOLS__"]'

type Evaluate = (expression: string) => Promise<unknown>

interface InspectedWindowApi {
  eval(
    expression: string,
    callback: (result: unknown, exceptionInfo?: { isException?: boolean; value?: string }) => void,
  ): void
}

declare const chrome: { devtools: { inspectedWindow: InspectedWindowApi } }

class RemoteFigbird implements FigbirdLikeForDevtools {
  #eventListeners = new Set<(event: FigbirdEvent) => void>()
  #mutatingListeners = new Set<() => void>()
  #mutations: readonly InFlightMutation[] = []
  #pending: DevtoolsWireRead | null = null
  #queries: InspectedQuery[] = []
  #relational: InspectedRelationalQuery[] = []
  #renderFrame: number | null = null
  #stateListeners = new Set<(state: unknown) => void>()
  #taskVersion = 0

  readonly events: FigbirdEvents = {
    subscribe: listener => {
      this.#eventListeners.add(listener)
      return () => this.#eventListeners.delete(listener)
    },
  }

  readonly mutating: MutationActivity = {
    getSnapshot: () => this.#mutations,
    subscribe: listener => {
      this.#mutatingListeners.add(listener)
      return () => this.#mutatingListeners.delete(listener)
    },
  }

  inspect(): InspectedQuery[] {
    return this.#queries
  }

  inspectRelational(): InspectedRelationalQuery[] {
    return this.#relational
  }

  subscribeToStateChanges(listener: (state: unknown) => void): () => void {
    this.#stateListeners.add(listener)
    return () => this.#stateListeners.delete(listener)
  }

  update(read: DevtoolsWireRead): void {
    this.#pending = this.#pending
      ? {
          ...read,
          events: [...this.#pending.events, ...read.events],
        }
      : read
    if (this.#renderFrame !== null) return
    if (typeof requestAnimationFrame === 'function') {
      this.#renderFrame = requestAnimationFrame(() => {
        this.#renderFrame = null
        this.#flush()
      })
      return
    }
    const taskVersion = ++this.#taskVersion
    queueMicrotask(() => {
      if (taskVersion === this.#taskVersion) this.#flush()
    })
  }

  cancelPending(): void {
    this.#taskVersion++
    this.#pending = null
    if (this.#renderFrame !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.#renderFrame)
    }
    this.#renderFrame = null
  }

  reset(): void {
    this.cancelPending()
    this.#queries = []
    this.#relational = []
    this.#mutations = []
    for (const listener of this.#stateListeners) listener(undefined)
    for (const listener of this.#mutatingListeners) listener()
  }

  #flush(): void {
    const read = this.#pending
    this.#pending = null
    if (!read) return
    this.#queries = read.queries.map(query => ({
      ...query,
      fetchedAt: query.fetchedAt,
      query: query.query,
    }))
    this.#relational = read.relational
    this.#mutations = read.inFlightMutations
    for (const event of read.events) {
      const decoded = decodeEvent(event)
      for (const listener of this.#eventListeners) listener(decoded)
    }
    for (const listener of this.#stateListeners) listener(undefined)
    for (const listener of this.#mutatingListeners) listener()
  }
}

export class ExtensionSession {
  readonly figbird = new RemoteFigbird()
  readonly inspection: ExtensionInspectionSession

  #connection: DevtoolsBridgeConnection | null = null
  #evaluate: Evaluate
  #generation = 0
  #polling = false
  #status = 'Waiting for Figbird'
  #statusListeners = new Set<() => void>()
  #timer: ReturnType<typeof setInterval> | null = null
  #version: number | null = null
  #resetListeners = new Set<() => void>()

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

  start(): void {
    if (this.#timer) return
    const generation = ++this.#generation
    void this.#poll(generation)
    this.#timer = setInterval(() => void this.#poll(generation), POLL_INTERVAL_MS)
  }

  stop(): void {
    this.#generation++
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    this.#version = null
    this.figbird.cancelPending()
    this.inspection.stop()
    const sessionId = this.#connection?.sessionId
    this.#connection = null
    if (sessionId) void this.#disconnect(sessionId)
  }

  async #poll(generation: number): Promise<void> {
    if (this.#polling) return
    this.#polling = true
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
        this.#connection = connection
        this.#setStatus(
          connection.instanceCount > 1
            ? `Connected · instance ${connection.instanceId} of ${connection.instanceCount}`
            : 'Connected',
        )
      }

      const sessionId = JSON.stringify(this.#connection.sessionId)
      const poll = parseWireRead(
        await this.#evaluate(`${BRIDGE_EXPRESSION}?.readJson(${sessionId},${this.#version})`),
      )
      if (generation !== this.#generation) return
      if (!poll) {
        this.#resetConnection()
        this.inspection.reset()
        this.#setStatus('Reconnecting')
        return
      }
      this.#version = poll.version
      if (poll.read) this.figbird.update(poll.read)
      await this.inspection.refresh()
    } catch {
      if (generation !== this.#generation) return
      this.#resetConnection()
      this.inspection.reset()
      this.#setStatus('Cannot inspect this page')
    } finally {
      this.#polling = false
    }
  }

  #resetConnection(): void {
    const hadConnection = this.#connection !== null || this.#version !== null
    this.#connection = null
    this.#version = null
    if (!hadConnection) return
    this.figbird.reset()
    for (const listener of this.#resetListeners) listener()
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
