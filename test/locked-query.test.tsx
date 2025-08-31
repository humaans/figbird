import test from 'ava'
import { FeathersAdapter } from '../lib/adapters/feathers.js'
import { Figbird } from '../lib/core/figbird.js'
import { createSchema, service } from '../lib/core/schema.js'
import { createHooks } from '../lib/react/createHooks.js'
import { FigbirdProvider } from '../lib/react/react.js'
import { dom, mockFeathers } from './helpers.js'

// Locked down query types - no index signature
interface StrictQuery {
  name?: string
  age?: number
  // No [key: string]: unknown - this query is locked down
}

interface PaginatedQuery {
  category?: string
  completed?: boolean
  $limit?: number
  $skip?: number
  $sort?: Record<string, 1 | -1>
  // No [key: string]: unknown - still locked down but includes pagination
}

interface MinimalQuery {
  searchTerm?: string
  // No pagination fields, no index signature
}

// Test items
interface Person {
  id: string
  name: string
  age: number
}

interface Todo {
  id: string
  title: string
  category: string
  completed: boolean
}

interface Note {
  id: string
  content: string
  searchTerm?: string
}

test('locked-down query types work correctly', async t => {
  const schema = createSchema({
    services: {
      people: service<{
        item: Person
        query: StrictQuery
      }>(),
      todos: service<{
        item: Todo
        query: PaginatedQuery
      }>(),
      notes: service<{
        item: Note
        query: MinimalQuery
      }>(),
    },
  })

  const feathers = mockFeathers({
    people: {
      data: {
        '1': { id: '1', name: 'Alice', age: 30 },
        '2': { id: '2', name: 'Bob', age: 25 },
      },
    },
    todos: {
      data: {
        '1': { id: '1', title: 'Task 1', category: 'work', completed: false },
        '2': { id: '2', title: 'Task 2', category: 'personal', completed: true },
      },
    },
    notes: {
      data: {
        '1': { id: '1', content: 'Note 1', searchTerm: 'important' },
        '2': { id: '2', content: 'Note 2' },
      },
    },
  })

  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ adapter, schema })

  // Test 1: Strict queries work without pagination
  // Note: The mock doesn't actually filter by query fields - it returns all items.
  // This is a limitation of the test mock, not the actual library.
  // In production, the server would handle the filtering.
  const peopleQuery = figbird.query({
    serviceName: 'people',
    method: 'find',
    params: {
      query: {
        // The following would cause a type error if uncommented:
        // unknownField: 'not allowed', // Type error: not in StrictQuery
        // $limit: 10, // Type error: not in StrictQuery
      },
    },
  })

  const peopleUnsubscribe = peopleQuery.subscribe(state => {
    if (state.status === 'success') {
      t.is(state.data.length, 2)
      t.truthy(state.data.find(p => p.name === 'Alice'))
      t.truthy(state.data.find(p => p.name === 'Bob'))
    }
  })

  // Wait for the query to complete
  await new Promise(resolve => setTimeout(resolve, 50))
  peopleUnsubscribe()

  // Test 2: Paginated queries work with pagination fields
  // Note: The mock doesn't actually filter by query fields - it returns all items.
  const todosQuery = figbird.query({
    serviceName: 'todos',
    method: 'find',
    params: {
      query: {
        category: 'work',
        $limit: 10,
        $skip: 0,
        $sort: { title: 1 },
        // The following would cause a type error if uncommented:
        // unknownField: 'not allowed', // Type error: not in PaginatedQuery
      },
    },
  })

  const todosUnsubscribe = todosQuery.subscribe(state => {
    if (state.status === 'success') {
      t.is(state.data.length, 2) // Mock returns all items
      t.truthy(state.data.find(t => t.category === 'work'))
      t.truthy(state.data.find(t => t.category === 'personal'))
    }
  })

  await new Promise(resolve => setTimeout(resolve, 50))
  todosUnsubscribe()

  // Test 3: Minimal queries work without any extras
  // Note: The mock doesn't actually filter by query fields - it returns all items.
  const notesQuery = figbird.query({
    serviceName: 'notes',
    method: 'find',
    params: {
      query: {
        searchTerm: 'important',
        // The following would cause a type error if uncommented:
        // $limit: 10, // Type error: not in MinimalQuery
        // unknownField: 'not allowed', // Type error: not in MinimalQuery
      },
    },
  })

  const notesUnsubscribe = notesQuery.subscribe(state => {
    if (state.status === 'success') {
      t.is(state.data.length, 2) // Mock returns all items
      t.truthy(state.data.find(n => n.searchTerm === 'important'))
      t.truthy(state.data.find(n => !n.searchTerm))
    }
  })

  await new Promise(resolve => setTimeout(resolve, 50))
  notesUnsubscribe()
})

// Note: We no longer test for runtime errors since TypeScript prevents misuse at compile time
// The server will reject invalid query fields if someone bypasses TypeScript

test('allPages works correctly with proper pagination fields', async t => {
  const schema = createSchema({
    services: {
      todos: service<{
        item: Todo
        query: PaginatedQuery
      }>(),
    },
  })

  // Create 10 items for pagination testing
  const data: Record<string, Todo> = {}
  for (let i = 1; i <= 10; i++) {
    data[String(i)] = {
      id: String(i),
      title: `Task ${i}`,
      category: 'work',
      completed: false,
    }
  }

  const feathers = mockFeathers({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    todos: { data: data as any },
  })

  const adapter = new FeathersAdapter(feathers, {
    defaultPageSizeWhenFetchingAll: 3, // Small page size for testing
  })
  const figbird = new Figbird({ adapter, schema })

  const query = figbird.query(
    {
      serviceName: 'todos',
      method: 'find',
      params: {
        query: {
          category: 'work',
        } as PaginatedQuery,
      },
    },
    {
      allPages: true,
    },
  )

  const unsubscribe = query.subscribe(state => {
    if (state.status === 'success') {
      t.is(state.data.length, 10, 'Should fetch all 10 items across multiple pages')
      t.is(state.data[0]?.title, 'Task 1')
      t.is(state.data[9]?.title, 'Task 10')
    }
  })

  await new Promise(resolve => setTimeout(resolve, 100))
  unsubscribe()
})

test('React hooks work with locked-down query types', async t => {
  const { $all, render, unmount, flush } = dom()

  const schema = createSchema({
    services: {
      people: service<{
        item: Person
        query: StrictQuery
      }>(),
    },
  })

  const feathers = mockFeathers({
    people: {
      data: {
        '1': { id: '1', name: 'Alice', age: 30 },
        '2': { id: '2', name: 'Bob', age: 25 },
      },
    },
  })

  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ adapter, schema })
  const { useFind } = createHooks(figbird)

  function Component() {
    // Note: The mock doesn't actually filter by query fields - it returns all items.
    // In production, the server would handle the filtering.
    const people = useFind('people', {
      query: {
        // The following would cause a type error if uncommented:
        // unknownField: 'not allowed', // Type error: not in StrictQuery
        // $limit: 10, // Type error: not in StrictQuery
      },
    })

    if (people.status === 'loading') {
      return <div>Loading...</div>
    }

    if (people.status === 'success' && people.data) {
      return (
        <div>
          {people.data.map(person => (
            <div key={person.id} className='person'>
              {person.name} (age: {person.age})
            </div>
          ))}
        </div>
      )
    }

    return null
  }

  render(
    <FigbirdProvider figbird={figbird}>
      <Component />
    </FigbirdProvider>,
  )

  await flush()

  const personElements = $all('.person')
  t.is(personElements.length, 2) // Mock returns all items
  t.truthy(personElements.find(el => el.textContent?.includes('Alice (age: 30)')))
  t.truthy(personElements.find(el => el.textContent?.includes('Bob (age: 25)')))

  unmount()
})
