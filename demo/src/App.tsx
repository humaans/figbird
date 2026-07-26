/**
 * Layout and routing shell. Feature panes live in their own modules:
 * IssueList, ActivityPanel, NewIssueModal, DemoControls, and pages/.
 */

import { Component, Suspense, useState, type ReactNode } from 'react'
import { DelayedFallback } from 'figbird'
import { FigbirdDevtools } from 'figbird/devtools'
import { Link, Router, Routes, useRoute } from 'react-space-router'
import { ActivityPanel } from './components/ActivityPanel'
import { DemoControls } from './components/DemoControls'
import { IssueListPane } from './components/IssueList'
import { NewIssueModal } from './components/NewIssueModal'
import { figbird, prepare, prefetch } from './figbird'
import { issueDetailRouteQueries } from './pages/IssueDetail/queries'
import { TeamsPage } from './pages/Teams/screen'
import { DetailSkeleton, SkeletonRows } from './components/ui'

function EmptyDetail() {
  return (
    <main className='detail'>
      <p className='empty-line'>Pick an issue from the list.</p>
    </main>
  )
}

/**
 * A cold `.get(id)` of a nonexistent issue enters the error state and throws
 * from `useQuery` — "this must exist" semantics. This boundary (keyed by issue
 * id alongside the Suspense boundary, so each issue gets a fresh start) renders
 * the not-found screen for that case; realtime removal of an issue you're already
 * viewing keeps the last data and surfaces ItemRemoved, which the screen handles.
 */
class DetailErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <main className='detail'>
          <div className='detail-empty'>
            <div className='detail-empty-title'>Issue not found</div>
            <div className='detail-empty-hint'>
              It may have been removed, or the id doesn't exist on the server.
            </div>
          </div>
        </main>
      )
    }
    return this.props.children
  }
}

function WorkspaceSkeleton() {
  return (
    <div className='grid'>
      <aside className='list'>
        <header className='section-head'>
          <span className='eyebrow'>Issues</span>
        </header>
        <SkeletonRows count={8} />
      </aside>
      <DetailSkeleton />
      <aside className='aside'>
        <header className='section-head'>
          <span className='eyebrow'>Teams</span>
        </header>
        <SkeletonRows count={4} compact />
      </aside>
    </div>
  )
}

function NavTab({ href, label }: { href: string; label: string }) {
  const route = useRoute()
  const path = route?.pathname ?? '/'
  const isActive =
    href === '/' ? path === '/' || path.startsWith('/issues/') : path.startsWith(href)
  return (
    <Link href={href} className={`nav-link${isActive ? ' active' : ''}`}>
      {label}
    </Link>
  )
}

function Workspace({ children }: { children?: ReactNode }) {
  const route = useRoute()
  const path = route?.pathname ?? '/'
  const isFull = path.startsWith('/teams')
  // Keyed Suspense boundary for issue detail: each id starts cold so the destination
  // shows its own skeleton instead of leaking the previous issue's data while the
  // new one loads.
  const issueId = path.startsWith('/issues/') ? (route?.params?.id ?? null) : null
  const [showNewIssue, setShowNewIssue] = useState(false)

  return (
    <>
      <nav className='nav'>
        <span className='brand'>figbird</span>
        <NavTab href='/' label='Issues' />
        <NavTab href='/teams' label='Teams' />
        <button className='link new-issue-btn' onClick={() => setShowNewIssue(true)}>
          + New issue
        </button>
        <span className='spacer' />
        <span className='nav-hint'>tip: open two windows side by side</span>
      </nav>
      {isFull ? (
        <div className='full grid-fade'>{children}</div>
      ) : (
        <div className='grid grid-fade'>
          <IssueListPane />
          <DetailErrorBoundary key={issueId ?? 'empty'}>
            <Suspense fallback={<DetailSkeleton />}>{children}</Suspense>
          </DetailErrorBoundary>
          <aside className='aside'>
            <ActivityPanel />
          </aside>
        </div>
      )}
      {showNewIssue ? <NewIssueModal onClose={() => setShowNewIssue(false)} /> : null}
    </>
  )
}

const routes = [
  {
    component: Workspace,
    routes: [
      { path: '/', component: EmptyDetail },
      // Lazy route: the screen chunk downloads in parallel with its data preparation,
      // so navigation latency is max(chunk, data) instead of chunk + data.
      {
        path: '/issues/:id',
        resolver: () => import('./pages/IssueDetail/screen'),
        queries: issueDetailRouteQueries,
      },
      // Eager route, on purpose — a small screen with no route-critical data doesn't
      // earn a chunk split. The demo shows both styles.
      { path: '/teams', component: TeamsPage },
    ],
  },
]

const routerData = { prepare, prefetch }

export function App() {
  return (
    <div className='app'>
      <Router routes={routes} data={routerData} prefetchHoverDelayMs={100}>
        <Suspense
          fallback={
            <DelayedFallback delay={250}>
              <WorkspaceSkeleton />
            </DelayedFallback>
          }
        >
          <Routes />
        </Suspense>
      </Router>
      <DemoControls />
      <FigbirdDevtools figbird={figbird} enabledByDefault={import.meta.env.DEV} />
    </div>
  )
}
