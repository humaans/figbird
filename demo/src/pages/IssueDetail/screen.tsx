/**
 * Issue detail screen — the lazy chunk.
 *
 * Imported via `resolver: () => import('./screen')` so the screen code lives in
 * its own bundle. The router fires `prepareIssueDetail` (eager) and this
 * `import()` (lazy) in parallel, so total navigation latency becomes
 * `max(chunk, data)` instead of `chunk + data`.
 */

import { useState } from 'react'
import { useNavigate, useRoute } from 'react-space-router'
import { q, useMutation, useQuery } from '../../figbird'
import { Explain } from '../../Explain'
import { StatusDot } from '../../ui'
import { CommentsPanel } from './Comments'
import { EditableDescription, EditableTitle } from './Editable'
import { issueDetailQuery } from './queries'

type DetailAction = 'reassign' | 'team' | 'priority' | 'status' | 'label' | 'delete'

function Sep() {
  return (
    <span aria-hidden className='sep'>
      ·
    </span>
  )
}

export default function IssueDetailScreen() {
  const route = useRoute()
  const idRaw = route?.params?.id
  const issueId = typeof idRaw === 'string' || typeof idRaw === 'number' ? Number(idRaw) : NaN

  if (!Number.isFinite(issueId)) {
    return (
      <main className='detail'>
        <div className='detail-empty'>
          <div className='detail-empty-title'>Invalid issue id</div>
          <div className='detail-empty-hint'>The URL must look like /issues/&lt;id&gt;.</div>
        </div>
      </main>
    )
  }

  return <IssueDetailLoaded issueId={issueId} />
}

function IssueDetailLoaded({ issueId }: { issueId: number }) {
  const navigate = useNavigate()
  const [pendingAction, setPendingAction] = useState<DetailAction | null>(null)
  // Route prepare warmed this exact query before the chunk arrived. The Suspense
  // boundary above (keyed by issueId) renders its skeleton if we're still cold.
  const { data: issue, isFetching, refetch } = useQuery(issueDetailQuery, { id: issueId })

  // Cycled through by the toolbar actions — queried rather than mirrored from the
  // server seed, so they can't silently drift when the seed changes.
  const { data: users } = useQuery(q.users)
  const { data: teams } = useQuery(q.teams)
  const { data: labels } = useQuery(q.labels)

  // The whole detail surface is optimistic — declared once at the hook.
  const issueMutation = useMutation('issues', { optimistic: true })
  const issueLabelMutation = useMutation('issueLabels')

  if (!issue) {
    return (
      <main className='detail'>
        <div className='detail-empty'>
          <div className='detail-empty-title'>Issue not found</div>
          <div className='detail-empty-hint'>
            It may have been removed, or the id doesn't exist on the server.
          </div>
        </div>
      </main>
    )
  }

  const runAction = (action: DetailAction, task: () => Promise<unknown>) => {
    setPendingAction(action)
    void task().finally(() => {
      setPendingAction(current => (current === action ? null : current))
    })
  }

  const actionLabel = (action: DetailAction, idle: string, loading: string) =>
    pendingAction === action ? loading : idle

  const reassignIssue = () => {
    const userIds = users.map(user => user.id)
    if (userIds.length === 0) return
    const nextUserId = userIds[(userIds.indexOf(issue.assigneeId) + 1) % userIds.length]!
    runAction('reassign', () => issueMutation.patch(issue.id, { assigneeId: nextUserId }))
  }

  const moveTeam = () => {
    const teamIds = teams.map(team => team.id)
    if (teamIds.length === 0) return
    const nextTeamId = teamIds[(teamIds.indexOf(issue.teamId) + 1) % teamIds.length]!
    runAction('team', () => issueMutation.patch(issue.id, { teamId: nextTeamId }))
  }

  const boostPriority = () => {
    runAction('priority', () =>
      issueMutation.patch(issue.id, { priorityScore: Math.min(99, issue.priorityScore + 12) }),
    )
  }

  const toggleStatus = () => {
    runAction('status', () =>
      issueMutation.patch(issue.id, { status: issue.status === 'open' ? 'closed' : 'open' }),
    )
  }

  const addMissingLabel = () => {
    const existing = new Set(issue.labels.map(label => label.id))
    const labelId = labels.map(label => label.id).find(id => !existing.has(id))
    if (!labelId) return
    // Creating the junction row is enough — the realtime event on issueLabels flows
    // through the two-hop 'labels' relation and the new label appears in place.
    runAction('label', () =>
      issueLabelMutation.create({ id: Date.now(), issueId: issue.id, labelId }),
    )
  }

  const deleteIssue = () => {
    if (!window.confirm('Delete this issue?')) return
    runAction('delete', async () => {
      await issueMutation.remove(issue.id)
      navigate('/')
    })
  }

  const busy = pendingAction !== null

  return (
    <main className='detail'>
      <header className='detail-head'>
        <div className='detail-meta-line'>
          <span className={`status-dot ${issue.status}`} />
          <span className={`detail-status ${issue.status}`}>{issue.status}</span>
          <span className='dim'>·</span>
          <span className='dim'>#{issue.id}</span>
          <span className='dim'>·</span>
          <span className='dim'>priority {issue.priorityScore}</span>
          <StatusDot active={isFetching || busy} />
          <Explain
            label='Route-prepared issue graph'
            query={`defineQuery('issueDetail', ({ id }: { id: number }) =>
  q.issues
    .where({ id })
    .one()
    .related('creator')
    .related('assignee')
    .related('team')
    .related('labels')) // two-hop via issueLabels

// fired by the router, in parallel with
// this screen's lazy chunk (and by rows
// on hover, before you even click):
prepare(issueDetailQuery, { id })`}
          >
            One <code>.one()</code> query assembles the whole graph — issue, people, team, labels —
            from per-service caches. The route (and row hover) prepared this exact query, so warm
            visits render synchronously inside the issue-keyed Suspense boundary. The relation
            leaves stay live: Reassign patches the foreign key and figbird fetches and swaps in the
            new assignee; a teammate's edits merge from socket events.
          </Explain>
        </div>
        <EditableTitle issueId={issue.id} title={issue.title} />
        <div className='detail-meta'>
          {issue.creator?.name ?? 'unknown'} <span className='dim'>→</span>{' '}
          {issue.assignee?.name ?? 'unassigned'}
          {' · '}
          {issue.team?.name ?? 'no team'}
        </div>
        {issue.labels.length > 0 ? (
          <div className='label-row'>
            {issue.labels.map(label => (
              <span key={label.id} className={`label ${label.tone}`}>
                {label.name}
              </span>
            ))}
          </div>
        ) : null}
      </header>

      <EditableDescription issueId={issue.id} description={issue.description} />

      <div className='action-toolbar'>
        <button className='link' onClick={reassignIssue} disabled={busy}>
          {actionLabel('reassign', 'Reassign', 'Reassigning…')}
        </button>
        <Sep />
        <button className='link' onClick={moveTeam} disabled={busy}>
          {actionLabel('team', 'Move team', 'Moving…')}
        </button>
        <Sep />
        <button className='link' onClick={boostPriority} disabled={busy}>
          {actionLabel('priority', 'Boost', 'Boosting…')}
        </button>
        <Sep />
        <button className='link' onClick={toggleStatus} disabled={busy}>
          {actionLabel('status', issue.status === 'open' ? 'Close' : 'Reopen', 'Updating…')}
        </button>
        <Sep />
        <button className='link' onClick={addMissingLabel} disabled={busy}>
          {actionLabel('label', 'Add label', 'Adding…')}
        </button>
        <Sep />
        <button className='link danger' onClick={deleteIssue} disabled={busy}>
          {actionLabel('delete', 'Delete', 'Deleting…')}
        </button>
        <span className='spacer' />
        <button className='link' onClick={refetch} disabled={isFetching}>
          Refetch
        </button>
      </div>

      <CommentsPanel issueId={issue.id} />
    </main>
  )
}
