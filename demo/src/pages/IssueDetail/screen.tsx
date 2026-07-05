/**
 * Issue detail screen — the lazy chunk.
 *
 * Imported via `resolver: () => import('./screen')` so the screen code lives in
 * its own bundle. The router fires `prepareIssueDetail` (eager) and this
 * `import()` (lazy) in parallel, so total navigation latency becomes
 * `max(chunk, data)` instead of `chunk + data`.
 *
 * The toolbar is the per-action state lesson: every button is its own
 * `useAction` with its own `pending` label, and the toolbar-wide disable comes
 * from `useMutating` — which sees mutations touching this issue from ANY
 * surface (this screen, the list, the teammate simulator is server-side so not
 * that one), not just the buttons below.
 */

import { useNavigate, useRoute } from 'react-space-router'
import { m, q, useAction, useMutating, useQuery } from '../../figbird'
import { Explain } from '../../components/Explain'
import { StatusDot } from '../../components/ui'
import { CommentsPanel } from './Comments'
import { EditableDescription, EditableTitle } from './Editable'
import { issueDetailQuery } from './queries'

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
  // Route prepare warmed this exact query before the chunk arrived. The Suspense
  // boundary above (keyed by issueId) renders its skeleton if we're still cold.
  const { data: issue, isFetching, refetch } = useQuery(issueDetailQuery, { id: issueId })

  // Cycled through by the toolbar actions — queried rather than mirrored from the
  // server seed, so they can't silently drift when the seed changes.
  const { data: users } = useQuery(q.users)
  const { data: teams } = useQuery(q.teams)
  const { data: labels } = useQuery(q.labels)

  // One action per button: each owns its pending label; the bodies close over
  // the current issue, so no arguments need threading. Writes go through `m` —
  // optimistic by default, no flags anywhere. The names label the action:*
  // events, so the dev-tools log speaks this screen's vocabulary.
  const reassign = useAction('reassign', () => {
    const userIds = users.map(user => user.id)
    const nextUserId = userIds[(userIds.indexOf(issue!.assigneeId) + 1) % userIds.length]!
    return m.issues.patch(issue!.id, { assigneeId: nextUserId })
  })
  const moveTeam = useAction('move-team', () => {
    const teamIds = teams.map(team => team.id)
    const nextTeamId = teamIds[(teamIds.indexOf(issue!.teamId) + 1) % teamIds.length]!
    return m.issues.patch(issue!.id, { teamId: nextTeamId })
  })
  const boost = useAction('boost', () =>
    m.issues.patch(issue!.id, { priorityScore: Math.min(99, issue!.priorityScore + 12) }),
  )
  const toggleStatus = useAction('toggle-status', () =>
    m.issues.patch(issue!.id, { status: issue!.status === 'open' ? 'closed' : 'open' }),
  )
  const addLabel = useAction('add-label', async () => {
    const existing = new Set(issue!.labels.map(label => label.id))
    const labelId = labels.map(label => label.id).find(id => !existing.has(id))
    if (!labelId) return
    // Creating the junction row is enough — the realtime event on issueLabels flows
    // through the two-hop 'labels' relation and the new label appears in place.
    // Optimistic creates carry a client-generated id (the id contract).
    await m.issueLabels.create({ id: Date.now(), issueId: issue!.id, labelId })
  })
  // Per-invocation consequences live inside the action body — navigate only
  // after the remove settles.
  const remove = useAction('delete', async () => {
    await m.issues.remove(issue!.id)
    navigate('/')
  })

  // Serialize writes to this entity: disable the toolbar while ANY mutation is
  // in flight against issues — overlapping optimistic patches on one row would
  // make rollback ambiguous, so the app chooses not to allow them.
  const busy = useMutating({ service: 'issues', id: issue?.id })

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
            query={`defineQuery(({ id }: { id: number }) =>
  q.issues
    .get(id) // GET /issues/:id
    .related('creator')
    .related('assignee')
    .related('team')
    .related('labels')) // two-hop via issueLabels

// fired by the router, in parallel with
// this screen's lazy chunk (and by rows
// on hover, before you even click):
prepare(issueDetailQuery, { id })`}
          >
            One <code>.get(id)</code> query assembles the whole graph — issue, people, team, labels
            — from per-service caches. The route (and row hover) prepared this exact query, so warm
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
        <button className='link' onClick={reassign.run} disabled={busy}>
          {reassign.pending ? 'Reassigning…' : 'Reassign'}
        </button>
        <Sep />
        <button className='link' onClick={moveTeam.run} disabled={busy}>
          {moveTeam.pending ? 'Moving…' : 'Move team'}
        </button>
        <Sep />
        <button className='link' onClick={boost.run} disabled={busy}>
          {boost.pending ? 'Boosting…' : 'Boost'}
        </button>
        <Sep />
        <button className='link' onClick={toggleStatus.run} disabled={busy}>
          {toggleStatus.pending ? 'Updating…' : issue.status === 'open' ? 'Close' : 'Reopen'}
        </button>
        <Sep />
        <button className='link' onClick={addLabel.run} disabled={busy}>
          {addLabel.pending ? 'Adding…' : 'Add label'}
        </button>
        <Sep />
        <button
          className='link danger'
          onClick={() => {
            if (window.confirm('Delete this issue?')) void remove.run()
          }}
          disabled={busy}
        >
          {remove.pending ? 'Deleting…' : 'Delete'}
        </button>
        <span className='spacer' />
        <Explain
          label='Per-action state, per-entity busy'
          query={`// writes are optimistic by default —
// no flags, no handle setup:
const close = useAction('close', () =>
  m.issues.patch(issue.id, { status: 'closed' }))

// (surfaces that must wait for the ack
// use m.issues.confirmed.patch(...))

// toolbar-wide disable — true while ANY
// mutation touches this issue, from any
// screen or non-React code:
const busy = useMutating({
  service: 'issues', id: issue.id })`}
        >
          Every button is its own <code>useAction</code> — pending state has the identity of the
          hook call site, so there's no shared status slot and no hand-rolled "which action is
          loading" machine. The action names label the <code>action:*</code> events in the dev-tools
          log. The toolbar-wide disable is <code>useMutating</code>, backed by figbird's synchronous
          mutation tracker: it reports in-flight writes to this issue from anywhere, even components
          that mounted mid-mutation. A failed action (arm "Fail next mutation") lands in that
          button's <code>error</code> and rolls back the optimistic change.
        </Explain>
        <button className='link' onClick={refetch} disabled={isFetching}>
          Refetch
        </button>
      </div>
      {reassign.error || moveTeam.error || boost.error || toggleStatus.error || addLabel.error ? (
        <div className='inline-error'>
          {
            (reassign.error ??
              moveTeam.error ??
              boost.error ??
              toggleStatus.error ??
              addLabel.error)!.message
          }
        </div>
      ) : null}

      <CommentsPanel issueId={issue.id} />
    </main>
  )
}
