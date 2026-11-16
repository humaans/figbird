import { Component, Suspense, type ReactNode } from 'react'
import { createHooks, createSchema, service } from '../lib'
import { dom, it } from './dom'
import { createTestApp } from './helpers'

const schema = createSchema({
  services: { jobs: service<{ item: { id: number; status: string } }>() },
})
const { q, useQuery } = createHooks(schema)

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override render() {
    return this.state.failed ? <div className='failed'>Failed</div> : this.props.children
  }
}

it('entity queries: 21 and 40 cold siblings commit without evicting their render reads', async t => {
  for (const count of [21, 40]) {
    const { App, figbird, adapter } = createTestApp(schema, { jobs: { data: {} } })
    t.teardown(() => figbird.dispose())
    adapter.get = async (_service, id) => ({ data: { id, status: 'done' } })
    const d = dom({ onCaughtError: () => {} })
    let renders = 0
    function Sibling({ id }: { id: number }) {
      if (++renders > 400) throw new Error('Suspense retry loop')
      return <span className='ready'>{useQuery(q.jobs.get(id))?.status}</span>
    }
    d.render(
      <App>
        <Boundary>
          <Suspense fallback={<div>Loading</div>}>
            {Array.from({ length: count }, (_, id) => (
              <Sibling key={id} id={id} />
            ))}
          </Suspense>
        </Boundary>
      </App>,
    )
    await d.flush()
    t.is(d.$all('.ready').length, count)
    t.falsy(d.$('.failed'))
    d.unmount()
  }
})

it('entity queries: a prepare pin does not trap an error-boundary retry', async t => {
  const { App, figbird, adapter } = createTestApp(schema, { jobs: { data: {} } })
  t.teardown(() => figbird.dispose())
  adapter.get = async () => {
    throw new Error('offline')
  }
  const builder = q.jobs.get(1)
  const prepared = figbird.prepare(builder)
  await t.throwsAsync(prepared.promise, { message: 'offline' })
  function Probe() {
    return <div className='ready'>{useQuery(builder)?.status}</div>
  }
  const d = dom({ onCaughtError: () => {} })
  d.render(
    <App>
      <Boundary key='first'>
        <Suspense fallback={<div>Loading</div>}>
          <Probe />
        </Suspense>
      </Boundary>
    </App>,
  )
  await d.flush()
  t.truthy(d.$('.failed'))
  adapter.get = async (_service, id) => ({ data: { id, status: 'recovered' } })
  d.render(
    <App>
      <Boundary key='retry'>
        <Suspense fallback={<div>Loading</div>}>
          <Probe />
        </Suspense>
      </Boundary>
    </App>,
  )
  await d.flush()
  t.is(d.$('.ready')?.textContent, 'recovered')
  d.unmount()
  prepared.release()
})
