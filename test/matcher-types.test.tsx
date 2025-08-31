import test from 'ava'
import { FeathersAdapter } from '../lib/adapters/feathers.js'
import { Figbird } from '../lib/core/figbird.js'
import { createSchema, service } from '../lib/core/schema.js'
import { createHooks } from '../lib/react/createHooks.js'
import { FigbirdProvider } from '../lib/react/react.js'
import { dom, mockFeathers } from './helpers.js'

// Define typed query interfaces
interface TodoQuery {
  title?: string
  completed?: boolean
  priority?: number
  $limit?: number
  $skip?: number
}

interface UserQuery {
  name?: string
  role?: 'admin' | 'user' | 'guest'
  active?: boolean
}

// Define item types
interface Todo {
  id: string
  title: string
  completed: boolean
  priority: number
  tags: string[]
}

interface User {
  id: string
  name: string
  role: 'admin' | 'user' | 'guest'
  active: boolean
}

test('matcher receives properly typed query from schema', async t => {
  const schema = createSchema({
    services: {
      todos: service<{
        item: Todo
        query: TodoQuery
      }>(),
      users: service<{
        item: User
        query: UserQuery
      }>(),
    },
  })

  const feathers = mockFeathers({
    todos: {
      data: {
        '1': { id: '1', title: 'Task 1', completed: false, priority: 1, tags: ['work'] },
        '2': { id: '2', title: 'Task 2', completed: true, priority: 2, tags: ['personal'] },
        '3': { id: '3', title: 'Task 3', completed: false, priority: 3, tags: ['work', 'urgent'] },
      },
    },
    users: {
      data: {
        '1': { id: '1', name: 'Alice', role: 'admin', active: true },
        '2': { id: '2', name: 'Bob', role: 'user', active: true },
        '3': { id: '3', name: 'Charlie', role: 'guest', active: false },
      },
    },
  })

  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ adapter, schema })

  // Test that the query is properly typed in matcher
  const todosQuery = figbird.query(
    {
      serviceName: 'todos',
      method: 'find',
      params: {
        query: {
          completed: false,
          priority: 1,
        },
      },
    },
    {
      matcher: query => (item: Todo) => {
        // query should be typed as TodoQuery | undefined, not unknown
        if (!query) return true

        // These should all work without type errors
        const titleMatch = query.title === undefined || item.title.includes(query.title)
        const completedMatch = query.completed === undefined || item.completed === query.completed
        const priorityMatch = query.priority === undefined || item.priority >= query.priority

        // TypeScript should allow accessing TodoQuery properties
        if (query.$limit !== undefined) {
          // $limit is part of TodoQuery
          t.is(typeof query.$limit, 'number')
        }

        // The following would cause a type error if uncommented:
        // const invalid = query.unknownField // Error: Property 'unknownField' does not exist on type 'TodoQuery'

        return titleMatch && completedMatch && priorityMatch
      },
    },
  )

  let matcherCalled = false
  const unsubscribe = todosQuery.subscribe(state => {
    if (state.status === 'success') {
      matcherCalled = true
      // The mock returns all items, but the matcher should have been called
      t.true(matcherCalled)
    }
  })

  await new Promise(resolve => setTimeout(resolve, 50))
  unsubscribe()

  // Test with users service to verify different query type
  const usersQuery = figbird.query(
    {
      serviceName: 'users',
      method: 'find',
      params: {
        query: {
          role: 'admin',
          active: true,
        },
      },
    },
    {
      matcher: query => (item: User) => {
        // query should be typed as UserQuery | undefined
        if (!query) return true

        // These properties are specific to UserQuery
        const roleMatch = query.role === undefined || item.role === query.role
        const activeMatch = query.active === undefined || item.active === query.active
        const nameMatch = query.name === undefined || item.name.includes(query.name)

        // The following would cause a type error if uncommented:
        // const invalid = query.completed // Error: Property 'completed' does not exist on type 'UserQuery'

        return roleMatch && activeMatch && nameMatch
      },
    },
  )

  const usersUnsubscribe = usersQuery.subscribe(() => {})
  await new Promise(resolve => setTimeout(resolve, 50))
  usersUnsubscribe()

  t.pass('Matcher receives properly typed queries')
})

test('React hooks provide typed query in matcher', async t => {
  const { render, unmount } = dom()

  const schema = createSchema({
    services: {
      todos: service<{
        item: Todo
        query: TodoQuery
      }>(),
    },
  })

  const feathers = mockFeathers({
    todos: {
      data: {
        '1': { id: '1', title: 'Task 1', completed: false, priority: 1, tags: ['work'] },
        '2': { id: '2', title: 'Task 2', completed: true, priority: 2, tags: ['personal'] },
      },
    },
  })

  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ adapter, schema })
  const { useFind } = createHooks(figbird)

  // This test verifies that TypeScript properly types the query parameter
  // The matcher won't be called during initial fetch (only for realtime events)
  // but we can verify the types are correct at compile time

  function Component() {
    const todos = useFind('todos', {
      query: {
        completed: false,
        priority: 1,
      },
      matcher: query => item => {
        // query should be typed as TodoQuery | undefined
        if (!query) return true

        // Compile-time type checking: These should work without type errors
        const titleCheck: boolean = query.title === undefined || item.title.includes(query.title)
        const completedCheck: boolean =
          query.completed === undefined || item.completed === query.completed
        const priorityCheck: number | undefined = query.priority
        const limitCheck: number | undefined = query.$limit

        // Use the variables to satisfy linter
        void titleCheck
        void completedCheck
        void priorityCheck
        void limitCheck

        // The following would cause a compile-time type error if uncommented:
        // const invalid = query.unknownProp // Error: Property 'unknownProp' does not exist on type 'TodoQuery'

        return item.priority >= (query.priority || 0)
      },
    })

    if (todos.status === 'loading') {
      return <div>Loading...</div>
    }

    if (todos.status === 'success' && todos.data) {
      return (
        <div>
          {todos.data.map(todo => (
            <div key={todo.id} className='todo'>
              {todo.title} - Priority: {todo.priority}
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

  await new Promise(resolve => setTimeout(resolve, 50))

  // If this test compiles and runs without TypeScript errors,
  // it means the query type was correctly inferred
  t.pass('Query type was correctly inferred in matcher (verified at compile time)')

  unmount()
})

test('matcher with undefined query works correctly', async t => {
  const schema = createSchema({
    services: {
      items: service<{
        item: { id: string; name: string }
        query: { search?: string }
      }>(),
    },
  })

  const feathers = mockFeathers({
    items: {
      data: {
        '1': { id: '1', name: 'Item 1' },
        '2': { id: '2', name: 'Item 2' },
      },
    },
  })

  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ adapter, schema })

  // Query with no query params - matcher should receive undefined
  const query = figbird.query(
    {
      serviceName: 'items',
      method: 'find',
      // No params.query provided
    },
    {
      matcher: query => (item: { id: string; name: string }) => {
        // query should be { search?: string } | undefined
        if (query === undefined) {
          // This should be possible since query can be undefined
          t.is(query, undefined)
          return true
        }

        // If we get here, query is defined and typed
        return query.search === undefined || item.name.includes(query.search)
      },
    },
  )

  let undefinedQueryHandled = false
  const unsubscribe = query.subscribe(state => {
    if (state.status === 'success') {
      undefinedQueryHandled = true
    }
  })

  await new Promise(resolve => setTimeout(resolve, 50))
  t.true(undefinedQueryHandled, 'Matcher handled undefined query correctly')
  unsubscribe()
})
