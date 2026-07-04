/**
 * Named queries for the issue detail screen.
 *
 * These live in the eagerly imported layer so the route's `prepare()` can fire
 * them in parallel with the screen module's `import()`. The screen reads them
 * with the same definitions and hits the same cache entries.
 */

import { type StandardSchemaV1 } from 'figbird'
import { figbird } from '../../figbird'

// Tiny passthrough Standard Schema validator. Real consumers would pass zod/valibot/arktype.
function passthrough<T>(): StandardSchemaV1<T, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'demo-passthrough',
      validate: (input: unknown) => ({ value: input as T }),
    },
  }
}

/** Route-priority: required to render the issue header/meta. */
export const issueDetailQuery = figbird.defineQuery(
  'issueDetail',
  passthrough<{ id: number }>(),
  ({ id }) =>
    figbird.q.issues
      .where({ id })
      .one()
      .related('creator')
      .related('assignee')
      .related('team')
      .related('issueLabels', link => link.related('label')),
)

/**
 * Started by the route prepare with `priority: 'defer'` so the thread lands warm.
 * Deliberately unwindowed (no sort/limit): the query classifies local-exact, so a
 * teammate's new comment or reply merges into the thread straight from the socket
 * event — no refetch. Ordering and threading are assembled in the component.
 */
export const issueCommentsQuery = figbird.defineQuery(
  'issueComments',
  passthrough<{ id: number }>(),
  ({ id }) => figbird.q.comments.where({ issueId: id }).related('author').related('reactions'),
)
