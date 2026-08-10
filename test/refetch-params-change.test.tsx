import test from 'ava'
import { useState } from 'react'
import { useFind } from '../lib'
import { dom, mockFeathers } from './helpers'
import { createSchema, service, FeathersAdapter, Figbird, FigbirdProvider } from '../lib'

interface Thing {
  id: number
  fk: string
  updatedAt?: number
}

const schema = createSchema({
  services: {
    things: service<{ item: Thing }>(),
  },
})

// Regression: calling refetch() and changing the hook's query params in the
// same tick must still issue a fetch for the new params (worked in 0.20).
test('useFind refetches when params change right after refetch()', async t => {
  const { render, flush, unmount, $, act } = dom()

  const feathers = mockFeathers({
    things: { data: {} },
  })

  const findCalls: Array<Record<string, unknown> | undefined> = []
  feathers.service('things').find = (params?: { query?: Record<string, unknown> }) => {
    findCalls.push(params?.query)
    const fk = params?.query?.fk
    const rows = Object.values(feathers.service('things').data).filter(
      item => item !== undefined && (item as unknown as Thing).fk === fk,
    )
    return Promise.resolve({ total: rows.length, limit: 100, skip: 0, data: rows })
  }

  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({
    schema,
    adapter,
    eventBatchInterval: 0,
    reconcileCooldown: 0,
  })

  let refetch: () => void
  let setFk: (fk: string) => void

  function Things() {
    const [fk, _setFk] = useState('A')
    setFk = _setFk
    const things = useFind('things', { query: { fk }, allPages: true, skip: !fk })
    refetch = things.refetch
    return (
      <div className='data'>
        {things.status === 'success' ? JSON.stringify(things.data.map(x => x.id)) : things.status}
      </div>
    )
  }

  render(
    <FigbirdProvider figbird={figbird}>
      <Things />
    </FigbirdProvider>,
  )

  await flush()
  t.is($('.data')!.innerHTML, '[]', 'settled empty for fk A')

  // The server now has a row for fk B (created out-of-band, no realtime event)
  feathers.service('things').data = { 1: { id: 1, fk: 'B' } }

  // Same handler: refetch() for the still-current params, then change params
  await flush(() => {
    act(() => {
      refetch()
      setFk('B')
    })
  })

  t.true(
    findCalls.some(q => q?.fk === 'B'),
    `expected a find for fk B, saw: ${JSON.stringify(findCalls)}`,
  )
  t.is($('.data')!.innerHTML, '[1]', 'shows the row for fk B')

  unmount()
})

// Same flow, but the service is materialized by an unfiltered allPages query
// (the "fetch all core data" bootstrap pattern) — finds are then answered
// locally from the entity cache via the local find path.
test('materialized service: refetch() then params change still yields fresh data', async t => {
  const { render, flush, unmount, $, act } = dom()

  const feathers = mockFeathers({
    things: { data: {} },
  })

  const findCalls: Array<Record<string, unknown> | undefined> = []
  feathers.service('things').find = (params?: { query?: Record<string, unknown> }) => {
    findCalls.push(params?.query)
    const fk = params?.query?.fk
    const rows = Object.values(feathers.service('things').data).filter(
      item => item !== undefined && (fk === undefined || (item as unknown as Thing).fk === fk),
    )
    return Promise.resolve({ total: rows.length, limit: 100, skip: 0, data: rows })
  }

  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({
    schema,
    adapter,
    eventBatchInterval: 0,
    reconcileCooldown: 0,
    defaultSort: { id: 1 },
  })

  let refetch: () => void
  let refetchAll: () => void
  let setFk: (fk: string) => void

  function AllThings() {
    const things = useFind('things', { allPages: true })
    refetchAll = things.refetch
    return null
  }

  function Things() {
    const [fk, _setFk] = useState('A')
    setFk = _setFk
    const things = useFind('things', { query: { fk }, allPages: true, skip: !fk })
    refetch = things.refetch
    return (
      <div className='data'>
        {things.status === 'success' ? JSON.stringify(things.data.map(x => x.id)) : things.status}
      </div>
    )
  }

  render(
    <FigbirdProvider figbird={figbird}>
      <AllThings />
      <Things />
    </FigbirdProvider>,
  )

  await flush()
  t.is($('.data')!.innerHTML, '[]', 'settled empty for fk A')

  // The server now has a row for fk B (created out-of-band, no realtime event)
  feathers.service('things').data = { 1: { id: 1, fk: 'B' } }

  // "Refetch everything" callback: refetch both queries, then change params
  await flush(() => {
    act(() => {
      refetchAll()
      refetch()
      setFk('B')
    })
  })

  t.is($('.data')!.innerHTML, '[1]', 'shows the row for fk B')
  t.false(
    findCalls.some(q => q?.fk === 'B'),
    'fk B query is answered locally from the materialized cache',
  )

  // The row is now removed out-of-band; a root refetch must propagate that too
  feathers.service('things').data = {}
  await flush(() => {
    act(() => {
      refetchAll()
    })
  })

  t.is($('.data')!.innerHTML, '[]', 'removed row disappears after root refetch')

  unmount()
})
