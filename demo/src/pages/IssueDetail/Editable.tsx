/**
 * Inline editing — the optimistic patch-and-rollback lesson.
 *
 * Writes are optimistic by default: the cached value swaps in the same frame,
 * and a server failure (arm "Fail next mutation" in dev tools) rolls it back
 * everywhere at once — the failure itself lands in the save action's `error`,
 * no try/catch needed. The idle views render the cached value, so realtime
 * edits from other clients flow straight in.
 */

import { useState } from 'react'
import { m, useAction } from '../../figbird'

export function EditableTitle({ issueId, title }: { issueId: number; title: string }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const [validationError, setValidationError] = useState<string | null>(null)

  // The optimistic patch closes the editor immediately; if the server rejects
  // it, the cache rolls back and `save.error` carries the message.
  const save = useAction('edit-title', (next: string) => m.issues.patch(issueId, { title: next }))

  const startEditing = () => {
    setDraft(title)
    setValidationError(null)
    save.reset()
    setEditing(true)
  }
  const cancel = () => {
    setEditing(false)
    setValidationError(null)
  }
  const submit = () => {
    const next = draft.trim()
    if (next.length === 0) {
      setValidationError('Title cannot be empty')
      return
    }
    setEditing(false)
    setValidationError(null)
    if (next !== title) void save.run(next)
  }

  const error = validationError ?? save.error?.message ?? null

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
        submit()
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
      {validationError ? <span className='inline-error'>{validationError}</span> : null}
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

  const save = useAction('edit-description', (next: string) =>
    m.issues.patch(issueId, { description: next }),
  )

  const startEditing = () => {
    setDraft(description)
    setEditing(true)
  }
  const submit = () => {
    setEditing(false)
    const next = draft.trim()
    if (next !== description) void save.run(next)
  }

  if (!editing) {
    return (
      <div
        className={`detail-description${description ? '' : ' placeholder'}`}
        onClick={startEditing}
        title='Click to edit'
      >
        {description || 'Add a description…'}
        {save.error ? <span className='inline-error'> · {save.error.message}</span> : null}
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
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
        }}
        className='description-input'
        placeholder='Add a description…'
      />
      <div className='editor-actions'>
        <button type='button' className='link' onClick={submit}>
          Save
        </button>
        <button type='button' className='link' onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </div>
  )
}
