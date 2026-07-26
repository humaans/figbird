import { useEffect } from 'react'
import { RelationalQueryRef } from '../core/relationalQuery.js'

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

export function useElementPicker(
  active: boolean,
  accent: string,
  onPick: (area: InspectedQueryArea | null) => void,
): void {
  useEffect(() => {
    if (!active) return
    const appDocument = window.document
    const overlay = appDocument.createElement('div')
    const label = appDocument.createElement('div')
    let hovered: Element | null = null
    const previousCursor = appDocument.documentElement.style.cursor

    Object.assign(overlay.style, {
      position: 'fixed',
      zIndex: '2147483647',
      pointerEvents: 'none',
      border: `2px solid ${accent}`,
      background: 'rgba(29, 101, 216, .10)',
      boxSizing: 'border-box',
      display: 'none',
    })
    Object.assign(label.style, {
      position: 'absolute',
      left: '-2px',
      bottom: '100%',
      maxWidth: '320px',
      padding: '3px 6px',
      background: accent,
      color: '#fff',
      font: '11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    })
    overlay.append(label)
    appDocument.body.append(overlay)
    appDocument.documentElement.style.cursor = 'crosshair'

    const updateOverlay = () => {
      if (!hovered || !hovered.isConnected) {
        overlay.style.display = 'none'
        return
      }
      const rect = hovered.getBoundingClientRect()
      Object.assign(overlay.style, {
        display: 'block',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      })
    }
    const selectableTarget = (event: Event): Element | null => {
      const target = event.target
      if (!(target instanceof window.Element) || target.closest('[data-figbird-devtools]')) {
        return null
      }
      return target
    }
    const onPointerMove = (event: PointerEvent) => {
      hovered = selectableTarget(event)
      if (hovered) label.textContent = describeElement(hovered)
      updateOverlay()
    }
    const onClick = (event: MouseEvent) => {
      const target = selectableTarget(event)
      if (!target) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      onPick(inspectQueryArea(target))
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onPick(null)
    }

    appDocument.addEventListener('pointermove', onPointerMove, true)
    appDocument.addEventListener('click', onClick, true)
    appDocument.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('scroll', updateOverlay, true)
    window.addEventListener('resize', updateOverlay)
    return () => {
      appDocument.removeEventListener('pointermove', onPointerMove, true)
      appDocument.removeEventListener('click', onClick, true)
      appDocument.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('scroll', updateOverlay, true)
      window.removeEventListener('resize', updateOverlay)
      appDocument.documentElement.style.cursor = previousCursor
      overlay.remove()
    }
  }, [accent, active, onPick])
}

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
  if (value instanceof RelationalQueryRef) {
    keys.add(value.details().queryId)
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
