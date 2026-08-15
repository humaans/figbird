/**
 * Per-issue task editing through one optimistic mutation queue.
 *
 * Creates, patches, and removes project into the cache immediately, but reach
 * the server in issue-local order. Title-only patches wait briefly and coalesce,
 * so typing does not produce one request per keystroke. A create followed by
 * edits to its client id is still safe: the create reaches the server first.
 */

import { useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { defineMutationQueue, type MutationQueueConfig } from 'figbird'
import { useMutationQueue, useQuery, type Task, type User } from '../../figbird'
import { Explain } from '../../components/Explain'
import { issueTasksQuery } from './queries'

type TaskWithAssignee = Task & { assignee: User | null }

const TITLE_WAIT_MS = 450
const TITLE_MAX_WAIT_MS = 1_500

const taskQueueConfig: MutationQueueConfig = {
  schedule: operation => {
    const data = operation.data
    const keys = data && typeof data === 'object' ? Object.keys(data) : []
    return operation.serviceName === 'tasks' &&
      operation.method === 'patch' &&
      keys.length === 1 &&
      keys[0] === 'title'
      ? { wait: TITLE_WAIT_MS, maxWait: TITLE_MAX_WAIT_MS }
      : { wait: 0 }
  },
}

const issueTaskQueue = defineMutationQueue(taskQueueConfig)

let lastClientTaskId = 0

function nextClientTaskId(): number {
  lastClientTaskId = Math.max(Date.now(), lastClientTaskId + 1)
  return lastClientTaskId
}

export function TasksPanel({ issueId, users }: { issueId: number; users: User[] }) {
  const { data: tasks } = useQuery(issueTasksQuery({ id: issueId }))
  const queue = useMutationQueue(issueTaskQueue, `issue:${issueId}:tasks`)
  const [focusTaskId, setFocusTaskId] = useState<number | null>(null)

  const createTask = (after?: Task) => {
    const id = nextClientTaskId()
    let position = (tasks.at(-1)?.position ?? 0) + 1
    if (after) {
      const afterIndex = tasks.findIndex(task => task.id === after.id)
      const next = afterIndex === -1 ? undefined : tasks[afterIndex + 1]
      if (next) {
        position = after.position + (next.position - after.position) / 2

        // Repeated insertion can eventually exhaust the floating-point gap (and
        // older demo data may contain duplicate ranks). Re-space only then.
        if (!(position > after.position && position < next.position)) {
          tasks.forEach((task, index) => {
            void queue.m.tasks.patch(task.id, { position: (index + 1) * 2 })
          })
          position = (afterIndex + 1) * 2 + 1
        }
      } else if (afterIndex !== -1) {
        position = after.position + 1
      }
    }
    void queue.m.tasks.create({
      id,
      issueId,
      title: '',
      completed: false,
      assigneeId: null,
      position,
    })
    setFocusTaskId(id)
  }

  const completed = tasks.filter(task => task.completed).length
  const removedRemotely = isNotFound(queue.error)

  return (
    <section className='tasks'>
      <header className='tasks-head'>
        <div className='tasks-heading'>
          <span className='eyebrow'>Tasks</span>
          <span className='count'>
            {completed}/{tasks.length}
          </span>
          <QueueState status={queue.status} pending={queue.pending} />
        </div>
        <div className='tasks-actions'>
          <Explain
            label='Per-issue optimistic queue'
            query={`const taskSync = defineMutationQueue({
  schedule: op => titleOnly(op)
    ? { wait: 450, maxWait: 1500 }
    : { wait: 0 },
})

const sync = useMutationQueue(taskSync, 'issue:' + issueId + ':tasks')

// one reconnectable lane for this issue:
sync.m.tasks.create({ id, issueId, title: '' })
sync.m.tasks.patch(id, { title })
sync.m.tasks.patch(id, { assigneeId })
sync.m.tasks.remove(id)`}
          >
            This issue owns one reconnectable serial queue. Navigate away while it is saving and
            return to recover the same pending or failure state. Every operation appears
            optimistically at once, while transport preserves creation dependencies and user order.
            Consecutive unsent patches to the same task merge; title-only edits also wait{' '}
            {TITLE_WAIT_MS}ms, capped at {TITLE_MAX_WAIT_MS}ms. Assignees are a live relation
            resolved from the shared users cache. Open the Figbird Writes tab to watch projections
            coalesce and settle.
          </Explain>
          <button className='link task-add' onClick={() => createTask()}>
            + Add task
          </button>
        </div>
      </header>

      {tasks.length === 0 ? (
        <button className='task-empty' onClick={() => createTask()}>
          Add the first task, then press Enter to keep going.
        </button>
      ) : (
        <ul className='task-list'>
          {tasks.map(task => (
            <TaskRow
              key={task.id}
              task={task}
              users={users}
              autoFocus={task.id === focusTaskId}
              onTitle={title => void queue.m.tasks.patch(task.id, { title })}
              onToggle={() => void queue.m.tasks.patch(task.id, { completed: !task.completed })}
              onAssign={assigneeId => void queue.m.tasks.patch(task.id, { assigneeId })}
              onRemove={() => void queue.m.tasks.remove(task.id)}
              onCreateBelow={() => createTask(task)}
            />
          ))}
        </ul>
      )}

      {queue.status === 'failed' ? (
        <div className='task-queue-error' role='alert'>
          <span>
            {removedRemotely
              ? 'This task was removed elsewhere. Discard its obsolete edit to keep saving.'
              : (queue.error?.message ?? 'Task save failed.')}
          </span>
          {!removedRemotely ? (
            <button className='link' onClick={() => queue.retry()}>
              Retry
            </button>
          ) : null}
          <button className='link danger' onClick={() => queue.discard()}>
            Discard queued changes
          </button>
        </div>
      ) : null}
    </section>
  )
}

function isNotFound(error: Error | null): boolean {
  if (!error) return false
  const code = (error as Error & { code?: unknown }).code
  return error.name === 'NotFound' || code === 404
}

function QueueState({ status, pending }: { status: string; pending: number }) {
  if (status === 'idle') return <span className='task-queue-state saved'>Saved</span>
  const label =
    status === 'scheduled'
      ? `${pending} queued`
      : status === 'saving'
        ? `Saving ${pending}`
        : status === 'retrying'
          ? 'Retrying'
          : 'Save paused'
  return <span className={`task-queue-state ${status}`}>{label}</span>
}

function TaskRow({
  task,
  users,
  autoFocus,
  onTitle,
  onToggle,
  onAssign,
  onRemove,
  onCreateBelow,
}: {
  task: TaskWithAssignee
  users: User[]
  autoFocus: boolean
  onTitle: (title: string) => void
  onToggle: () => void
  onAssign: (assigneeId: number | null) => void
  onRemove: () => void
  onCreateBelow: () => void
}) {
  const selectedAssignee = users.find(user => user.id === task.assigneeId)

  const changeAssignee = (event: ChangeEvent<HTMLSelectElement>) => {
    onAssign(event.target.value === '' ? null : Number(event.target.value))
  }

  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      onCreateBelow()
    }
  }

  return (
    <li className={`task-row${task.completed ? ' completed' : ''}`}>
      <input
        type='checkbox'
        checked={task.completed}
        onChange={onToggle}
        aria-label={task.completed ? 'Mark task incomplete' : 'Mark task complete'}
        className='task-check'
      />
      <input
        value={task.title}
        onChange={event => onTitle(event.target.value)}
        onKeyDown={keyDown}
        autoFocus={autoFocus}
        placeholder='Task title'
        aria-label='Task title'
        className='task-title-input'
      />
      <label className='task-assignee'>
        <span aria-hidden>{task.assignee?.avatar ?? selectedAssignee?.avatar ?? '○'}</span>
        <select value={task.assigneeId ?? ''} onChange={changeAssignee} aria-label='Assignee'>
          <option value=''>Unassigned</option>
          {users.map(user => (
            <option key={user.id} value={user.id}>
              {user.name}
            </option>
          ))}
        </select>
      </label>
      <button
        className='task-remove'
        onClick={onRemove}
        aria-label='Remove task'
        title='Remove task'
      >
        ×
      </button>
    </li>
  )
}
