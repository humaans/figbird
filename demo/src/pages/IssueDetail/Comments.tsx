/**
 * Threaded comments — the local-exact realtime lesson.
 *
 * The comments query is deliberately unwindowed, so figbird classifies it
 * local-exact: new comments and replies (yours or a teammate's) merge into the
 * thread straight from the socket event, no refetch. Threading (one level of
 * nesting, Linear-style) is assembled in the component.
 */

import { useMemo, useState } from 'react'
import { useMutation, useQuery, type Comment, type Reaction, type User } from '../../figbird'
import { Explain } from '../../Explain'
import { StatusDot } from '../../ui'
import { issueCommentsQuery } from './queries'

// The demo has no auth — everything you do, you do as Alice.
const CURRENT_USER_ID = 1

type CommentWithRelations = Comment & {
  author: User | null
  reactions: Reaction[]
}

interface CommentThread {
  root: CommentWithRelations
  replies: CommentWithRelations[]
}

export function CommentsPanel({ issueId }: { issueId: number }) {
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
          query={`defineQuery('issueComments', ({ id }: { id: number }) =>
  q.comments
    .where({ issueId: id })
    .related('author')
    .related('reactions'))

// fired by the route, in parallel with
// this screen's lazy chunk:
prepare(issueCommentsQuery, { id })`}
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
  const commentMutation = useMutation('comments', { optimistic: true })
  const busy = commentMutation.status === 'loading'

  const submit = async () => {
    const text = body.trim()
    if (text.length === 0) return
    setBody('')
    onDone?.()
    await commentMutation.create({
      id: Date.now(),
      issueId,
      authorId: CURRENT_USER_ID,
      parentId,
      body: text,
    })
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
