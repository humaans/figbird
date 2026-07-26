const STORAGE_KEY = 'figbird:devtools:enabled'

export type DevtoolsPreference = boolean | undefined

/**
 * Persistent availability gate for the optional React devtools UI.
 *
 * The controller lives in core so an app can unlock production devtools without
 * importing React. It does not load or render the devtools package by itself.
 */
export class DevtoolsControl {
  #preference: DevtoolsPreference
  #listeners = new Set<() => void>()
  #listeningForStorage = false

  constructor() {
    this.#preference = readPreference()
  }

  enable(): void {
    this.#setPreference(true)
  }

  disable(): void {
    this.#setPreference(false)
  }

  getSnapshot = (): DevtoolsPreference => this.#preference

  subscribe = (listener: () => void): (() => void) => {
    if (this.#listeners.size === 0) {
      this.#syncPreference()
      this.#startStorageListener()
    }
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
      if (this.#listeners.size === 0) this.#stopStorageListener()
    }
  }

  #setPreference(preference: boolean): void {
    writePreference(preference)
    if (this.#preference === preference) return
    this.#preference = preference
    this.#emit()
  }

  #syncPreference(): void {
    this.#preference = readPreference()
  }

  #onStorage = (event: StorageEvent): void => {
    if (event.key !== STORAGE_KEY) return
    const preference = parsePreference(event.newValue)
    if (preference === this.#preference) return
    this.#preference = preference
    this.#emit()
  }

  #startStorageListener(): void {
    if (this.#listeningForStorage || typeof window === 'undefined') return
    window.addEventListener('storage', this.#onStorage)
    this.#listeningForStorage = true
  }

  #stopStorageListener(): void {
    if (!this.#listeningForStorage || typeof window === 'undefined') return
    window.removeEventListener('storage', this.#onStorage)
    this.#listeningForStorage = false
  }

  #emit(): void {
    for (const listener of this.#listeners) listener()
  }
}

function readPreference(): DevtoolsPreference {
  try {
    if (typeof window === 'undefined') return undefined
    return parsePreference(window.localStorage.getItem(STORAGE_KEY))
  } catch {
    return undefined
  }
}

function writePreference(preference: boolean): void {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(STORAGE_KEY, String(preference))
  } catch {
    // The in-memory preference still works when storage is blocked.
  }
}

function parsePreference(value: string | null): DevtoolsPreference {
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}
