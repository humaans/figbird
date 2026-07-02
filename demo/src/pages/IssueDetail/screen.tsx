/**
 * Issue detail screen — the lazy chunk.
 *
 * Imported via `resolver: () => import('./screen')` so the screen code lives in
 * its own bundle. The router fires `prepareIssueDetail` (eager) and this
 * `import()` (lazy) in parallel, so total navigation latency becomes
 * `max(chunk, data)` instead of `chunk + data`.
 */

import { useState } from 'react'
import { useDelayedFlag } from 'figbird'
import { useRoute } from 'react-space-router'
import { useMutation, useQuery } from '../../figbird'
import { COMMENTS_PAGE_SIZE } from './constants'
import { issueCommentsQuery, issueDetailQuery } from './queries'

const userIds = [1, 2, 3, 4, 5, 6, 7, 8] as const
const teamIds = [1, 2, 3, 4] as const
const labelIds = [1, 2, 3, 4, 5, 6] as const

type DetailAction = 'comment' | 'reassign' | 'team' | 'priority' | 'status' | 'label'

function StatusDot({ active }: { active: boolean }) {
  const show = useDelayedFlag(active, 300)
  return show ? <span className='dot' title='fetching' /> : null
}

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
  const [pendingAction, setPendingAction] = useState<DetailAction | null>(null)
  // Route prepare warmed this exact query before the chunk arrived. The Suspense
  // boundary above (keyed by issueId) renders its skeleton if we're still cold.
  const { data: issue, isFetching, refetch } = useQuery(issueDetailQuery, { id: issueId })

  const commentMutation = useMutation('comments')
  const issueMutation = useMutation('issues')
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

  const addComment = () => {
    const bodies = [
      'Adding myself to the thread.',
      'Can reproduce this on staging.',
      'Pushed a speculative fix.',
      'Waiting on review.',
      'This looks like a relation cache edge case.',
    ]
    runAction('comment', () =>
      commentMutation.create({
        id: Date.now(),
        issueId: issue.id,
        authorId: 1,
        body: bodies[Math.floor(Math.random() * bodies.length)]!,
      }),
    )
  }

  const reassignIssue = () => {
    const currentIndex = userIds.indexOf(issue.assigneeId as (typeof userIds)[number])
    const nextUserId = userIds[(currentIndex + 1) % userIds.length]!
    runAction('reassign', () =>
      issueMutation.patch(issue.id, { assigneeId: nextUserId }, { optimistic: true }),
    )
  }

  const moveTeam = () => {
    const currentIndex = teamIds.indexOf(issue.teamId as (typeof teamIds)[number])
    const nextTeamId = teamIds[(currentIndex + 1) % teamIds.length]!
    runAction('team', () =>
      issueMutation.patch(issue.id, { teamId: nextTeamId }, { optimistic: true }),
    )
  }

  const boostPriority = () => {
    runAction('priority', () =>
      issueMutation.patch(
        issue.id,
        { priorityScore: Math.min(99, issue.priorityScore + 12) },
        { optimistic: true },
      ),
    )
  }

  const toggleStatus = () => {
    runAction('status', () =>
      issueMutation.patch(
        issue.id,
        { status: issue.status === 'open' ? 'closed' : 'open' },
        { optimistic: true },
      ),
    )
  }

  const addMissingLabel = () => {
    const existing = new Set(issue.issueLabels.map(link => link.labelId))
    const labelId = labelIds.find(id => !existing.has(id))
    if (!labelId) return
    runAction('label', () =>
      issueLabelMutation.create({ id: Date.now(), issueId: issue.id, labelId }),
    )
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
        </div>
        <EditableTitle issueId={issue.id} title={issue.title} />
        <div className='detail-meta'>
          {issue.creator?.name ?? 'unknown'} <span className='dim'>→</span>{' '}
          {issue.assignee?.name ?? 'unassigned'}
          {' · '}
          {issue.team?.name ?? 'no team'}
        </div>
        {issue.issueLabels.length > 0 ? (
          <div className='label-row'>
            {issue.issueLabels.map(link =>
              link.label ? (
                <span key={link.id} className={`label ${link.label.tone}`}>
                  {link.label.name}
                </span>
              ) : null,
            )}
          </div>
        ) : null}
      </header>

      <div className='action-toolbar'>
        <button className='link' onClick={addComment} disabled={busy}>
          {actionLabel('comment', 'Comment', 'Posting…')}
        </button>
        <Sep />
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
        <span className='spacer' />
        <button className='link' onClick={refetch} disabled={isFetching}>
          Refetch
        </button>
      </div>

      <CommentsPanel issueId={issue.id} />
    </main>
  )
}

/**
 * Inline title editing with optimistic + rollback. We swap the cached title
 * locally on Enter, then await the patch — if it fails (e.g. the server says
 * empty title), figbird auto-rolls back via `optimistic: true`.
 *
 * The title field also reflects the cached value while idle so realtime patches
 * from other clients still flow through.
 */
function EditableTitle({ issueId, title }: { issueId: number; title: string }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const [error, setError] = useState<string | null>(null)
  const issueMutation = useMutation('issues')

  const startEditing = () => {
    setDraft(title)
    setError(null)
    setEditing(true)
  }
  const cancel = () => {
    setEditing(false)
    setError(null)
  }
  const save = async () => {
    const next = draft.trim()
    if (next.length === 0) {
      setError('Title cannot be empty')
      return
    }
    if (next === title) {
      setEditing(false)
      return
    }
    setEditing(false)
    try {
      await issueMutation.patch(issueId, { title: next }, { optimistic: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (!editing) {
    return (
      <h1
        className='detail-title editable'
        onDoubleClick={startEditing}
        title='Double-click to edit'
      >
        {title}
        {error ? <span className='inline-error'> · {error}</span> : null}
      </h1>
    )
  }

  return (
    <form
      className='title-editor'
      onSubmit={e => {
        e.preventDefault()
        void save()
      }}
    >
      <input
        autoFocus
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Escape') cancel()
        }}
        className='title-input'
      />
      <button type='submit' className='link'>
        Save
      </button>
      <button type='button' className='link' onClick={cancel}>
        Cancel
      </button>
    </form>
  )
}

/**
 * Comments panel with explicit pagination. The first page is warmed by the
 * route's `priority: 'defer'` prepare so it lands without a Suspense flash.
 * Subsequent pages grow `limit` and use a fresh ad-hoc query.
 */
function CommentsPanel({ issueId }: { issueId: number }) {
  const [limit, setLimit] = useState(COMMENTS_PAGE_SIZE)

  // Same definition the route's `priority: 'defer'` prepare warmed. The limit
  // is parameterized: first paint hits the warm `limit: COMMENTS_PAGE_SIZE`
  // entry; "Load more" bumps to a fresh entry that the panel waits on.
  const { data: comments, isFetching } = useQuery(issueCommentsQuery, { id: issueId, limit })

  // We assume the underlying find returned a full page if we got `limit` rows back.
  // When fewer arrive, the server is out of comments — hide the button.
  const canLoadMore = comments.length >= limit

  return (
    <section className='comments'>
      <header className='section-head sub'>
        <span className='eyebrow'>Comments</span>
        <span className='count'>{comments.length}</span>
        <StatusDot active={isFetching} />
      </header>
      {comments.length === 0 ? (
        <p className='empty-line' style={{ padding: 0 }}>
          No comments yet.
        </p>
      ) : (
        <ul className='comment-list'>
          {comments.map(comment => (
            <li key={comment.id} className='comment'>
              <span className='comment-avatar'>{comment.author?.avatar ?? '○'}</span>
              <div className='comment-body-wrap'>
                <div className='comment-author'>{comment.author?.name ?? 'unknown'}</div>
                <div className='comment-body'>{comment.body}</div>
                {comment.reactions.length > 0 ? (
                  <div className='reactions'>
                    {comment.reactions.map(reaction => (
                      <span
                        key={reaction.id}
                        className='reaction'
                        title={`user ${reaction.userId}`}
                      >
                        {reaction.emoji}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {canLoadMore ? (
        <button
          className='link load-more'
          onClick={() => setLimit(l => l + COMMENTS_PAGE_SIZE)}
          disabled={isFetching}
        >
          Load more
        </button>
      ) : null}
    </section>
  )
}
