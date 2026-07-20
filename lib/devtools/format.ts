export function compactJson(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value !== null && typeof value === 'object' && Object.keys(value).length === 0) return '{}'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return '[unserializable]'
  }
}

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return '[unserializable value]'
  }
}

export function formatMs(ms: number): string {
  return `${Math.round(ms)}ms`
}

export function formatAge(ms: number): string {
  if (ms < 1_000) return 'now'
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 3_600_000)}h`
}

export function now(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

export function pad2(value: number): string {
  return value.toString().padStart(2, '0')
}

export function pad3(value: number): string {
  return value.toString().padStart(3, '0')
}
