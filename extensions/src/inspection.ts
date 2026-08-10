import type {
  DevtoolsInspectionController,
  DevtoolsInspectionSnapshot,
} from '../../lib/devtools/Devtools.js'
import { PICKER_KEY, PICKER_PROTOCOL, type PickerWireSnapshot } from './pickerProtocol.js'

const PICKER_EXPRESSION = `globalThis[${JSON.stringify(PICKER_KEY)}]`

interface RuntimeApi {
  getURL(path: string): string
}

declare const chrome: { runtime: RuntimeApi }

let pickerSourcePromise: Promise<string> | null = null

type WithoutVersion<T> = T extends { version: number } ? Omit<T, 'version'> : never
type InspectionSnapshotUpdate = WithoutVersion<DevtoolsInspectionSnapshot>

export class ExtensionInspectionSession implements DevtoolsInspectionController {
  #command = 0
  #evaluate: (expression: string) => Promise<unknown>
  #isAvailable: () => boolean
  #listeners = new Set<() => void>()
  #pageVersion: number | null = null
  #snapshot: DevtoolsInspectionSnapshot = { kind: 'idle', version: 0 }
  #starting: Promise<void> | null = null

  constructor(
    evaluate: (expression: string) => Promise<unknown>,
    isAvailable: () => boolean = () => true,
  ) {
    this.#evaluate = evaluate
    this.#isAvailable = isAvailable
  }

  getSnapshot = (): DevtoolsInspectionSnapshot => this.#snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  start = (): void => {
    if (!this.#isAvailable()) return
    const command = ++this.#command
    this.#setSnapshot({ kind: 'picking' })
    const starting = this.#start(command)
    this.#starting = starting
    void starting.then(() => {
      if (this.#starting === starting) this.#starting = null
    })
  }

  stop = (): void => {
    this.reset()
    void this.#evaluate(`${PICKER_EXPRESSION}?.stop()`).catch(() => {})
  }

  isPicking(): boolean {
    return this.#snapshot.kind === 'picking'
  }

  async refresh(): Promise<void> {
    while (this.#starting) await this.#starting
    if (!this.isPicking()) return
    const command = this.#command
    try {
      const snapshot = parsePickerSnapshot(await this.#evaluate(`${PICKER_EXPRESSION}?.read()`))
      if (command !== this.#command) return
      if (snapshot) this.#apply(snapshot)
      else this.reset()
    } catch {
      if (command === this.#command) this.reset()
    }
  }

  reset(): void {
    this.#command++
    this.#pageVersion = null
    if (this.#snapshot.kind !== 'idle') this.#setSnapshot({ kind: 'idle' })
  }

  async #start(command: number): Promise<void> {
    try {
      await this.#ensurePicker()
      if (command !== this.#command) return
      const snapshot = parsePickerSnapshot(
        await this.#evaluate(`${PICKER_EXPRESSION}.start('#1d65d8')`),
      )
      if (command === this.#command && snapshot) this.#apply(snapshot)
    } catch {
      if (command === this.#command) this.reset()
    }
  }

  async #ensurePicker(): Promise<void> {
    const protocol = await this.#evaluate(`${PICKER_EXPRESSION}?.protocol`)
    if (protocol === PICKER_PROTOCOL) return
    await this.#evaluate(await loadPickerSource())
    if ((await this.#evaluate(`${PICKER_EXPRESSION}?.protocol`)) !== PICKER_PROTOCOL) {
      throw new Error('Could not install the Figbird element picker')
    }
  }

  #apply(snapshot: PickerWireSnapshot): void {
    if (snapshot.version === this.#pageVersion) return
    this.#pageVersion = snapshot.version
    switch (snapshot.kind) {
      case 'idle':
        this.#setSnapshot({ kind: 'idle' })
        break
      case 'picking':
        this.#setSnapshot({ kind: 'picking' })
        break
      case 'selected':
        this.#setSnapshot({
          kind: 'selected',
          label: snapshot.label,
          queryCounts: new Map(Object.entries(snapshot.queryCounts)),
          supported: snapshot.supported,
          truncated: snapshot.truncated,
        })
        break
    }
  }

  #setSnapshot(snapshot: InspectionSnapshotUpdate): void {
    const version = this.#snapshot.version + 1
    this.#snapshot =
      snapshot.kind === 'selected' ? { ...snapshot, version } : { kind: snapshot.kind, version }
    for (const listener of this.#listeners) listener()
  }
}

async function loadPickerSource(): Promise<string> {
  pickerSourcePromise ??= fetch(chrome.runtime.getURL('picker.js')).then(async response => {
    if (!response.ok) throw new Error(`Could not load the Figbird picker: ${response.status}`)
    return response.text()
  })
  try {
    return await pickerSourcePromise
  } catch (error) {
    pickerSourcePromise = null
    throw error
  }
}

function parsePickerSnapshot(value: unknown): PickerWireSnapshot | null {
  if (!isRecord(value) || typeof value.version !== 'number') return null
  switch (value.kind) {
    case 'idle':
      return { kind: value.kind, version: value.version }
    case 'picking':
      return { kind: value.kind, version: value.version }
    case 'selected':
      if (
        typeof value.label !== 'string' ||
        !isNumberRecord(value.queryCounts) ||
        typeof value.supported !== 'boolean' ||
        typeof value.truncated !== 'boolean'
      ) {
        return null
      }
      return {
        kind: value.kind,
        label: value.label,
        queryCounts: value.queryCounts,
        supported: value.supported,
        truncated: value.truncated,
        version: value.version,
      }
    default:
      return null
  }
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every(item => typeof item === 'number')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
