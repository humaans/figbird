import type { EventType, MatchResult } from './queryTypes.js'

export interface WindowState {
  rows: readonly unknown[]
  skip: number
  /** The served page size, after applying any server cap. */
  limit: number | undefined
}

export interface WindowChange {
  type: EventType
  item: unknown
  previousItem: unknown | null
  itemId: string
  hasItem: boolean
}

export interface WindowContext {
  matches(item: unknown): MatchResult
  compare: ((a: unknown, b: unknown) => number) | undefined
  keyOf(item: unknown): string | undefined
}

export type WindowDecision =
  | { type: 'noop' }
  | { type: 'refetch'; replaceVisible?: boolean }
  | { type: 'update'; data: readonly unknown[]; metaOp: 'added' | 'removed' | null }

/** First index whose row sorts strictly after the item; ties follow their equals. */
export function findInsertIndex(
  rows: readonly unknown[],
  item: unknown,
  compare: (a: unknown, b: unknown) => number,
): number {
  let low = 0
  let high = rows.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (compare(item, rows[middle]) < 0) high = middle
    else low = middle + 1
  }
  return low
}

/**
 * Decide whether a change can be placed in the server's contiguous result window.
 * Known positions merge locally; boundary ties and unseen replacement rows refetch.
 * Without ordering, visible rows keep their position and underfilled first pages append.
 * The caller applies row changes and adapter-specific metadata only after this decision.
 */
export function maintainWindow(
  state: WindowState,
  change: WindowChange,
  context: WindowContext,
): WindowDecision {
  const { rows, skip, limit } = state
  const { type, item, previousItem, itemId, hasItem } = change
  const { matches: match, compare: cmp, keyOf } = context
  const full = limit !== undefined && rows.length >= limit
  const matches = type !== 'removed' && match(item)
  const last = rows.length > 0 ? rows[rows.length - 1] : undefined
  // Is an invisible member provably past the window? At skip 0 everything before
  // the window is visible, so invisible ⇒ beyond; at an offset we need the
  // comparator to prove it sorts after the last visible row.
  const beyondWindow = (x: unknown) =>
    skip === 0 ? true : cmp !== undefined && last !== undefined && cmp(x, last) > 0
  // Prior result-set membership: judged by the cached previous entity when there is
  // one; a removed event carries the full removed record, which serves the same
  // purpose when the row was never cached (it lived beyond the window).
  const wasMember = previousItem != null ? match(previousItem) : type === 'removed' && match(item)
  // Membership local state can't decide is unprovable by definition.
  if (matches === 'unknown' || wasMember === 'unknown') {
    return { type: 'refetch', replaceVisible: hasItem && matches !== false }
  }

  if (!hasItem) {
    if (!matches) {
      // Invisible before and after — only the result-set total can be affected.
      if (!wasMember) return { type: 'noop' }
      if (beyondWindow(previousItem ?? item)) {
        return {
          type: 'update',
          data: rows,
          metaOp: 'removed',
        }
      }
      // Left the result set from before the window — the page shifts.
      return { type: 'refetch' }
    }

    // The item belongs to the result set now. A created item is certainly new; a
    // cached non-matching previous certainly entered; an uncached patch at an
    // offset window may have come from anywhere, including an earlier page.
    const metaOp =
      type === 'created' || (previousItem != null && !wasMember) ? ('added' as const) : null
    if (skip > 0 && previousItem == null && type !== 'created') {
      return { type: 'refetch' }
    }
    if (wasMember && !beyondWindow(previousItem)) {
      // It was in the result set before the window start — its move shifts the page.
      return { type: 'refetch' }
    }
    if (full && rows.length === 0) {
      // `$limit: 0` — a count-only window.
      if (metaOp === null) return { type: 'noop' }
      return { type: 'update', data: rows, metaOp }
    }
    if (!cmp) {
      if (skip > 0 || full) return { type: 'refetch' }
      // No order knowledge: membership is certain (underfilled first page = the
      // complete result set), position is approximate — append.
      return {
        type: 'update',
        data: [...rows, item],
        metaOp,
      }
    }
    if (rows.length === 0) {
      if (skip > 0) return { type: 'refetch' }
      return { type: 'update', data: [item], metaOp }
    }
    const i = findInsertIndex(rows, item, cmp)
    if (i === 0 && skip > 0) return { type: 'refetch' } // sorts before the page
    if (i === rows.length) {
      if (!full) {
        // Underfilled window = the final page: past-the-end still belongs here.
        return {
          type: 'update',
          data: [...rows, item],
          metaOp,
        }
      }
      if (cmp(item, rows[rows.length - 1]!) === 0) {
        return { type: 'refetch' } // tied with the boundary row
      }
      // Strictly past a full window: the total changes, the visible rows don't.
      if (metaOp === null) return { type: 'noop' }
      return { type: 'update', data: rows, metaOp }
    }
    const data = [...rows.slice(0, i), item, ...rows.slice(i)]
    if (limit !== undefined && data.length > limit) {
      data.pop()
    }
    return {
      type: 'update',
      data,
      metaOp,
    }
  }

  if (!matches) {
    // A visible row leaves. On a full window the replacement row is unknown.
    if (full) return { type: 'refetch' }
    return {
      type: 'update',
      data: rows.filter(row => keyOf(row) !== itemId),
      metaOp: 'removed',
    }
  }

  // Visible and still matching: update in place unless its sort position moved.
  const index = rows.findIndex(row => keyOf(row) === itemId)
  if (index === -1) return { type: 'refetch' } // index/data disagree — reconcile
  if (!cmp || cmp(rows[index]!, item) === 0) {
    // Sort keys unchanged (or order unknown — keep the position rather than guess).
    return {
      type: 'update',
      data: rows.map(row => (keyOf(row) === itemId ? item : row)),
      metaOp: null,
    }
  }
  // The row moved: re-place it within the contiguous run.
  const without = rows.filter(row => keyOf(row) !== itemId)
  if (without.length === 0) {
    return full || skip > 0 ? { type: 'refetch' } : { type: 'update', data: [item], metaOp: null }
  }
  const i = findInsertIndex(without, item, cmp)
  if (i === 0 && skip > 0) return { type: 'refetch' } // may move before the page
  if (i === without.length && full) {
    // May move past the window while an unseen row takes its place.
    return { type: 'refetch' }
  }
  return {
    type: 'update',
    data: [...without.slice(0, i), item, ...without.slice(i)],
    metaOp: null,
  }
}
