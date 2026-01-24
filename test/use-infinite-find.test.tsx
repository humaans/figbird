import test from 'ava'
import { FeathersAdapter } from '../lib/adapters/feathers'
import { Figbird } from '../lib/core/figbird'
import { createSchema, service } from '../lib/core/schema'
import { createHooks } from '../lib/react/createHooks'
import { FigbirdProvider } from '../lib/react/react'
import { dom } from './helpers'
import { mockCursorFeathers } from './helpers-cursor'

interface Document {
  id: number
  title: string
  createdAt: number
  updatedAt?: number
}

const schema = createSchema({
  services: {
    'api/documents': service<{
      item: Document
      query: { personId?: string; $sort?: Record<string, 1 | -1> }
    }>(),
  },
})

test('useInfiniteFind initial fetch returns first page', async t => {
  const { $, flush, render, unmount } = dom()

  const documents = [
    { id: 1, title: 'Doc 1', createdAt: 300 },
    { id: 2, title: 'Doc 2', createdAt: 200 },
    { id: 3, title: 'Doc 3', createdAt: 100 },
  ]

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: documents,
      pageSize: 2,
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { useInfiniteFind } = createHooks(figbird)

  function App() {
    const { status, data, hasNextPage } = useInfiniteFind('api/documents', {
      query: { $sort: { createdAt: -1 } },
    })

    return (
      <div>
        <span className='status'>{status}</span>
        <span className='count'>{data.length}</span>
        <span className='hasNextPage'>{String(hasNextPage)}</span>
        {data.map(d => (
          <span key={d.id} className='doc'>
            {d.title}
          </span>
        ))}
      </div>
    )
  }

  render(
    <FigbirdProvider figbird={figbird}>
      <App />
    </FigbirdProvider>,
  )

  await flush()

  t.is($('.status')?.textContent, 'success')
  t.is($('.count')?.textContent, '2')
  t.is($('.hasNextPage')?.textContent, 'true')

  unmount()
})

test('useInfiniteFind loadMore fetches next page and accumulates data', async t => {
  const { $, $all, flush, render, unmount, click } = dom()

  const documents = [
    { id: 1, title: 'Doc 1', createdAt: 300 },
    { id: 2, title: 'Doc 2', createdAt: 200 },
    { id: 3, title: 'Doc 3', createdAt: 100 },
  ]

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: documents,
      pageSize: 2,
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { useInfiniteFind } = createHooks(figbird)

  function App() {
    const { status, data, hasNextPage, loadMore, isLoadingMore } = useInfiniteFind(
      'api/documents',
      {
        query: { $sort: { createdAt: -1 } },
      },
    )

    return (
      <div>
        <span className='status'>{status}</span>
        <span className='count'>{data.length}</span>
        <span className='hasNextPage'>{String(hasNextPage)}</span>
        <span className='isLoadingMore'>{String(isLoadingMore)}</span>
        {data.map(d => (
          <span key={d.id} className='doc'>
            {d.title}
          </span>
        ))}
        {hasNextPage && (
          <button onClick={loadMore} className='load-more'>
            Load More
          </button>
        )}
      </div>
    )
  }

  render(
    <FigbirdProvider figbird={figbird}>
      <App />
    </FigbirdProvider>,
  )

  await flush()

  t.is($('.count')?.textContent, '2')
  t.is($('.hasNextPage')?.textContent, 'true')

  // Click load more
  const loadMoreBtn = $('.load-more')
  t.truthy(loadMoreBtn)
  click(loadMoreBtn!)

  await flush()

  t.is($('.count')?.textContent, '3')
  t.is($('.hasNextPage')?.textContent, 'false')
  t.is($all('.doc').length, 3)

  unmount()
})

test('useInfiniteFind hasNextPage updates correctly', async t => {
  const { $, flush, render, unmount } = dom()

  const documents = [
    { id: 1, title: 'Doc 1', createdAt: 300 },
    { id: 2, title: 'Doc 2', createdAt: 200 },
  ]

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: documents,
      pageSize: 2,
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { useInfiniteFind } = createHooks(figbird)

  function App() {
    const { data, hasNextPage, loadMore } = useInfiniteFind('api/documents', {
      query: { $sort: { createdAt: -1 } },
    })

    return (
      <div>
        <span className='count'>{data.length}</span>
        <span className='hasNextPage'>{String(hasNextPage)}</span>
        {hasNextPage && (
          <button onClick={loadMore} className='load-more'>
            Load More
          </button>
        )}
      </div>
    )
  }

  render(
    <FigbirdProvider figbird={figbird}>
      <App />
    </FigbirdProvider>,
  )

  await flush()

  // With 2 items and pageSize 2, hasNextPage should be false
  t.is($('.count')?.textContent, '2')
  t.is($('.hasNextPage')?.textContent, 'false')
  t.falsy($('.load-more'))

  unmount()
})

test('useInfiniteFind realtime created events insert at sorted position', async t => {
  const { $, $all, flush, render, unmount } = dom()

  const documents = [
    { id: 1, title: 'Doc 1', createdAt: 300 },
    { id: 3, title: 'Doc 3', createdAt: 100 },
  ]

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: documents,
      pageSize: 10,
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { useInfiniteFind } = createHooks(figbird)

  function App() {
    const { data, status } = useInfiniteFind('api/documents', {
      query: { $sort: { createdAt: -1 } },
    })

    return (
      <div>
        <span className='status'>{status}</span>
        {data.map(d => (
          <span key={d.id} className='doc'>
            {d.title}
          </span>
        ))}
      </div>
    )
  }

  render(
    <FigbirdProvider figbird={figbird}>
      <App />
    </FigbirdProvider>,
  )

  await flush()

  t.is($('.status')?.textContent, 'success')
  t.is($all('.doc').length, 2)

  // Create a new document that should be inserted in the middle
  await feathers.service('api/documents').create({ id: 2, title: 'Doc 2', createdAt: 200 })
  await flush()

  const docs = $all('.doc').map(el => el.textContent)
  t.deepEqual(docs, ['Doc 1', 'Doc 2', 'Doc 3'])

  unmount()
})

test('useInfiniteFind realtime updated events update in place', async t => {
  const { $all, flush, render, unmount } = dom()

  const documents = [
    { id: 1, title: 'Doc 1', createdAt: 300 },
    { id: 2, title: 'Doc 2', createdAt: 200 },
  ]

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: documents,
      pageSize: 10,
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { useInfiniteFind } = createHooks(figbird)

  function App() {
    const { data, status } = useInfiniteFind('api/documents', {
      query: { $sort: { createdAt: -1 } },
    })

    return (
      <div>
        <span className='status'>{status}</span>
        {data.map(d => (
          <span key={d.id} className='doc'>
            {d.title}
          </span>
        ))}
      </div>
    )
  }

  render(
    <FigbirdProvider figbird={figbird}>
      <App />
    </FigbirdProvider>,
  )

  await flush()

  t.is($all('.doc').length, 2)
  t.is($all('.doc')[0]?.textContent, 'Doc 1')

  // Update the first document
  await feathers.service('api/documents').patch(1, { title: 'Doc 1 Updated' })
  await flush()

  const docs = $all('.doc').map(el => el.textContent)
  t.deepEqual(docs, ['Doc 1 Updated', 'Doc 2'])

  unmount()
})

test('useInfiniteFind realtime removed events remove from data', async t => {
  const { $all, flush, render, unmount } = dom()

  const documents = [
    { id: 1, title: 'Doc 1', createdAt: 300 },
    { id: 2, title: 'Doc 2', createdAt: 200 },
    { id: 3, title: 'Doc 3', createdAt: 100 },
  ]

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: documents,
      pageSize: 10,
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { useInfiniteFind } = createHooks(figbird)

  function App() {
    const { data } = useInfiniteFind('api/documents', {
      query: { $sort: { createdAt: -1 } },
    })

    return (
      <div>
        {data.map(d => (
          <span key={d.id} className='doc'>
            {d.title}
          </span>
        ))}
      </div>
    )
  }

  render(
    <FigbirdProvider figbird={figbird}>
      <App />
    </FigbirdProvider>,
  )

  await flush()

  t.is($all('.doc').length, 3)

  // Remove the middle document
  await feathers.service('api/documents').remove(2)
  await flush()

  const docs = $all('.doc').map(el => el.textContent)
  t.deepEqual(docs, ['Doc 1', 'Doc 3'])

  unmount()
})

test('useInfiniteFind skip: true prevents fetch', async t => {
  const { $, flush, render, unmount } = dom()

  const documents = [{ id: 1, title: 'Doc 1', createdAt: 300 }]

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: documents,
      pageSize: 10,
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { useInfiniteFind } = createHooks(figbird)

  function App() {
    const { status, data, isFetching } = useInfiniteFind('api/documents', {
      skip: true,
    })

    return (
      <div>
        <span className='status'>{status}</span>
        <span className='count'>{data.length}</span>
        <span className='isFetching'>{String(isFetching)}</span>
      </div>
    )
  }

  render(
    <FigbirdProvider figbird={figbird}>
      <App />
    </FigbirdProvider>,
  )

  await flush()

  t.is($('.status')?.textContent, 'loading')
  t.is($('.count')?.textContent, '0')
  t.is($('.isFetching')?.textContent, 'false')
  t.is(feathers.service('api/documents').counts.find, 0)

  unmount()
})

test('useInfiniteFind error handling for failed fetches', async t => {
  const { $, flush, render, unmount } = dom()

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: [],
      pageSize: 10,
      failNextFind: true,
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { useInfiniteFind } = createHooks(figbird)

  function App() {
    const { status, error } = useInfiniteFind('api/documents', {})

    return (
      <div>
        <span className='status'>{status}</span>
        <span className='error'>{error?.message ?? 'none'}</span>
      </div>
    )
  }

  render(
    <FigbirdProvider figbird={figbird}>
      <App />
    </FigbirdProvider>,
  )

  await flush()

  t.is($('.status')?.textContent, 'error')
  t.is($('.error')?.textContent, 'Simulated fetch error')

  unmount()
})

test('useInfiniteFind custom matcher works correctly', async t => {
  const { $all, flush, render, unmount } = dom()

  const documents = [
    { id: 1, title: 'Doc 1', createdAt: 300 },
    { id: 2, title: 'Doc 2', createdAt: 200 },
  ]

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: documents,
      pageSize: 10,
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { useInfiniteFind } = createHooks(figbird)

  function App() {
    const { data } = useInfiniteFind('api/documents', {
      query: { $sort: { createdAt: -1 } },
      // Custom matcher that only accepts items with id > 1
      matcher: () => (item: Document) => item.id > 1,
    })

    return (
      <div>
        {data.map(d => (
          <span key={d.id} className='doc'>
            {d.title}
          </span>
        ))}
      </div>
    )
  }

  render(
    <FigbirdProvider figbird={figbird}>
      <App />
    </FigbirdProvider>,
  )

  await flush()

  t.is($all('.doc').length, 2)

  // Create a new document with id 0 - should NOT be added due to custom matcher
  await feathers.service('api/documents').create({ id: 0, title: 'Doc 0', createdAt: 400 })
  await flush()

  // Still 2 docs because id 0 doesn't match
  t.is($all('.doc').length, 2)

  // Create a new document with id 4 - SHOULD be added
  await feathers.service('api/documents').create({ id: 4, title: 'Doc 4', createdAt: 50 })
  await flush()

  t.is($all('.doc').length, 3)

  unmount()
})

test('useInfiniteFind custom sorter works correctly', async t => {
  const { $all, flush, render, unmount } = dom()

  const documents = [
    { id: 1, title: 'Banana', createdAt: 300 },
    { id: 2, title: 'Apple', createdAt: 200 },
  ]

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: documents,
      pageSize: 10,
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { useInfiniteFind } = createHooks(figbird)

  function App() {
    const { data } = useInfiniteFind('api/documents', {
      // Custom sorter: sort alphabetically by title
      sorter: (a: Document, b: Document) => a.title.localeCompare(b.title),
    })

    return (
      <div>
        {data.map(d => (
          <span key={d.id} className='doc'>
            {d.title}
          </span>
        ))}
      </div>
    )
  }

  render(
    <FigbirdProvider figbird={figbird}>
      <App />
    </FigbirdProvider>,
  )

  await flush()

  // Initial data is in server order (Banana, Apple)
  let docs = $all('.doc').map(el => el.textContent)
  t.deepEqual(docs, ['Banana', 'Apple'])

  // Create "Cherry" - should be inserted after Banana alphabetically
  await feathers.service('api/documents').create({ id: 3, title: 'Cherry', createdAt: 100 })
  await flush()

  docs = $all('.doc').map(el => el.textContent)
  t.deepEqual(docs, ['Banana', 'Apple', 'Cherry'])

  unmount()
})

test('useInfiniteFind refetch resets to first page', async t => {
  const { $, flush, render, unmount, click } = dom()

  const documents = [
    { id: 1, title: 'Doc 1', createdAt: 300 },
    { id: 2, title: 'Doc 2', createdAt: 200 },
    { id: 3, title: 'Doc 3', createdAt: 100 },
  ]

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: documents,
      pageSize: 2,
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { useInfiniteFind } = createHooks(figbird)

  function App() {
    const { data, hasNextPage, loadMore, refetch } = useInfiniteFind('api/documents', {
      query: { $sort: { createdAt: -1 } },
    })

    return (
      <div>
        <span className='count'>{data.length}</span>
        <span className='hasNextPage'>{String(hasNextPage)}</span>
        {hasNextPage && (
          <button onClick={loadMore} className='load-more'>
            Load More
          </button>
        )}
        <button onClick={refetch} className='refetch'>
          Refetch
        </button>
      </div>
    )
  }

  render(
    <FigbirdProvider figbird={figbird}>
      <App />
    </FigbirdProvider>,
  )

  await flush()

  t.is($('.count')?.textContent, '2')

  // Load more to get all 3
  click($('.load-more')!)
  await flush()

  t.is($('.count')?.textContent, '3')
  t.is($('.hasNextPage')?.textContent, 'false')

  // Refetch should reset to first page
  click($('.refetch')!)
  await flush()

  t.is($('.count')?.textContent, '2')
  t.is($('.hasNextPage')?.textContent, 'true')

  unmount()
})

test('useInfiniteFind realtime disabled ignores events', async t => {
  const { $all, flush, render, unmount } = dom()

  const documents = [{ id: 1, title: 'Doc 1', createdAt: 300 }]

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: documents,
      pageSize: 10,
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { useInfiniteFind } = createHooks(figbird)

  function App() {
    const { data } = useInfiniteFind('api/documents', {
      realtime: 'disabled',
    })

    return (
      <div>
        {data.map(d => (
          <span key={d.id} className='doc'>
            {d.title}
          </span>
        ))}
      </div>
    )
  }

  render(
    <FigbirdProvider figbird={figbird}>
      <App />
    </FigbirdProvider>,
  )

  await flush()

  t.is($all('.doc').length, 1)

  // Create a new document - should NOT be added because realtime is disabled
  await feathers.service('api/documents').create({ id: 2, title: 'Doc 2', createdAt: 200 })
  await flush()

  // Still 1 doc
  t.is($all('.doc').length, 1)

  unmount()
})
