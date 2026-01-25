import test from 'ava'
import { useState } from 'react'
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
  category?: string
  updatedAt?: number
}

const schema = createSchema({
  services: {
    'api/documents': service<{
      item: Document
      query: { category?: string; $sort?: Record<string, 1 | -1> }
    }>(),
  },
})

test('usePaginatedFind initial fetch loads first page', async t => {
  const { $, flush, render, unmount } = dom()

  const documents = [
    { id: 1, title: 'Doc 1', createdAt: 500 },
    { id: 2, title: 'Doc 2', createdAt: 400 },
    { id: 3, title: 'Doc 3', createdAt: 300 },
    { id: 4, title: 'Doc 4', createdAt: 200 },
    { id: 5, title: 'Doc 5', createdAt: 100 },
  ]

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: documents,
      pageSize: 2,
      mode: 'offset',
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { usePaginatedFind } = createHooks(figbird)

  function App() {
    const { status, data, page, totalPages, hasNextPage, hasPrevPage } = usePaginatedFind(
      'api/documents',
      { limit: 2 },
    )

    return (
      <div>
        <span className='status'>{status}</span>
        <span className='count'>{data.length}</span>
        <span className='page'>{page}</span>
        <span className='totalPages'>{totalPages}</span>
        <span className='hasNextPage'>{String(hasNextPage)}</span>
        <span className='hasPrevPage'>{String(hasPrevPage)}</span>
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
  t.is($('.page')?.textContent, '1')
  t.is($('.totalPages')?.textContent, '3')
  t.is($('.hasNextPage')?.textContent, 'true')
  t.is($('.hasPrevPage')?.textContent, 'false')

  unmount()
})

test('usePaginatedFind setPage changes page and fetches new data', async t => {
  const { $, $all, flush, render, unmount, click } = dom()

  const documents = [
    { id: 1, title: 'Doc 1', createdAt: 500 },
    { id: 2, title: 'Doc 2', createdAt: 400 },
    { id: 3, title: 'Doc 3', createdAt: 300 },
    { id: 4, title: 'Doc 4', createdAt: 200 },
    { id: 5, title: 'Doc 5', createdAt: 100 },
  ]

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: documents,
      pageSize: 2,
      mode: 'offset',
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { usePaginatedFind } = createHooks(figbird)

  function App() {
    const { data, page, setPage } = usePaginatedFind('api/documents', { limit: 2 })

    return (
      <div>
        <span className='page'>{page}</span>
        {data.map(d => (
          <span key={d.id} className='doc'>
            {d.title}
          </span>
        ))}
        <button onClick={() => setPage(2)} className='go-page-2'>
          Go to Page 2
        </button>
        <button onClick={() => setPage(3)} className='go-page-3'>
          Go to Page 3
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

  t.is($('.page')?.textContent, '1')
  let docs = $all('.doc').map(el => el.textContent)
  t.deepEqual(docs, ['Doc 1', 'Doc 2'])

  // Go to page 2
  click($('.go-page-2')!)
  await flush()

  t.is($('.page')?.textContent, '2')
  docs = $all('.doc').map(el => el.textContent)
  t.deepEqual(docs, ['Doc 3', 'Doc 4'])

  // Go to page 3
  click($('.go-page-3')!)
  await flush()

  t.is($('.page')?.textContent, '3')
  docs = $all('.doc').map(el => el.textContent)
  t.deepEqual(docs, ['Doc 5'])

  unmount()
})

test('usePaginatedFind nextPage/prevPage navigation', async t => {
  const { $, $all, flush, render, unmount, click } = dom()

  const documents = [
    { id: 1, title: 'Doc 1', createdAt: 500 },
    { id: 2, title: 'Doc 2', createdAt: 400 },
    { id: 3, title: 'Doc 3', createdAt: 300 },
    { id: 4, title: 'Doc 4', createdAt: 200 },
  ]

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: documents,
      pageSize: 2,
      mode: 'offset',
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { usePaginatedFind } = createHooks(figbird)

  function App() {
    const { data, page, hasNextPage, hasPrevPage, nextPage, prevPage } = usePaginatedFind(
      'api/documents',
      { limit: 2 },
    )

    return (
      <div>
        <span className='page'>{page}</span>
        {data.map(d => (
          <span key={d.id} className='doc'>
            {d.title}
          </span>
        ))}
        <button onClick={prevPage} disabled={!hasPrevPage} className='prev'>
          Previous
        </button>
        <button onClick={nextPage} disabled={!hasNextPage} className='next'>
          Next
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

  t.is($('.page')?.textContent, '1')
  t.deepEqual(
    $all('.doc').map(el => el.textContent),
    ['Doc 1', 'Doc 2'],
  )

  // Next page
  click($('.next')!)
  await flush()

  t.is($('.page')?.textContent, '2')
  t.deepEqual(
    $all('.doc').map(el => el.textContent),
    ['Doc 3', 'Doc 4'],
  )

  // Previous page
  click($('.prev')!)
  await flush()

  t.is($('.page')?.textContent, '1')
  t.deepEqual(
    $all('.doc').map(el => el.textContent),
    ['Doc 1', 'Doc 2'],
  )

  unmount()
})

test('usePaginatedFind hasNextPage/hasPrevPage computed correctly', async t => {
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
      mode: 'offset',
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { usePaginatedFind } = createHooks(figbird)

  function App() {
    const { page, totalPages, hasNextPage, hasPrevPage, nextPage, prevPage } = usePaginatedFind(
      'api/documents',
      { limit: 2 },
    )

    return (
      <div>
        <span className='page'>{page}</span>
        <span className='totalPages'>{totalPages}</span>
        <span className='hasNextPage'>{String(hasNextPage)}</span>
        <span className='hasPrevPage'>{String(hasPrevPage)}</span>
        <button onClick={prevPage} className='prev'>
          Previous
        </button>
        <button onClick={nextPage} className='next'>
          Next
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

  // Page 1 of 2
  t.is($('.page')?.textContent, '1')
  t.is($('.totalPages')?.textContent, '2')
  t.is($('.hasNextPage')?.textContent, 'true')
  t.is($('.hasPrevPage')?.textContent, 'false')

  // Go to page 2
  click($('.next')!)
  await flush()

  // Page 2 of 2
  t.is($('.page')?.textContent, '2')
  t.is($('.hasNextPage')?.textContent, 'false')
  t.is($('.hasPrevPage')?.textContent, 'true')

  unmount()
})

test('usePaginatedFind previous data shown during page transitions', async t => {
  const { $, $all, flush, render, unmount, click } = dom()

  const documents = [
    { id: 1, title: 'Doc 1', createdAt: 400 },
    { id: 2, title: 'Doc 2', createdAt: 300 },
    { id: 3, title: 'Doc 3', createdAt: 200 },
    { id: 4, title: 'Doc 4', createdAt: 100 },
  ]

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: documents,
      pageSize: 2,
      mode: 'offset',
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { usePaginatedFind } = createHooks(figbird)

  function App() {
    const { status, data, isFetching, nextPage } = usePaginatedFind('api/documents', { limit: 2 })

    return (
      <div>
        <span className='status'>{status}</span>
        <span className='isFetching'>{String(isFetching)}</span>
        <span className='count'>{data.length}</span>
        {data.map(d => (
          <span key={d.id} className='doc'>
            {d.title}
          </span>
        ))}
        <button onClick={nextPage} className='next'>
          Next
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

  t.is($('.status')?.textContent, 'success')
  t.is($('.count')?.textContent, '2')
  t.deepEqual(
    $all('.doc').map(el => el.textContent),
    ['Doc 1', 'Doc 2'],
  )

  // Navigate to next page - during transition, old data should still be shown
  click($('.next')!)

  // Status shows actual query state (loading for new page), but data is preserved
  // This is stale-while-revalidate behavior - show old data while fetching new
  t.is($('.isFetching')?.textContent, 'true')
  // Data from previous page should still be visible during loading
  t.is($('.count')?.textContent, '2')
  t.deepEqual(
    $all('.doc').map(el => el.textContent),
    ['Doc 1', 'Doc 2'],
  )

  await flush()

  // Now should have new data
  t.is($('.status')?.textContent, 'success')
  t.is($('.isFetching')?.textContent, 'false')
  t.deepEqual(
    $all('.doc').map(el => el.textContent),
    ['Doc 3', 'Doc 4'],
  )

  unmount()
})

test('usePaginatedFind realtime updates work for current page', async t => {
  const { $all, flush, render, unmount } = dom()

  const documents = [
    { id: 1, title: 'Doc 1', createdAt: 300 },
    { id: 2, title: 'Doc 2', createdAt: 200 },
  ]

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: documents,
      pageSize: 10,
      mode: 'offset',
    },
  })
  const adapter = new FeathersAdapter(feathers)
  // Disable event batching for tests so realtime updates are processed immediately
  const figbird = new Figbird({ schema, adapter, eventBatchProcessingInterval: 0 })
  const { usePaginatedFind } = createHooks(figbird)

  function App() {
    // Use realtime: 'merge' to test in-place updates (default is 'refetch')
    const { data } = usePaginatedFind('api/documents', { limit: 10, realtime: 'merge' })

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
  t.is($all('.doc')[0]?.textContent, 'Doc 1')

  // Update an existing document - wrap in flush callback to ensure proper event processing
  await flush(async () => {
    await feathers.service('api/documents').patch(1, { title: 'Doc 1 Updated' })
  })

  const docs = $all('.doc').map(el => el.textContent)
  t.deepEqual(docs, ['Doc 1 Updated', 'Doc 2'])

  unmount()
})

test('usePaginatedFind query change resets page to 1', async t => {
  const { $, $all, flush, render, unmount, click } = dom()

  const documents = [
    { id: 1, title: 'Doc 1', createdAt: 500, category: 'news' },
    { id: 2, title: 'Doc 2', createdAt: 400, category: 'news' },
    { id: 3, title: 'Doc 3', createdAt: 300, category: 'news' },
    { id: 4, title: 'Doc 4', createdAt: 200, category: 'sports' },
    { id: 5, title: 'Doc 5', createdAt: 100, category: 'sports' },
  ]

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: documents,
      pageSize: 2,
      mode: 'offset',
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { usePaginatedFind } = createHooks(figbird)

  function App() {
    const [category, setCategory] = useState<string | undefined>(undefined)
    const { data, page, nextPage } = usePaginatedFind('api/documents', {
      query: category ? { category } : {},
      limit: 2,
    })

    return (
      <div>
        <span className='page'>{page}</span>
        {data.map(d => (
          <span key={d.id} className='doc'>
            {d.title}
          </span>
        ))}
        <button onClick={nextPage} className='next'>
          Next
        </button>
        <button onClick={() => setCategory('sports')} className='filter-sports'>
          Filter Sports
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

  t.is($('.page')?.textContent, '1')
  t.deepEqual(
    $all('.doc').map(el => el.textContent),
    ['Doc 1', 'Doc 2'],
  )

  // Go to page 2
  click($('.next')!)
  await flush()

  t.is($('.page')?.textContent, '2')
  t.deepEqual(
    $all('.doc').map(el => el.textContent),
    ['Doc 3', 'Doc 4'],
  )

  // Change filter - should reset to page 1
  click($('.filter-sports')!)
  await flush()

  t.is($('.page')?.textContent, '1')
  // Note: The mock doesn't actually filter, but the page should reset

  unmount()
})

test('usePaginatedFind page clamping: page > totalPages', async t => {
  const { $, flush, render, unmount, click } = dom()

  const documents = [
    { id: 1, title: 'Doc 1', createdAt: 200 },
    { id: 2, title: 'Doc 2', createdAt: 100 },
  ]

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: documents,
      pageSize: 2,
      mode: 'offset',
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { usePaginatedFind } = createHooks(figbird)

  function App() {
    const { page, totalPages, setPage } = usePaginatedFind('api/documents', { limit: 2 })

    return (
      <div>
        <span className='page'>{page}</span>
        <span className='totalPages'>{totalPages}</span>
        <button onClick={() => setPage(100)} className='go-page-100'>
          Go to Page 100
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

  t.is($('.page')?.textContent, '1')
  t.is($('.totalPages')?.textContent, '1')

  // Try to go to page 100 (should clamp to 1)
  click($('.go-page-100')!)
  await flush()

  t.is($('.page')?.textContent, '1')

  unmount()
})

test('usePaginatedFind page clamping: page < 1', async t => {
  const { $, flush, render, unmount, click } = dom()

  const documents = [
    { id: 1, title: 'Doc 1', createdAt: 200 },
    { id: 2, title: 'Doc 2', createdAt: 100 },
  ]

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: documents,
      pageSize: 2,
      mode: 'offset',
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { usePaginatedFind } = createHooks(figbird)

  function App() {
    const { page, setPage } = usePaginatedFind('api/documents', { limit: 2 })

    return (
      <div>
        <span className='page'>{page}</span>
        <button onClick={() => setPage(0)} className='go-page-0'>
          Go to Page 0
        </button>
        <button onClick={() => setPage(-5)} className='go-page-neg'>
          Go to Page -5
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

  t.is($('.page')?.textContent, '1')

  // Try to go to page 0 (should clamp to 1)
  click($('.go-page-0')!)
  await flush()

  t.is($('.page')?.textContent, '1')

  // Try to go to page -5 (should clamp to 1)
  click($('.go-page-neg')!)
  await flush()

  t.is($('.page')?.textContent, '1')

  unmount()
})

test('usePaginatedFind empty results: totalPages = 1', async t => {
  const { $, flush, render, unmount } = dom()

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: [],
      pageSize: 10,
      mode: 'offset',
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { usePaginatedFind } = createHooks(figbird)

  function App() {
    const { data, page, totalPages, hasNextPage, hasPrevPage } = usePaginatedFind('api/documents', {
      limit: 10,
    })

    return (
      <div>
        <span className='count'>{data.length}</span>
        <span className='page'>{page}</span>
        <span className='totalPages'>{totalPages}</span>
        <span className='hasNextPage'>{String(hasNextPage)}</span>
        <span className='hasPrevPage'>{String(hasPrevPage)}</span>
      </div>
    )
  }

  render(
    <FigbirdProvider figbird={figbird}>
      <App />
    </FigbirdProvider>,
  )

  await flush()

  t.is($('.count')?.textContent, '0')
  t.is($('.page')?.textContent, '1')
  t.is($('.totalPages')?.textContent, '1')
  t.is($('.hasNextPage')?.textContent, 'false')
  t.is($('.hasPrevPage')?.textContent, 'false')

  unmount()
})

test('usePaginatedFind skip: true prevents fetch', async t => {
  const { $, flush, render, unmount } = dom()

  const documents = [{ id: 1, title: 'Doc 1', createdAt: 100 }]

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: documents,
      pageSize: 10,
      mode: 'offset',
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { usePaginatedFind } = createHooks(figbird)

  function App() {
    const { status, data, isFetching } = usePaginatedFind('api/documents', {
      limit: 10,
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

test('usePaginatedFind error handling', async t => {
  const { $, flush, render, unmount } = dom()

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: [],
      pageSize: 10,
      mode: 'offset',
      failNextFind: true,
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { usePaginatedFind } = createHooks(figbird)

  function App() {
    const { status, error } = usePaginatedFind('api/documents', { limit: 10, retry: false })

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

test('usePaginatedFind refetch re-fetches current page', async t => {
  const { $, flush, render, unmount, click } = dom()

  const documents = [
    { id: 1, title: 'Doc 1', createdAt: 200 },
    { id: 2, title: 'Doc 2', createdAt: 100 },
  ]

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: documents,
      pageSize: 2,
      mode: 'offset',
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { usePaginatedFind } = createHooks(figbird)

  function App() {
    const { status, data, refetch } = usePaginatedFind('api/documents', { limit: 2 })

    return (
      <div>
        <span className='status'>{status}</span>
        <span className='count'>{data.length}</span>
        <span className='findCount'>{feathers.service('api/documents').counts.find}</span>
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

  t.is($('.status')?.textContent, 'success')
  t.is($('.count')?.textContent, '2')
  const initialFindCount = parseInt($('.findCount')?.textContent || '0', 10)
  t.true(initialFindCount >= 1)

  // Refetch
  click($('.refetch')!)
  await flush()

  t.is($('.status')?.textContent, 'success')
  const newFindCount = parseInt($('.findCount')?.textContent || '0', 10)
  t.true(newFindCount > initialFindCount)

  unmount()
})

test('usePaginatedFind initialPage starts at specified page', async t => {
  const { $, $all, flush, render, unmount } = dom()

  const documents = [
    { id: 1, title: 'Doc 1', createdAt: 500 },
    { id: 2, title: 'Doc 2', createdAt: 400 },
    { id: 3, title: 'Doc 3', createdAt: 300 },
    { id: 4, title: 'Doc 4', createdAt: 200 },
  ]

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: documents,
      pageSize: 2,
      mode: 'offset',
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { usePaginatedFind } = createHooks(figbird)

  function App() {
    const { data, page } = usePaginatedFind('api/documents', {
      limit: 2,
      initialPage: 2,
    })

    return (
      <div>
        <span className='page'>{page}</span>
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

  t.is($('.page')?.textContent, '2')
  t.deepEqual(
    $all('.doc').map(el => el.textContent),
    ['Doc 3', 'Doc 4'],
  )

  unmount()
})

test('usePaginatedFind realtime disabled ignores events', async t => {
  const { $all, flush, render, unmount } = dom()

  const documents = [{ id: 1, title: 'Doc 1', createdAt: 100 }]

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: documents,
      pageSize: 10,
      mode: 'offset',
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { usePaginatedFind } = createHooks(figbird)

  function App() {
    const { data } = usePaginatedFind('api/documents', {
      limit: 10,
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

  // Patch document - should NOT update because realtime is disabled
  await feathers.service('api/documents').patch(1, { title: 'Doc 1 Updated' })
  await flush()

  // Still original text
  t.is($all('.doc')[0]?.textContent, 'Doc 1')

  unmount()
})

test('usePaginatedFind with query and sorting', async t => {
  const { $, $all, flush, render, unmount } = dom()

  const documents = [
    { id: 1, title: 'Doc 1', createdAt: 500 },
    { id: 2, title: 'Doc 2', createdAt: 400 },
    { id: 3, title: 'Doc 3', createdAt: 300 },
    { id: 4, title: 'Doc 4', createdAt: 200 },
  ]

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: documents,
      pageSize: 2,
      mode: 'offset',
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { usePaginatedFind } = createHooks(figbird)

  function App() {
    const { data, page, totalPages } = usePaginatedFind('api/documents', {
      query: { $sort: { createdAt: -1 } },
      limit: 2,
    })

    return (
      <div>
        <span className='page'>{page}</span>
        <span className='totalPages'>{totalPages}</span>
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

  t.is($('.page')?.textContent, '1')
  t.is($('.totalPages')?.textContent, '2')
  t.is($all('.doc').length, 2)

  unmount()
})

// Cursor pagination tests

test('usePaginatedFind cursor mode: totalPages is -1', async t => {
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
      mode: 'cursor',
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { usePaginatedFind } = createHooks(figbird)

  function App() {
    const { status, data, page, totalPages, hasNextPage, hasPrevPage } = usePaginatedFind(
      'api/documents',
      { limit: 2 },
    )

    return (
      <div>
        <span className='status'>{status}</span>
        <span className='count'>{data.length}</span>
        <span className='page'>{page}</span>
        <span className='totalPages'>{totalPages}</span>
        <span className='hasNextPage'>{String(hasNextPage)}</span>
        <span className='hasPrevPage'>{String(hasPrevPage)}</span>
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
  t.is($('.page')?.textContent, '1')
  t.is($('.totalPages')?.textContent, '-1') // Unknown in cursor mode
  t.is($('.hasNextPage')?.textContent, 'true')
  t.is($('.hasPrevPage')?.textContent, 'false')

  unmount()
})

test('usePaginatedFind cursor mode: nextPage/prevPage navigation', async t => {
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
      mode: 'cursor',
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { usePaginatedFind } = createHooks(figbird)

  function App() {
    const { data, page, hasNextPage, hasPrevPage, nextPage, prevPage } = usePaginatedFind(
      'api/documents',
      { limit: 2 },
    )

    return (
      <div>
        <span className='page'>{page}</span>
        <span className='hasNextPage'>{String(hasNextPage)}</span>
        <span className='hasPrevPage'>{String(hasPrevPage)}</span>
        {data.map(d => (
          <span key={d.id} className='doc'>
            {d.title}
          </span>
        ))}
        <button onClick={prevPage} disabled={!hasPrevPage} className='prev'>
          Previous
        </button>
        <button onClick={nextPage} disabled={!hasNextPage} className='next'>
          Next
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

  t.is($('.page')?.textContent, '1')
  t.deepEqual(
    $all('.doc').map(el => el.textContent),
    ['Doc 1', 'Doc 2'],
  )
  t.is($('.hasNextPage')?.textContent, 'true')
  t.is($('.hasPrevPage')?.textContent, 'false')

  // Next page
  click($('.next')!)
  await flush()

  t.is($('.page')?.textContent, '2')
  t.deepEqual(
    $all('.doc').map(el => el.textContent),
    ['Doc 3'],
  )
  t.is($('.hasNextPage')?.textContent, 'false')
  t.is($('.hasPrevPage')?.textContent, 'true')

  // Previous page - should navigate back using cursor history
  click($('.prev')!)
  await flush()

  t.is($('.page')?.textContent, '1')
  t.deepEqual(
    $all('.doc').map(el => el.textContent),
    ['Doc 1', 'Doc 2'],
  )

  unmount()
})

test('usePaginatedFind cursor mode: setPage ignores non-sequential jumps', async t => {
  const { $, flush, render, unmount, click } = dom()

  const documents = [
    { id: 1, title: 'Doc 1', createdAt: 500 },
    { id: 2, title: 'Doc 2', createdAt: 400 },
    { id: 3, title: 'Doc 3', createdAt: 300 },
    { id: 4, title: 'Doc 4', createdAt: 200 },
    { id: 5, title: 'Doc 5', createdAt: 100 },
  ]

  const feathers = mockCursorFeathers({
    'api/documents': {
      data: documents,
      pageSize: 2,
      mode: 'cursor',
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })
  const { usePaginatedFind } = createHooks(figbird)

  function App() {
    const { page, setPage } = usePaginatedFind('api/documents', { limit: 2 })

    return (
      <div>
        <span className='page'>{page}</span>
        <button onClick={() => setPage(3)} className='go-page-3'>
          Go to Page 3
        </button>
        <button onClick={() => setPage(1)} className='go-page-1'>
          Go to Page 1
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

  t.is($('.page')?.textContent, '1')

  // Try to jump to page 3 (should be silently ignored in cursor mode)
  click($('.go-page-3')!)
  await flush()

  // Still on page 1 because non-sequential jumps are ignored
  t.is($('.page')?.textContent, '1')

  // Try to go to page 1 (same page, should also be ignored)
  click($('.go-page-1')!)
  await flush()

  t.is($('.page')?.textContent, '1')

  unmount()
})
