/**
 * Small shared UI pieces used across the demo's panes and pages.
 */

import { useDelayedFlag } from 'figbird'

/** Fetching indicator that only appears when the activity lasts long enough to matter. */
export function StatusDot({ active }: { active: boolean }) {
  const show = useDelayedFlag(active, 300)
  return show ? <span className='dot' title='fetching' /> : null
}

/** Escape a user-provided string for use inside a RegExp. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function SkeletonRows({ count, compact = false }: { count: number; compact?: boolean }) {
  return (
    <div className={`skeleton-list${compact ? ' compact' : ''}`}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className='skeleton-row' />
      ))}
    </div>
  )
}

export function DetailSkeleton() {
  return (
    <main className='detail'>
      <div className='skeleton-detail'>
        <div className='skeleton-bar w-30' />
        <div className='skeleton-bar w-80 lg' />
        <div className='skeleton-bar w-50' />
      </div>
    </main>
  )
}
