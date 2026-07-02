import { Suspense, useMemo } from 'react'
import { figbird, useMutation, useQuery, type Company, type Person } from '../figbird'

function PersonRow({ person }: { person: Person }) {
  return (
    <li className='window-person'>
      <span className='window-person-main'>
        <span className='window-person-name'>{person.name}</span>
        <span className='window-person-meta'>
          {person.role} · started {person.startDate}
        </span>
      </span>
      <span className={`window-status ${person.status}`}>{person.status}</span>
    </li>
  )
}

function CompanyWindow({ company }: { company: Company & { people: Person[] } }) {
  return (
    <section className='window-company'>
      <header className='window-company-head'>
        <div>
          <h2>{company.name}</h2>
          <p>{company.segment}</p>
        </div>
        <span className='window-count'>{company.people.length}/2</span>
      </header>
      <ol className='window-people'>
        {company.people.map(person => (
          <PersonRow key={person.id} person={person} />
        ))}
      </ol>
    </section>
  )
}

function WindowedCompanies() {
  const {
    data: companies,
    isFetching,
    refetch,
  } = useQuery(
    figbird.q.companies
      .orderBy('id', 'asc')
      .related('people', people =>
        people
          .where({ status: 'active' })
          .orderBy('startDate', 'desc')
          .orderBy('id', 'asc')
          .limit(2),
      ),
  )
  const { data: activePeople } = useQuery(
    figbird.q.people
      .where({ status: 'active' })
      .orderBy('companyId', 'asc')
      .orderBy('startDate', 'desc'),
  )
  const peopleMutation = useMutation('people')

  const activeCounts = useMemo(() => {
    const counts = new Map<number, number>()
    for (const person of activePeople) {
      counts.set(person.companyId, (counts.get(person.companyId) ?? 0) + 1)
    }
    return counts
  }, [activePeople])

  const promoteGlobexHidden = () => {
    peopleMutation.patch(7, { startDate: '2025-06-15' })
  }

  const deactivateAcmeTop = () => {
    peopleMutation.patch(1, { status: 'inactive' })
  }

  return (
    <>
      <div className='detail-meta-line'>
        <span className='dim'>
          {companies.length} companies · {activePeople.length} active people
          {isFetching ? ' · refreshing' : ''}
        </span>
        <span className='spacer' />
        <button
          className='link'
          onClick={promoteGlobexHidden}
          disabled={peopleMutation.status === 'loading'}
        >
          Promote Globex hidden
        </button>
        <button
          className='link'
          onClick={deactivateAcmeTop}
          disabled={peopleMutation.status === 'loading'}
        >
          Deactivate Acme top
        </button>
        <button className='link' onClick={refetch} disabled={isFetching}>
          Refetch
        </button>
      </div>

      <div className='window-layout'>
        <div className='window-grid'>
          {companies.map(company => (
            <CompanyWindow key={company.id} company={company} />
          ))}
        </div>

        <aside className='window-side'>
          <header className='section-head sub'>
            <span className='eyebrow'>Active roster</span>
          </header>
          <ul className='window-roster'>
            {companies.map(company => (
              <li key={company.id}>
                <span>{company.name}</span>
                <span className='dim'>{activeCounts.get(company.id) ?? 0} active</span>
              </li>
            ))}
          </ul>
          <pre className='query-snippet'>{`figbird.q.companies
  .related('people', q =>
    q.where({ status: 'active' })
     .orderBy('startDate', 'desc')
     .limit(2)
  )`}</pre>
        </aside>
      </div>
    </>
  )
}

export function WindowedRelationsPanel() {
  return (
    <main className='detail'>
      <header className='detail-head'>
        <h1 className='detail-title'>Per-parent relation windows</h1>
        <div className='detail-meta'>
          Each company asks for the top two active people by start date. The relation limit is
          scoped to each parent company, so three companies can render up to six people from one
          query shape.
        </div>
      </header>

      <Suspense fallback={<p className='empty-line'>Loading company windows…</p>}>
        <WindowedCompanies />
      </Suspense>
    </main>
  )
}
