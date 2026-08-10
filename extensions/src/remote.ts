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
  #queries: InspectedQuery[] = []
  #relational: InspectedRelationalQuery[] = []
  #stateListeners = new Set<(state: unknown) => void>()

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
  readonly inspection = new ExtensionInspectionSession(evaluate, () => this.#connection !== null)

  #connection: DevtoolsBridgeConnection | null = null
  #polling = false
  #status = 'Waiting for Figbird'
  #statusListeners = new Set<() => void>()
  #timer: ReturnType<typeof setInterval> | null = null

  getStatus = (): string => this.#status

  subscribeStatus = (listener: () => void): (() => void) => {
    this.#statusListeners.add(listener)
    return () => this.#statusListeners.delete(listener)
  }

  start(): void {
    if (this.#timer) return
    void this.#poll()
    this.#timer = setInterval(() => void this.#poll(), POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    this.inspection.stop()
    const sessionId = this.#connection?.sessionId
    this.#connection = null
    if (sessionId) void evaluate(`${BRIDGE_EXPRESSION}?.disconnect(${JSON.stringify(sessionId)})`)
  }

  async #poll(): Promise<void> {
    if (this.#polling) return
    this.#polling = true
    try {
      if (!this.#connection) {
        const connection = parseConnection(await evaluate(`${BRIDGE_EXPRESSION}?.connect()`))
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

      const read = parseWireRead(
        await evaluate(
          `${BRIDGE_EXPRESSION}?.readJson(${JSON.stringify(this.#connection.sessionId)})`,
        ),
      )
      if (!read) {
        this.#connection = null
        this.inspection.reset()
        this.#setStatus('Reconnecting')
        return
      }
      this.figbird.update(read)
      await this.inspection.refresh()
    } catch {
      this.#connection = null
      this.inspection.reset()
      this.#setStatus('Cannot inspect this page')
    } finally {
      this.#polling = false
    }
  }

  #setStatus(status: string): void {
    if (status === this.#status) return
    this.#status = status
    for (const listener of this.#statusListeners) listener()
  }
}

function evaluate(expression: string): Promise<unknown> {
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
