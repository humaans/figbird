/**
 * Route preparation for `/issues/:id`.
 *
 * Fired by the router during navigation, in parallel with the screen module's
 * dynamic `import()`. Returns the prepared handles so the router can pin the
 * underlying cache entries for this navigation and release them when superseded.
 */

import type { RoutePrepareContext } from 'react-space-router'
import { figbird } from '../../figbird'
import { issueCommentsQuery, issueDetailQuery } from './queries'

export function prepareIssueDetail({ params }: RoutePrepareContext) {
  const id = Number(params.id)
  if (!Number.isFinite(id)) return []
  return [
    figbird.prepare(issueDetailQuery, { id }, { priority: 'route' }),
    figbird.prepare(issueCommentsQuery, { id }, { priority: 'defer' }),
  ]
}
