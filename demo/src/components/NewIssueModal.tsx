/**
 * New issue modal (Linear-style compact) — optimistic create with a
 * client-generated id, closing and navigating before the server responds.
 */

import { Suspense, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-space-router'
import { q, useMutations, useQueries } from '../figbird'
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
  const m = useMutations()
  const navigate = useNavigate()
  const [{ data: teams }, { data: users }] = useQueries([q.teams, q.users])
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [teamId, setTeamId] = useState(teams[0]?.id ?? 1)
  const [assigneeId, setAssigneeId] = useState(users[0]?.id ?? 1)

  const submit = () => {
    const trimmed = title.trim()
    if (trimmed.length === 0) return
    // The id contract: optimistic creates carry a client-generated id — the
    // issue's identity is real from the first frame, which is what lets this
    // modal navigate to /issues/<id> before the ack.
    const id = Date.now()
    void m.issues.create({
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
    })
    // The optimistic item is already in the cache — close and navigate
    // immediately. No useAction here: the modal unmounts on submit, so there is
    // no pending UI to hold; a failure rolls the item back everywhere at once.
    onClose()
    navigate(`/issues/${id}`)
  }

  return (
    <form
      className='modal-form'
      onSubmit={e => {
        e.preventDefault()
        submit()
      }}
    >
      <header className='modal-head'>
        <span className='eyebrow'>New issue</span>
        <Explain
          label='Optimistic create'
          query={`// writes are optimistic by default, and
// optimistic creates carry a client id —
// identity is real from the first frame:
m.issues.create({ id: Date.now(), title, … })

// that's what makes navigating before
// the ack safe: you own the id.

// surfaces that want a server-assigned id
// wait for it instead:
const issue = await m.issues.confirmed.create(...)
navigate(issue.id)`}
        >
          The create lands in the cache — list, activity, detail — before the server responds, and a
          failure rolls it back everywhere at once; no flags, that's the default. Optimistic creates
          carry a <em>client-generated id</em> (the id contract): the item's identity is real from
          the first frame, so React keys are stable, the realtime echo dedupes by id, and this modal
          can navigate to the new issue immediately. Servers that assign ids pair with{' '}
          <code>confirmed</code> creates — await the create, the server's item carries its identity.
          Try "Fail next mutation" in dev tools to watch the rollback.
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
