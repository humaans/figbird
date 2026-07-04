/**
 * Teams page — full-width routed page showing live rosters, server-curated
 * spotlights, and each team's recent activity.
 */

import { Link } from 'react-space-router'
import { q, useQuery } from '../../figbird'
import { Explain } from '../../Explain'
import { StatusDot } from '../../ui'

export function TeamsPage() {
  const { data: teams, isFetching } = useQuery(
    q.teams
      .related('members')
      .related('spotlight')
      .related('recentIssues', issue => issue.orderBy('updatedAt', 'desc').limit(5)),
  )

  return (
    <main className='detail teams-page'>
      <header className='detail-head'>
        <div className='detail-meta-line'>
          <span className='eyebrow'>Teams</span>
          <StatusDot active={isFetching} />
          <Explain
            label='Two ways to "top N per team"'
            query={`q.teams
  .related('members')      // fan-in IN(...)
  .related('spotlight')    // embed: server-maintained
                           // spotlightIssueIds, ONE batched
                           // fetch for all teams
  .related('recentIssues', i =>          // window:
    i.orderBy('updatedAt', 'desc').limit(5))
                           // one query per team`}
          >
            The same card demos both strategies. <strong>Recent</strong> is a windowed relation —
            the client asks for each team's window, one query per team (fine at 4; past ~10 figbird
            warns). <strong>Spotlight</strong> is the <code>embed()</code> pattern: the server
            maintains <code>team.spotlightIssueIds</code> (top open issues by priority), re-emits
            the team whenever the list changes, and figbird resolves every team's spotlight in a
            single IN(...) fetch, preserving the server's order. Watch the teammate's priority
            nudges reshuffle spotlights live.
          </Explain>
        </div>
        <h1 className='detail-title'>Teams</h1>
        <div className='detail-meta'>
          Live rosters, server-curated spotlights, and each team's latest activity — the teammate
          simulator keeps these moving.
        </div>
      </header>
      <div className='team-grid'>
        {teams.map(team => (
          <section key={team.id} className='team-card'>
            <header className='team-name'>
              <span className='team-accent' style={{ background: team.accent }} />
              {team.name}
              <span className='count'>{team.members.length} members</span>
            </header>
            <div className='team-members'>
              {team.members.map(member => (
                <span key={member.id} className='member'>
                  <span className='member-avatar'>{member.avatar}</span>
                  {member.name}
                </span>
              ))}
            </div>
            <div className='team-sub'>
              Spotlight <span className='team-sub-hint'>server-curated · by priority</span>
            </div>
            <ul className='team-issues'>
              {team.spotlight.map(issue => (
                <li key={issue.id}>
                  <Link href={`/issues/${issue.id}`} className='team-issue'>
                    <span className={`status-dot ${issue.status}`} />
                    <span className='team-issue-title'>{issue.title}</span>
                    <span className='dim team-issue-id'>{issue.priorityScore}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <div className='team-sub'>Recent</div>
            <ul className='team-issues'>
              {team.recentIssues.map(issue => (
                <li key={issue.id}>
                  <Link href={`/issues/${issue.id}`} className='team-issue'>
                    <span className={`status-dot ${issue.status}`} />
                    <span className='team-issue-title'>{issue.title}</span>
                    <span className='dim team-issue-id'>#{issue.id}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  )
}
