import { StrictMode, Suspense } from 'react'
import { createHooks, Figbird, FigbirdProvider } from '../lib'
import { dom, it } from './dom'
import { deferred } from './mutation-test-helpers'
import { app, schema } from './custom-query-helpers'

const { q, useQuery, useQueryResult, useQueries, useMutating, defineQuery } = createHooks(schema)

it('custom q: useQuery suspends, deduplicates readers, and commits under StrictMode', async t => {
  const { figbird: original, adapter } = app()
  original.dispose()
  const figbird = new Figbird({ schema, adapter, staleTime: 0, gcTime: 0, retry: false })
  t.teardown(() => figbird.dispose())
  const gate = deferred<unknown>()
  let calls = 0
  adapter.mutate = () => {
    calls++
    return gate.promise
  }
  const d = dom()
  function Probe() {
    const result = useQuery(q.jobs.getCheck({ id: 1 }))
    return <span className='status'>{result.status}</span>
  }
  d.render(
    <StrictMode>
      <FigbirdProvider figbird={figbird}>
        <Suspense fallback={<div className='loading'>Loading</div>}>
          <Probe />
          <Probe />
        </Suspense>
      </FigbirdProvider>
    </StrictMode>,
  )
  t.truthy(d.$('.loading'))
  await d.flush(async () => {
    gate.resolve({ id: 1, status: 'done' })
    await gate.promise
  })
  t.is(calls, 1)
  t.deepEqual(
    d.$all('.status').map(element => element.textContent),
    ['done', 'done'],
  )
  t.falsy(d.$('.loading'))
  d.unmount()
})

it('custom q: useQueryResult exposes pending, errors, and refetch without mutation activity', async t => {
  const { App, figbird, adapter } = app()
  t.teardown(() => figbird.dispose())
  const gate = deferred<unknown>()
  adapter.mutate = () => gate.promise
  const d = dom()
  let refetch!: () => void
  function Probe() {
    const result = useQueryResult(q.jobs.getCheck({ id: 1 }), { suspense: false })
    const busy = useMutating()
    refetch = result.refetch
    return (
      <div className='status'>{`${result.status}:${busy}:${result.error?.message ?? result.data?.status ?? ''}`}</div>
    )
  }
  d.render(
    <App>
      <Probe />
    </App>,
  )
  await d.flush()
  t.is(d.$('.status')?.textContent, 'loading:false:')
  await d.flush(async () => {
    gate.reject(new Error('offline'))
    await gate.promise.catch(() => {})
  })
  t.is(d.$('.status')?.textContent, 'error:false:offline')
  adapter.mutate = async () => ({ id: 1, status: 'recovered' })
  await d.flush(() => refetch())
  t.is(d.$('.status')?.textContent, 'success:false:recovered')
  d.unmount()
})

it('custom q: definition requests, skip/null, and mixed parallel queries use existing hooks', async t => {
  const { App, figbird, feathers } = app()
  t.teardown(() => figbird.dispose())
  let calls = 0
  feathers.service('api/jobs').getCheck = async () => {
    calls++
    return { id: 1, status: 'checked' }
  }
  const status = defineQuery((id: number) => q.jobs.getCheck({ id }))
  const d = dom()
  function Probe({ skip }: { skip: boolean }) {
    const skipped = useQuery(status(99), { skip })
    const absent = useQuery(skip ? null : status(1))
    const [job, check] = useQueries([q.jobs.get(1), status(1)])
    return (
      <div className='status'>{`${job?.status}:${check.status}:${String(skipped)}:${absent?.status ?? 'absent'}`}</div>
    )
  }
  d.render(
    <App>
      <Suspense fallback={<div>Loading</div>}>
        <Probe skip />
      </Suspense>
    </App>,
  )
  await d.flush()
  t.is(d.$('.status')?.textContent, 'cached:checked:undefined:absent')
  t.is(calls, 1)
  d.unmount()
})
