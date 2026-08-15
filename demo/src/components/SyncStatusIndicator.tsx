import { useSyncStatus } from '../figbird'

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

export function SyncStatusIndicator() {
  const sync = useSyncStatus()
  const label =
    sync.phase === 'offline'
      ? 'Working offline'
      : sync.phase === 'error'
        ? sync.failedWrites > 0
          ? `Couldn’t sync ${plural(sync.failedWrites, 'change')}`
          : 'Couldn’t refresh data'
        : sync.phase === 'restoring'
          ? 'Refreshing stale data…'
          : sync.phase === 'syncing'
            ? `Saving ${plural(sync.pendingWrites, 'change')}…`
            : 'Everything saved'

  const detail = [
    `${plural(sync.pendingWrites, 'pending write')}`,
    `${plural(sync.failedWrites, 'failed write')}`,
    `${plural(sync.fetchingQueries, 'fetching query')}`,
    `${plural(sync.pendingReconciliations, 'pending reconciliation')}`,
    sync.lastSyncedAt === null
      ? 'Not synced yet'
      : `Last synced ${new Date(sync.lastSyncedAt).toLocaleTimeString()}`,
  ].join(' · ')

  return (
    <div className={`sync-status ${sync.phase}`} title={detail} aria-live='polite'>
      <span className='sync-status-orbit' aria-hidden='true'>
        <span className='sync-status-core' />
      </span>
      <span>{label}</span>
    </div>
  )
}
