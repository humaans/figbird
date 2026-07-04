/**
 * Inline editing — the optimistic patch-and-rollback lesson.
 *
 * Both editors patch through an optimistic mutation hook: the cached value swaps
 * in the same frame, and a server failure (arm "Fail next mutation" in dev tools)
 * rolls it back everywhere at once. The idle views render the cached value, so
 * realtime edits from other clients flow straight in.
 */

import { useState } from 'react'
import { useMutation } from '../../figbird'

export function EditableTitle({ issueId, title }: { issueId: number; title: string }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const [error, setError] = useState<string | null>(null)
  const issueMutation = useMutation('issues', { optimistic: true })

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
      await issueMutation.patch(issueId, { title: next })
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

export function EditableDescription({
  issueId,
  description,
}: {
  issueId: number
  description: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(description)
  const issueMutation = useMutation('issues', { optimistic: true })

  const startEditing = () => {
    setDraft(description)
    setEditing(true)
  }
  const save = async () => {
    setEditing(false)
    const next = draft.trim()
    if (next === description) return
    await issueMutation.patch(issueId, { description: next })
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
