/**
 * Right-sidebar activity feed: three independent realtime queries (comments,
 * reactions, issues) merged into one timeline in the component.
 */

import { useMemo, type ReactNode } from 'react'
import { Link } from 'react-space-router'
import { figbird, useQuery } from './figbird'
import { Explain } from './Explain'
import { StatusDot } from './ui'

interface ActivityEntry {
  key: string
  ts: number
  node: ReactNode
}

export function ActivityPanel() {
  const { data: comments } = useQuery(
    figbird.q.comments.orderBy('id', 'desc').limit(10).related('author'),
  )
  const { data: reactions } = useQuery(
    figbird.q.reactions.orderBy('id', 'desc').limit(6).related('user'),
  )
  const { data: issues, isFetching } = useQuery(
    figbird.q.issues.orderBy('updatedAt', 'desc').limit(6),
  )

  const entries = useMemo<ActivityEntry[]>(() => {
    const out: ActivityEntry[] = []
    for (const c of comments) {
      out.push({
        key: `c-${c.id}`,
        ts: c.id,
        node: (
          <>
            <div className='activity-line'>
              <strong>{c.author?.name ?? 'someone'}</strong> commented on{' '}
              <Link href={`/issues/${c.issueId}`} className='inline-link'>
                #{c.issueId}
              </Link>
            </div>
            <div className='activity-body'>{c.body}</div>
          </>
        ),
      })
    }
    for (const r of reactions) {
      out.push({
        key: `r-${r.id}`,
        ts: r.id,
        node: (
          <div className='activity-line'>
            <strong>{r.user?.name ?? 'someone'}</strong> reacted {r.emoji} on comment #{r.commentId}
          </div>
        ),
      })
    }
    for (const i of issues) {
      out.push({
        key: `i-${i.id}-${i.updatedAt}`,
        ts: Date.parse(i.updatedAt) || 0,
        node: (
          <>
            <div className='activity-line'>
              <Link href={`/issues/${i.id}`} className='inline-link'>
                #{i.id}
              </Link>{' '}
              <span className='dim'>updated</span>
            </div>
            <div className='activity-body'>{i.title}</div>
          </>
        ),
      })
    }
    out.sort((a, b) => b.ts - a.ts)
    return out.slice(0, 12)
  }, [comments, reactions, issues])

  return (
    <section className='aside-section'>
      <header className='section-head'>
        <span className='eyebrow'>Activity</span>
        <StatusDot active={isFetching} />
        <Explain
          label='Cross-service feed'
          query={`q.comments.orderBy('id', 'desc').limit(10)
  .related('author')
q.reactions.orderBy('id', 'desc').limit(6)
  .related('user')
q.issues.orderBy('updatedAt', 'desc').limit(6)`}
        >
          Three independent queries — comments, reactions, issues — merged by timestamp in the
          component. Each stays realtime on its own service; a teammate's comment lands here, in the
          list's comment count, and in the open issue simultaneously, from one socket event.
        </Explain>
      </header>
      <ul className='activity-list'>
        {entries.map(e => (
          <li key={e.key} className='activity-item'>
            {e.node}
          </li>
        ))}
      </ul>
    </section>
  )
}
