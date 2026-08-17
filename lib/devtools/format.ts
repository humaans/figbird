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

export function estimateSerializedBytes(value: unknown): number | null {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    return null
  }
  if (serialized === undefined) return null

  let bytes = 0
  for (const character of serialized) {
    const codePoint = character.codePointAt(0)!
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
  }
  return bytes
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_048_576) return `${formatByteUnit(bytes / 1_024)} KB`
  return `${formatByteUnit(bytes / 1_048_576)} MB`
}

function formatByteUnit(value: number): string {
  return value < 10 ? value.toFixed(1) : Math.round(value).toString()
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

export function formatClock(
  wallAt: number,
  { milliseconds = false }: { milliseconds?: boolean } = {},
): string {
  const date = new Date(wallAt)
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  return milliseconds ? `${time}.${pad3(date.getMilliseconds())}` : time
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0')
}

function pad3(value: number): string {
  return value.toString().padStart(3, '0')
}
