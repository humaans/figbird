/**
 * Named queries for the issue detail screen.
 *
 * These live in the eagerly imported layer so the route's `queries` declaration
 * can warm them in parallel with the screen module's `import()`. The screen reads
 * them with the same definitions and hits the same cache entries.
 */

import { defineQuery, q } from '../../figbird'
import type { QueryDescriptor, RoutePrepareContext } from 'react-space-router'

// Args here come from typed code (the route coerces the URL param first),
// so the plain typed-args form is enough. Pass a zod/valibot/arktype schema as the
// middle argument when args arrive from untrusted sources.

/** Required to render the issue header/meta. */
export const issueDetailQuery = defineQuery(({ id }: { id: number }) =>
  q.issues
    // `.get(id)` fetches via the resource endpoint (GET /issues/:id) — the
    // pk-lookup spelling; "first match of a filter" is `.where().limit(1)`.
    .get(id)
    .related('creator')
    .related('assignee')
    .related('team')
    // Transparent two-hop junction (issues → issueLabels → labels): consumers
    // get Label[] directly, the join is hidden by the schema relationship.
    .related('labels'),
)

/**
 * Declared alongside the detail query so the comment thread lands warm.
 * Deliberately unwindowed (no sort/limit): the query classifies local-exact, so a
 * teammate's new comment or reply merges into the thread straight from the socket
 * event — no refetch. Ordering and threading are assembled in the component.
 */
export const issueCommentsQuery = defineQuery(({ id }: { id: number }) =>
  q.comments.where({ issueId: id }).related('author').related('reactions'),
)

export function issueDetailRouteQueries({ params }: RoutePrepareContext): QueryDescriptor[] {
  const id = Number(params.id)
  if (!Number.isFinite(id)) return []

  return [
    [issueDetailQuery, { id }],
    [issueCommentsQuery, { id }],
  ]
}
