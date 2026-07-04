/**
 * New issue modal (Linear-style compact) — optimistic create with a
 * client-generated id, closing and navigating before the server responds.
 */

import { Suspense, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-space-router'
import { figbird, useMutation, useQuery } from './figbird'
import { Explain } from './Explain'

export function NewIssueModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className='modal-backdrop' onClick={onClose}>
      <div className='modal' onClick={e => e.stopPropagation()}>
        <Suspense fallback={<div className='modal-loading'>Loading…</div>}>
          <NewIssueForm onClose={onClose} />
        </Suspense>
      </div>
    </div>,
    document.body,
  )
}

function NewIssueForm({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const { data: teams } = useQuery(figbird.q.teams)
  const { data: users } = useQuery(figbird.q.users)
  const issueMutation = useMutation('issues')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [teamId, setTeamId] = useState(teams[0]?.id ?? 1)
  const [assigneeId, setAssigneeId] = useState(users[0]?.id ?? 1)

  const submit = async () => {
    const trimmed = title.trim()
    if (trimmed.length === 0) return
    const id = Date.now()
    const create = issueMutation.create(
      {
        id,
        title: trimmed,
        description: description.trim(),
        status: 'open',
        creatorId: 1,
        assigneeId,
        teamId,
        priorityScore: 50,
        updatedAt: new Date().toISOString(),
        commentIds: [],
      },
      { optimistic: true },
    )
    // The optimistic item is already in the cache — close and navigate immediately.
    onClose()
    navigate(`/issues/${id}`)
    await create
  }

  return (
    <form
      className='modal-form'
      onSubmit={e => {
        e.preventDefault()
        void submit()
      }}
    >
      <header className='modal-head'>
        <span className='eyebrow'>New issue</span>
        <Explain
          label='Optimistic create'
          query={`useMutation('issues').create(
  { id: Date.now(), title, description, … },
  { optimistic: true },
)`}
        >
          Create passes <code>{'{ optimistic: true }'}</code> with a client-generated id: the issue
          is in the cache — list, activity, detail — before the server responds, and a failure rolls
          it back everywhere at once. Try "Fail next mutation" in dev tools to watch the rollback.
        </Explain>
        <span className='spacer' />
        <button type='button' className='link' onClick={onClose}>
          Close
        </button>
      </header>
      <input
        autoFocus
        className='modal-title-input'
        placeholder='Issue title'
        value={title}
        onChange={e => setTitle(e.target.value)}
      />
      <textarea
        className='modal-desc-input'
        rows={4}
        placeholder='Add a description…'
        value={description}
        onChange={e => setDescription(e.target.value)}
      />
      <div className='modal-row'>
        <select
          className='modal-select'
          value={teamId}
          onChange={e => setTeamId(Number(e.target.value))}
        >
          {teams.map(team => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
        <select
          className='modal-select'
          value={assigneeId}
          onChange={e => setAssigneeId(Number(e.target.value))}
        >
          {users.map(user => (
            <option key={user.id} value={user.id}>
              {user.avatar} {user.name}
            </option>
          ))}
        </select>
        <span className='spacer' />
        <button type='submit' className='btn-primary' disabled={title.trim().length === 0}>
          Create issue
        </button>
      </div>
    </form>
  )
}
