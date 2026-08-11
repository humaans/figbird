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

interface InspectionBudget {
  fibers: number
  hookValues: number
  truncated: boolean
}

export interface InspectedQueryArea {
  element: Element
  label: string
  queryCounts: ReadonlyMap<string, number>
  supported: boolean
  /** True when the safety budget stopped inspection before the whole area was scanned. */
  truncated: boolean
}

const MAX_FIBERS = 20_000
const MAX_HOOK_VALUES = 20_000
const MAX_VALUE_DEPTH = 4

export function installElementPicker(
  accent: string,
  onPick: (area: InspectedQueryArea | null) => void,
): () => void {
  const overlay = document.createElement('div')
  const label = document.createElement('div')
  let hovered: Element | null = null
  const previousCursor = document.documentElement.style.cursor

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
  document.body.append(overlay)
  document.documentElement.style.cursor = 'crosshair'

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
  const cleanup = () => {
    document.removeEventListener('pointermove', onPointerMove, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('scroll', updateOverlay, true)
    window.removeEventListener('resize', updateOverlay)
    document.documentElement.style.cursor = previousCursor
    overlay.remove()
  }
  const onClick = (event: MouseEvent) => {
    const target = selectableTarget(event)
    if (!target) return
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    const result = inspectQueryArea(target)
    cleanup()
    onPick(result)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    cleanup()
    onPick(null)
  }

  document.addEventListener('pointermove', onPointerMove, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('scroll', updateOverlay, true)
  window.addEventListener('resize', updateOverlay)
  return cleanup
}

export function inspectQueryArea(element: Element): InspectedQueryArea {
  const fiber = elementFiber(element)
  const counts = new Map<string, number>()
  if (!fiber) {
    return {
      element,
      label: describeElement(element),
      queryCounts: counts,
      supported: false,
      truncated: false,
    }
  }

  const budget: InspectionBudget = {
    fibers: MAX_FIBERS,
    hookValues: MAX_HOOK_VALUES,
    truncated: false,
  }
  const visited = new Set<FiberLike>()
  const stack = [fiber]
  while (stack.length > 0 && takeFiber(budget)) {
    const current = stack.pop()!
    if (visited.has(current)) continue
    visited.add(current)
    addFiberQueries(current, counts, budget)
    if (budget.truncated) break
    if (current.sibling && current !== fiber) stack.push(current.sibling)
    if (current.child) stack.push(current.child)
  }

  // A component's hooks live above the host element it returns. Include ancestors
  // whose complete host output remains inside the pick. When a click lands on a leaf
  // (usually text inside a row), fall back to the nearest query-owning component.
  let foundQueries = counts.size > 0
  let ancestor = fiber.return
  while (ancestor && !budget.truncated) {
    if (fiberOutputIsInside(ancestor, element, budget)) {
      addFiberQueries(ancestor, counts, budget)
      foundQueries = counts.size > 0
      ancestor = ancestor.return
      continue
    }
    if (foundQueries) break
    const nearestOwner = new Map<string, number>()
    addFiberQueries(ancestor, nearestOwner, budget)
    if (nearestOwner.size > 0) {
      for (const [key, count] of nearestOwner) counts.set(key, (counts.get(key) ?? 0) + count)
      break
    }
    ancestor = ancestor.return
  }

  return {
    element,
    label: describeElement(element),
    queryCounts: counts,
    supported: true,
    truncated: budget.truncated,
  }
}

function describeElement(element: Element): string {
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

function addFiberQueries(
  fiber: FiberLike,
  counts: Map<string, number>,
  budget: InspectionBudget,
): void {
  let keys = queryKeysInHooks(fiber.memoizedState, budget)
  if (keys.size === 0 && fiber.alternate) {
    keys = queryKeysInHooks(fiber.alternate.memoizedState, budget)
  }
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1)
}

function queryKeysInHooks(value: unknown, budget: InspectionBudget): Set<string> {
  const keys = new Set<string>()
  const visited = new Set<object>()
  let hook = isHook(value) ? value : null
  let hooksSeen = 0
  while (hook && hooksSeen < 1_000 && !budget.truncated) {
    scanHookValue(hook.memoizedState, keys, visited, budget, 0)
    hook = isHook(hook.next) ? hook.next : null
    hooksSeen++
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
  budget: InspectionBudget,
  depth: number,
): void {
  if (!takeHookValue(budget)) return
  if (isRelationalQueryRef(value)) {
    keys.add(value.details().queryId)
    return
  }
  if (depth >= MAX_VALUE_DEPTH || (typeof value !== 'object' && typeof value !== 'function')) {
    return
  }
  if (value === null || visited.has(value)) return
  visited.add(value)

  try {
    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
      const length =
        lengthDescriptor &&
        'value' in lengthDescriptor &&
        typeof lengthDescriptor.value === 'number'
          ? lengthDescriptor.value
          : 0
      for (let index = 0; index < length; index++) {
        if (!takeHookValue(budget)) return
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (descriptor && 'value' in descriptor) {
          scanHookValue(descriptor.value, keys, visited, budget, depth + 1)
        }
      }
      return
    }

    for (const key in value) {
      if (!takeHookValue(budget)) return
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor?.enumerable && 'value' in descriptor) {
        scanHookValue(descriptor.value, keys, visited, budget, depth + 1)
      }
    }
  } catch {
    // Proxies and host objects may reject reflection; inspection remains best effort.
  }
}

function isRelationalQueryRef(value: unknown): value is { details(): { queryId: string } } {
  return (
    typeof value === 'object' &&
    value !== null &&
    value.constructor.name === 'RelationalQueryRef' &&
    'details' in value &&
    typeof value.details === 'function'
  )
}

function fiberOutputIsInside(
  fiber: FiberLike,
  selected: Element,
  budget: InspectionBudget,
): boolean {
  const ElementConstructor = selected.ownerDocument.defaultView?.Element
  if (!ElementConstructor) return false
  const stack = [fiber]
  const visited = new Set<FiberLike>()
  let foundHost = false
  while (stack.length > 0 && takeFiber(budget)) {
    const current = stack.pop()!
    if (visited.has(current)) continue
    visited.add(current)
    if (current.stateNode instanceof ElementConstructor) {
      foundHost = true
      if (current.stateNode !== selected && !selected.contains(current.stateNode)) return false
      if (current.stateNode !== selected) continue
    }
    if (current.sibling && current !== fiber) stack.push(current.sibling)
    if (current.child) stack.push(current.child)
  }
  return foundHost
}

function takeFiber(budget: InspectionBudget): boolean {
  if (budget.fibers > 0) {
    budget.fibers--
    return true
  }
  budget.truncated = true
  return false
}

function takeHookValue(budget: InspectionBudget): boolean {
  if (budget.hookValues > 0) {
    budget.hookValues--
    return true
  }
  budget.truncated = true
  return false
}
