import { queryKeysForSubscription } from '../react/devtoolsQueryMarker.js'

interface FiberLike {
  alternate?: FiberLike | null
  child?: FiberLike | null
  memoizedState?: unknown
  return?: FiberLike | null
  sibling?: FiberLike | null
  stateNode?: unknown
}

interface HookLike {
  memoizedState?: unknown
  next?: HookLike | null
}

export interface InspectedQueryArea {
  element: Element
  label: string
  queryCounts: ReadonlyMap<string, number>
  supported: boolean
}

const MAX_FIBERS = 20_000
const MAX_VALUE_DEPTH = 4

export function inspectQueryArea(element: Element): InspectedQueryArea {
  const fiber = elementFiber(element)
  const counts = new Map<string, number>()
  if (!fiber) {
    return { element, label: describeElement(element), queryCounts: counts, supported: false }
  }

  const visited = new Set<FiberLike>()
  const stack = [fiber]
  while (stack.length > 0 && visited.size < MAX_FIBERS) {
    const current = stack.pop()!
    if (visited.has(current)) continue
    visited.add(current)
    addFiberQueries(current, counts)
    if (current.sibling && current !== fiber) stack.push(current.sibling)
    if (current.child) stack.push(current.child)
  }

  // A component's hooks live above the host element it returns. Include ancestors
  // whose complete host output remains inside the pick. When a click lands on a leaf
  // (usually text inside a row), fall back to the nearest query-owning component.
  let foundQueries = counts.size > 0
  let ancestor = fiber.return
  while (ancestor) {
    if (fiberOutputIsInside(ancestor, element)) {
      addFiberQueries(ancestor, counts)
      foundQueries = counts.size > 0
      ancestor = ancestor.return
      continue
    }
    if (foundQueries) break
    const nearestOwner = new Map<string, number>()
    addFiberQueries(ancestor, nearestOwner)
    if (nearestOwner.size > 0) {
      for (const [key, count] of nearestOwner) counts.set(key, (counts.get(key) ?? 0) + count)
      break
    }
    ancestor = ancestor.return
  }

  return { element, label: describeElement(element), queryCounts: counts, supported: true }
}

export function describeElement(element: Element): string {
  const tag = element.tagName.toLowerCase()
  if (element.id) return `${tag}#${element.id}`
  const classes = Array.from(element.classList).slice(0, 2)
  return classes.length > 0 ? `${tag}.${classes.join('.')}` : tag
}

function elementFiber(element: Element): FiberLike | null {
  const record = element as unknown as Record<string, unknown>
  const key = Object.keys(record).find(
    item => item.startsWith('__reactFiber$') || item.startsWith('__reactInternalInstance$'),
  )
  return key && isFiber(record[key]) ? record[key] : null
}

function isFiber(value: unknown): value is FiberLike {
  return typeof value === 'object' && value !== null
}

function addFiberQueries(fiber: FiberLike, counts: Map<string, number>): void {
  let keys = queryKeysInHooks(fiber.memoizedState)
  if (keys.size === 0 && fiber.alternate) {
    keys = queryKeysInHooks(fiber.alternate.memoizedState)
  }
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1)
}

function queryKeysInHooks(value: unknown): Set<string> {
  const keys = new Set<string>()
  const visited = new Set<object>()
  let hook = isHook(value) ? value : null
  let hooksSeen = 0
  while (hook && hooksSeen < 1_000) {
    scanHookValue(hook.memoizedState, keys, visited, 0)
    hook = isHook(hook.next) ? hook.next : null
    hooksSeen += 1
  }
  return keys
}

function isHook(value: unknown): value is HookLike {
  return typeof value === 'object' && value !== null && 'memoizedState' in value
}

function scanHookValue(
  value: unknown,
  keys: Set<string>,
  visited: Set<object>,
  depth: number,
): void {
  const marked = queryKeysForSubscription(value)
  if (marked) {
    for (const key of marked) keys.add(key)
    return
  }
  if (depth >= MAX_VALUE_DEPTH || (typeof value !== 'object' && typeof value !== 'function')) {
    return
  }
  if (value === null || visited.has(value)) return
  visited.add(value)

  if (Array.isArray(value)) {
    for (const item of value) scanHookValue(item, keys, visited, depth + 1)
    return
  }
  for (const item of Object.values(value)) {
    scanHookValue(item, keys, visited, depth + 1)
  }
}

function fiberOutputIsInside(fiber: FiberLike, selected: Element): boolean {
  const ElementConstructor = selected.ownerDocument.defaultView?.Element
  if (!ElementConstructor) return false
  const stack = [fiber]
  const visited = new Set<FiberLike>()
  let foundHost = false
  while (stack.length > 0 && visited.size < MAX_FIBERS) {
    const current = stack.pop()!
    if (visited.has(current)) continue
    visited.add(current)
    if (current.stateNode instanceof ElementConstructor) {
      foundHost = true
      if (current.stateNode !== selected && !selected.contains(current.stateNode)) return false
      // Descendant host nodes are necessarily inside this host element.
      if (current.stateNode !== selected) continue
    }
    if (current.sibling && current !== fiber) stack.push(current.sibling)
    if (current.child) stack.push(current.child)
  }
  return foundHost
}
