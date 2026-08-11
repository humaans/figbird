import { installElementPicker } from './inspectionPage.js'
import { PICKER_KEY, PICKER_PROTOCOL, type PickerWireSnapshot } from './pickerProtocol.js'

const PICKER_TIMEOUT_MS = 5_000

interface PagePicker {
  protocol: typeof PICKER_PROTOCOL
  read(): PickerWireSnapshot
  start(accent?: string): PickerWireSnapshot
  stop(): PickerWireSnapshot
}

installPagePicker()

function installPagePicker(): void {
  const globalRecord = globalThis as typeof globalThis & Record<string, unknown>
  if (isPagePicker(globalRecord[PICKER_KEY])) return

  let cleanup: (() => void) | null = null
  let expires: ReturnType<typeof setTimeout> | null = null
  let snapshot: PickerWireSnapshot = { kind: 'idle', version: 0 }

  const clearExpiry = () => {
    if (expires) clearTimeout(expires)
    expires = null
  }
  const stop = (): PickerWireSnapshot => {
    cleanup?.()
    cleanup = null
    clearExpiry()
    snapshot = { kind: 'idle', version: snapshot.version + 1 }
    return snapshot
  }
  const refreshExpiry = () => {
    clearExpiry()
    expires = setTimeout(stop, PICKER_TIMEOUT_MS)
  }

  const picker: PagePicker = {
    protocol: PICKER_PROTOCOL,
    read() {
      if (snapshot.kind === 'picking') refreshExpiry()
      return snapshot
    },
    start(accent = '#1d65d8') {
      cleanup?.()
      clearExpiry()
      snapshot = { kind: 'picking', version: snapshot.version + 1 }
      cleanup = installElementPicker(accent, result => {
        cleanup = null
        clearExpiry()
        snapshot = result
          ? {
              kind: 'selected',
              label: result.label,
              queryCounts: Object.fromEntries(result.queryCounts),
              supported: result.supported,
              truncated: result.truncated,
              version: snapshot.version + 1,
            }
          : { kind: 'idle', version: snapshot.version + 1 }
      })
      refreshExpiry()
      return snapshot
    },
    stop,
  }

  Object.defineProperty(globalRecord, PICKER_KEY, {
    configurable: true,
    enumerable: false,
    value: picker,
  })
}

function isPagePicker(value: unknown): value is PagePicker {
  return (
    typeof value === 'object' &&
    value !== null &&
    'protocol' in value &&
    value.protocol === PICKER_PROTOCOL &&
    'read' in value &&
    typeof value.read === 'function' &&
    'start' in value &&
    typeof value.start === 'function' &&
    'stop' in value &&
    typeof value.stop === 'function'
  )
}
