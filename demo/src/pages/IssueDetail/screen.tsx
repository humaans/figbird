/**
 * Issue detail screen — the lazy chunk.
 *
 * Imported via `resolver: () => import('./screen')` so the screen code lives in
 * its own bundle. The router fires `prepareIssueDetail` (eager) and this
 * `import()` (lazy) in parallel, so total navigation latency becomes
 * `max(chunk, data)` instead of `chunk + data`.
 */

import { useMemo, useState } from 'react'
import { useDelayedFlag } from 'figbird'
import { useNavigate, useRoute } from 'react-space-router'
import { useMutation, useQuery, type Comment, type Reaction, type User } from '../../figbird'
import { Explain } from '../../Explain'
import { issueCommentsQuery, issueDetailQuery } from './queries'

const userIds = [1, 2, 3, 4, 5, 6, 7, 8] as const
const teamIds = [1, 2, 3, 4] as const
const labelIds = [1, 2, 3, 4, 5, 6] as const

// The demo has no auth — everything you do, you do as Alice.
const CURRENT_USER_ID = 1

type DetailAction = 'reassign' | 'team' | 'priority' | 'status' | 'label' | 'delete'

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
  const navigate = useNavigate()
  const [pendingAction, setPendingAction] = useState<DetailAction | null>(null)
  // Route prepare warmed this exact query before the chunk arrived. The Suspense
  // boundary above (keyed by issueId) renders its skeleton if we're still cold.
  const { data: issue, isFetching, refetch } = useQuery(issueDetailQuery, { id: issueId })

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
    const existing = new Set(issue.labels.map(label => label.id))
    const labelId = labelIds.find(id => !existing.has(id))
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
      await issueMutation.remove(issue.id, { optimistic: true })
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
            query={`defineQuery('issueDetail', schema, ({ id }) =>
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
figbird.prepare(issueDetailQuery, { id })`}
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
 * Inline description editing, same optimistic-patch pattern as the title.
 * The idle view renders the cached value, so realtime edits from other
 * clients flow straight in.
 */
function EditableDescription({ issueId, description }: { issueId: number; description: string }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(description)
  const issueMutation = useMutation('issues')

  const startEditing = () => {
    setDraft(description)
    setEditing(true)
  }
  const save = async () => {
    setEditing(false)
    const next = draft.trim()
    if (next === description) return
    await issueMutation.patch(issueId, { description: next }, { optimistic: true })
  }

  if (!editing) {
    return (
      <div
        className={`detail-description${description ? '' : ' placeholder'}`}
        onClick={startEditing}
        title='Click to edit'
      >
        {description || 'Add a description…'}
      </div>
    )
  }

  return (
    <div className='description-editor'>
      <textarea
        autoFocus
        rows={3}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Escape') setEditing(false)
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save()
        }}
        className='description-input'
        placeholder='Add a description…'
      />
      <div className='editor-actions'>
        <button type='button' className='link' onClick={() => void save()}>
          Save
        </button>
        <button type='button' className='link' onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </div>
  )
}

type CommentWithRelations = Comment & {
  author: User | null
  reactions: Reaction[]
}

interface CommentThread {
  root: CommentWithRelations
  replies: CommentWithRelations[]
}

/**
 * Threaded comments, Linear-style: one level of nesting. The query is
 * unwindowed (local-exact), so new comments and replies — yours or a
 * teammate's — merge into the thread from the realtime event, no refetch.
 */
function CommentsPanel({ issueId }: { issueId: number }) {
  const { data: comments, isFetching } = useQuery(issueCommentsQuery, { id: issueId })
  const [replyTo, setReplyTo] = useState<number | null>(null)

  const threads = useMemo<CommentThread[]>(() => {
    const repliesByParent = new Map<number, CommentWithRelations[]>()
    for (const comment of comments) {
      if (comment.parentId == null) continue
      const list = repliesByParent.get(comment.parentId) ?? []
      list.push(comment)
      repliesByParent.set(comment.parentId, list)
    }
    for (const list of repliesByParent.values()) {
      list.sort((a, b) => a.id - b.id)
    }
    return comments
      .filter(comment => comment.parentId == null)
      .sort((a, b) => a.id - b.id)
      .map(root => ({ root, replies: repliesByParent.get(root.id) ?? [] }))
  }, [comments])

  return (
    <section className='comments'>
      <header className='section-head sub'>
        <span className='eyebrow'>Comments</span>
        <span className='count'>{comments.length}</span>
        <StatusDot active={isFetching} />
        <Explain
          label='Prepared, live thread'
          query={`defineQuery('issueComments', schema, ({ id }) =>
  q.comments
    .where({ issueId: id })
    .related('author')
    .related('reactions'))

// fired by the route, in parallel with
// this screen's lazy chunk:
figbird.prepare(issueCommentsQuery, { id })`}
        >
          The route warmed this exact query before the screen's code even downloaded, so the thread
          usually renders without a fallback. It's deliberately unwindowed — figbird classifies it{' '}
          <em>local-exact</em>, so new comments and replies (yours or a teammate's) merge straight
          from the socket event, no refetch. Threading is assembled in the component.
        </Explain>
      </header>
      {threads.length === 0 ? (
        <p className='empty-line' style={{ padding: 0 }}>
          No comments yet.
        </p>
      ) : (
        <ul className='comment-list'>
          {threads.map(thread => (
            <li key={thread.root.id} className='comment-thread'>
              <CommentCard comment={thread.root} />
              {thread.replies.length > 0 ? (
                <ul className='comment-replies'>
                  {thread.replies.map(reply => (
                    <li key={reply.id}>
                      <CommentCard comment={reply} />
                    </li>
                  ))}
                </ul>
              ) : null}
              {replyTo === thread.root.id ? (
                <div className='comment-replies'>
                  <CommentComposer
                    issueId={issueId}
                    parentId={thread.root.id}
                    placeholder='Reply…'
                    autoFocus
                    onDone={() => setReplyTo(null)}
                  />
                </div>
              ) : (
                <button className='link reply-btn' onClick={() => setReplyTo(thread.root.id)}>
                  Reply
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <CommentComposer issueId={issueId} parentId={null} placeholder='Comment as Alice…' />
    </section>
  )
}

function CommentCard({ comment }: { comment: CommentWithRelations }) {
  return (
    <div className='comment'>
      <span className='comment-avatar'>{comment.author?.avatar ?? '○'}</span>
      <div className='comment-body-wrap'>
        <div className='comment-author'>{comment.author?.name ?? 'unknown'}</div>
        <div className='comment-body'>{comment.body}</div>
        {comment.reactions.length > 0 ? (
          <div className='reactions'>
            {comment.reactions.map(reaction => (
              <span key={reaction.id} className='reaction' title={`user ${reaction.userId}`}>
                {reaction.emoji}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Comment composer. Creates are optimistic with a client-generated id, so the
 * comment appears in the thread in the same frame — the server response (and
 * the realtime event echo) then confirms it.
 */
function CommentComposer({
  issueId,
  parentId,
  placeholder,
  autoFocus = false,
  onDone,
}: {
  issueId: number
  parentId: number | null
  placeholder: string
  autoFocus?: boolean
  onDone?: () => void
}) {
  const [body, setBody] = useState('')
  const commentMutation = useMutation('comments')
  const busy = commentMutation.status === 'loading'

  const submit = async () => {
    const text = body.trim()
    if (text.length === 0) return
    setBody('')
    onDone?.()
    await commentMutation.create(
      { id: Date.now(), issueId, authorId: CURRENT_USER_ID, parentId, body: text },
      { optimistic: true },
    )
  }

  return (
    <form
      className='composer'
      onSubmit={e => {
        e.preventDefault()
        void submit()
      }}
    >
      <textarea
        rows={2}
        autoFocus={autoFocus}
        value={body}
        onChange={e => setBody(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
          if (e.key === 'Escape') onDone?.()
        }}
        placeholder={placeholder}
        className='composer-input'
      />
      <div className='editor-actions'>
        <button type='submit' className='link' disabled={busy || body.trim().length === 0}>
          {parentId == null ? 'Comment' : 'Reply'}
        </button>
        {onDone ? (
          <button type='button' className='link' onClick={onDone}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  )
}
