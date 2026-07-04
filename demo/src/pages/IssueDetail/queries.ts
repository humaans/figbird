/**
 * Named queries for the issue detail screen.
 *
 * These live in the eagerly imported layer so the route's `prepare()` can fire
 * them in parallel with the screen module's `import()`. The screen reads them
 * with the same definitions and hits the same cache entries.
 */

import { defineQuery, q } from '../../figbird'

// Args here come from typed code (the route prepare coerces the URL param first),
// so the plain typed-args form is enough. Pass a zod/valibot/arktype schema as the
// middle argument when args arrive from untrusted sources.

/** Route-priority: required to render the issue header/meta. */
export const issueDetailQuery = defineQuery(({ id }: { id: number }) =>
  q.issues
    .where({ id })
    .one()
    .related('creator')
    .related('assignee')
    .related('team')
    // Transparent two-hop junction (issues → issueLabels → labels): consumers
    // get Label[] directly, the join is hidden by the schema relationship.
    .related('labels'),
)

/**
 * Started by the route prepare with `priority: 'defer'` so the thread lands warm.
 * Deliberately unwindowed (no sort/limit): the query classifies local-exact, so a
 * teammate's new comment or reply merges into the thread straight from the socket
 * event — no refetch. Ordering and threading are assembled in the component.
 */
export const issueCommentsQuery = defineQuery(({ id }: { id: number }) =>
  q.comments.where({ issueId: id }).related('author').related('reactions'),
)
