import { Suspense, useMemo, useState } from 'react'
import {
  figbird,
  useMutation,
  useQuery,
  type Document,
  type OrgUnit,
  type Person,
} from '../figbird'

type DocumentRow = Document & { person: (Person & { orgUnit: OrgUnit | null }) | null }

function RelationalFilterResults({ orgUnit }: { orgUnit: string }) {
  const {
    data: documents,
    isFetching,
    refetch,
  } = useQuery(
    figbird.q.documents
      .where({ 'person.orgUnit.label': orgUnit })
      .orderBy('createdAt', 'desc')
      .related('person', person => person.related('orgUnit')),
  )
  const documentMutation = useMutation('documents')
  const personMutation = useMutation('people')
  const orgUnitMutation = useMutation('orgUnits')
  const { data: people } = useQuery(figbird.q.people.related('orgUnit'))

  const peopleByUnit = useMemo(() => {
    const map = new Map<string, Person[]>()
    for (const person of people) {
      const label = person.orgUnit?.label
      if (!label) continue
      map.set(label, [...(map.get(label) ?? []), person])
    }
    return map
  }, [people])

  const createForUnit = async (label: string) => {
    const candidates = peopleByUnit.get(label)
    const person = candidates?.[0]
    if (!person) return
    await documentMutation.create({
      title: `${label} realtime note ${new Date().toLocaleTimeString()}`,
      personId: person.id,
      status: 'draft',
    })
  }

  return (
    <>
      <div className='detail-meta-line'>
        <span className='dim'>
          {documents.length} document{documents.length === 1 ? '' : 's'}
          {isFetching ? ' · refreshing' : ''}
        </span>
        <span className='spacer' />
        <button
          className='link'
          onClick={() => createForUnit(orgUnit)}
          disabled={documentMutation.status === 'loading'}
        >
          Create matching
        </button>
        <button
          className='link'
          onClick={() => createForUnit(orgUnit === 'Engineering' ? 'People' : 'Engineering')}
          disabled={documentMutation.status === 'loading'}
        >
          Create non-match
        </button>
        <button
          className='link'
          onClick={() => personMutation.patch(2, { name: `Bob ${Date.now() % 100}` })}
          disabled={personMutation.status === 'loading'}
        >
          Patch irrelevant
        </button>
        <button
          className='link'
          onClick={() => personMutation.patch(1, { orgUnitId: 1 })}
          disabled={personMutation.status === 'loading'}
        >
          Move Alice in
        </button>
        <button
          className='link'
          onClick={() => orgUnitMutation.patch(2, { label: 'Engineering' })}
          disabled={orgUnitMutation.status === 'loading'}
        >
          Rename People in
        </button>
        <button className='link' onClick={refetch} disabled={isFetching}>
          Refetch
        </button>
      </div>

      <div className='window-layout'>
        <div className='window-grid'>
          {(documents as DocumentRow[]).map(document => (
            <section key={document.id} className='window-company'>
              <header className='window-company-head'>
                <div>
                  <h2>{document.title}</h2>
                  <p>
                    {document.person?.name ?? 'Unknown'} ·{' '}
                    {document.person?.orgUnit?.label ?? 'Unknown unit'}
                  </p>
                </div>
                <span className={`window-status ${document.status}`}>{document.status}</span>
              </header>
            </section>
          ))}
        </div>

        <aside className='window-side'>
          <header className='section-head sub'>
            <span className='eyebrow'>Query</span>
          </header>
          <pre className='query-snippet'>{`figbird.q.documents
  .where({ 'person.orgUnit.label': '${orgUnit}' })
  .related('person', q => q.related('orgUnit'))`}</pre>
          <p className='note'>
            The server handles the relation filter. Root document events merge locally when person
            -&gt; orgUnit is already cached; person/org-unit events refetch only when a join or
            filter field changes. "Rename People in" changes the leaf filter field, so People
            documents become Engineering matches after a server refetch.
          </p>
        </aside>
      </div>
    </>
  )
}

export function RelationalFiltersPanel() {
  const [orgUnit, setOrgUnit] = useState('Engineering')

  return (
    <main className='detail'>
      <header className='detail-head'>
        <h1 className='detail-title'>Relational server filters</h1>
        <div className='detail-meta'>
          Documents are filtered by a relation path on the server, then realtime document events are
          filtered against the same path on the client.
        </div>
      </header>

      <div className='search-bar'>
        <select
          className='search-input compact'
          value={orgUnit}
          onChange={event => setOrgUnit(event.target.value)}
        >
          <option>Engineering</option>
          <option>People</option>
          <option>Operations</option>
        </select>
      </div>

      <Suspense fallback={<p className='empty-line'>Loading filtered documents…</p>}>
        <RelationalFilterResults orgUnit={orgUnit} />
      </Suspense>
    </main>
  )
}
