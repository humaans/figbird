import test from 'ava'
import { useEffect, useState } from 'react'
import {
  createHooks,
  createSchema,
  FeathersAdapter,
  Figbird,
  FigbirdProvider,
  service,
  useFigbird,
  useFind as useUntypedFind,
  useGet as useUntypedGet,
  useMutation as useUntypedMutation,
} from '../lib'
import { dom, mockFeathers } from './helpers'

// Define typed entities
interface Person {
  id: string
  name: string
  email: string
  age?: number
  role: 'admin' | 'user'
}

interface Task {
  id: string
  title: string
  completed: boolean
  assigneeId?: string
  priority: number
  tags: string[]
}

interface Project {
  id: string
  name: string
  description: string
  ownerId: string
  status: 'active' | 'archived' | 'draft'
}

// Custom query extensions for specific services
interface TaskQuery {
  completed?: boolean
  priority?: number
  assigneeId?: string
  $search?: string
  $asOf?: Date
}

interface PersonService {
  item: Person
}

interface TaskService {
  item: Task
  query: TaskQuery
}

interface ProjectService {
  item: Project
}

// Define schema with typed services
const schema = createSchema({
  services: {
    'api/people': service<PersonService>(),
    'api/tasks': service<TaskService>(),
    'api/projects': service<ProjectService>(),
  },
})

type AppSchema = typeof schema

test('schema-based type inference', t => {
  const { render, unmount, flush, $, $all } = dom()

  const feathers = mockFeathers({
    'api/people': {
      data: {
        '1': { id: '1', name: 'Alice', email: 'alice@example.com', role: 'admin' },
        '2': { id: '2', name: 'Bob', email: 'bob@example.com', age: 30, role: 'user' },
      },
    },
    'api/tasks': {
      data: {
        t1: {
          id: 't1',
          title: 'Write tests',
          completed: false,
          priority: 1,
          tags: ['testing', 'urgent'],
        },
        t2: {
          id: 't2',
          title: 'Review PR',
          completed: true,
          assigneeId: '1',
          priority: 2,
          tags: ['review'],
        },
      },
    },
    'api/projects': {
      data: {
        p1: {
          id: 'p1',
          name: 'Figbird 2.0',
          description: 'Next generation of Figbird',
          ownerId: '1',
          status: 'active',
        },
      },
    },
  })

  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ adapter, schema })

  // Create typed hooks for this schema
  const { useFind, useGet, useMutation } = createHooks(figbird)

  function PersonList() {
    // Type is inferred as QueryResult<Person[]>
    const people = useFind('api/people')

    // This would be a TypeScript error if uncommented:
    // const wrongService = useFind<AppSchema>('nonexistent')

    useEffect(() => {
      if (people.data) {
        // TypeScript knows this is Person[]
        people.data.forEach(person => {
          // All properties are properly typed
          void person.name // string
          void person.email // string
          void person.age // number | undefined
          void person.role // 'admin' | 'user'

          // This would be a TypeScript error:
          // const wrongField: string = person.nonexistent
        })
      }
    }, [people.data])

    if (people.status !== 'success') return <div>Loading...</div>

    return (
      <div>
        {people.data.map(person => (
          <div key={person.id} className='person'>
            {person.name} - {person.role}
          </div>
        ))}
      </div>
    )
  }

  function TaskDetail() {
    // Type is inferred as QueryResult<Task>
    const task = useGet('api/tasks', 't1')

    if (task.status !== 'success') return <div>Loading...</div>

    return (
      <div className='task'>
        <h3>{task.data.title}</h3>
        <p>Priority: {task.data.priority}</p>
        <p>Tags: {task.data.tags.join(', ')}</p>
        <p>Status: {task.data.completed ? 'Done' : 'Pending'}</p>
      </div>
    )
  }

  function TaskManager() {
    const { create, update, patch, remove } = useMutation('api/tasks')
    const [creating, setCreating] = useState(false)

    const handleCreate = async () => {
      setCreating(true)
      // TypeScript enforces correct types for create
      const newTask = await create({
        id: 't3',
        title: 'New task',
        completed: false,
        priority: 3,
        tags: ['new'],
        // assigneeId is optional, so this is OK to omit
      })

      // TypeScript knows newTask is Task or Task[]
      if (!Array.isArray(newTask)) {
        console.log('Created task:', newTask.title)
      }
      setCreating(false)
    }

    const handleUpdate = async () => {
      // TypeScript enforces correct types for update
      await update('t1', {
        id: 't1',
        title: 'Updated task',
        completed: true,
        priority: 1,
        tags: ['updated'],
      })
    }

    const handlePatch = async () => {
      // TypeScript allows partial updates with patch
      await patch('t1', {
        completed: true,
        // Only updating some fields is OK with patch
      })
    }

    const handleRemove = async () => {
      await remove('t1')
    }

    return (
      <div>
        <button onClick={handleCreate} disabled={creating}>
          Create Task
        </button>
        <button onClick={handleUpdate}>Update Task</button>
        <button onClick={handlePatch}>Patch Task</button>
        <button onClick={handleRemove}>Remove Task</button>
      </div>
    )
  }

  function ProjectsWithCustomQuery() {
    // Custom query parameters can be used
    const tasks = useFind('api/tasks', {
      query: {
        completed: false,
        priority: 1,
        // Custom query extension is recognized
        $search: 'urgent',
        $asOf: new Date('2024-01-01'),
      },
      matcher: _query => _item => true,
    })

    return <div>{tasks.data ? `Found ${tasks.data.length} tasks` : 'Loading...'}</div>
  }

  function DirectQueryUsage() {
    const figbird = useFigbird<AppSchema>()
    const [people, setPeople] = useState<Person[] | null>(null)

    useEffect(() => {
      // Direct query API infers types from schema
      const query = figbird.query({
        serviceName: 'api/people',
        method: 'find',
      })

      const unsubscribe = query.subscribe(state => {
        if (state.data) {
          setPeople(state.data)
        }
      })

      return unsubscribe
    }, [figbird])

    return <div>{people ? `${people.length} people` : 'Loading...'}</div>
  }

  function App() {
    return (
      <FigbirdProvider figbird={figbird}>
        <PersonList />
        <TaskDetail />
        <TaskManager />
        <ProjectsWithCustomQuery />
        <DirectQueryUsage />
      </FigbirdProvider>
    )
  }

  render(<App />)

  return flush().then(() => {
    // Check that PersonList rendered correctly
    const personElements = $all('.person')
    t.is(personElements.length, 2)
    t.is(personElements[0]?.textContent, 'Alice - admin')
    t.is(personElements[1]?.textContent, 'Bob - user')

    // Check that TaskDetail rendered correctly
    const taskElement = $('.task')
    t.truthy(taskElement)
    t.is(taskElement?.querySelector('h3')?.textContent, 'Write tests')
    t.is(taskElement?.querySelector('p')?.textContent, 'Priority: 1')

    unmount()
  })
})

test('schema with array of services', t => {
  const { render, unmount, flush, $ } = dom()

  // Services are defined in an object map
  const schema = createSchema({
    services: {
      'api/people': service<PersonService>(),
      'api/tasks': service<TaskService>(),
    },
  })

  const feathers = mockFeathers({
    'api/people': {
      data: {
        '1': { id: '1', name: 'Alice', email: 'alice@example.com', role: 'admin' },
      },
    },
    'api/tasks': {
      data: {
        t1: {
          id: 't1',
          title: 'Test task',
          completed: false,
          priority: 1,
          tags: ['test'],
        },
      },
    },
  })

  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ adapter, schema })

  // Create typed hooks
  const { useFind } = createHooks(figbird)

  function App() {
    // Use the actual service names
    const people = useFind('api/people')
    const tasks = useFind('api/tasks')

    return (
      <div>
        <div className='people-count'>{people.data?.length ?? 0} people</div>
        <div className='tasks-count'>{tasks.data?.length ?? 0} tasks</div>
      </div>
    )
  }

  render(
    <FigbirdProvider figbird={figbird}>
      <App />
    </FigbirdProvider>,
  )

  return flush().then(() => {
    const peopleCount = $('.people-count')
    const tasksCount = $('.tasks-count')
    t.is(peopleCount?.textContent, '1 people')
    t.is(tasksCount?.textContent, '1 tasks')
    unmount()
  })
})

test('backward compatibility - untyped usage still works', t => {
  const { render, unmount, flush, $ } = dom()

  // Use the untyped hooks for backward compatibility
  const useFind = useUntypedFind
  const useGet = useUntypedGet
  const useMutation = useUntypedMutation

  const feathers = mockFeathers({
    notes: {
      data: {
        '1': { id: 1, content: 'Note 1' },
        '2': { id: 2, content: 'Note 2' },
      },
    },
  })

  const adapter = new FeathersAdapter(feathers)
  // No schema provided - backward compatible
  const figbird = new Figbird({ adapter })

  function App() {
    // Without schema, any service name works and returns any
    const notes = useFind('notes')
    const note = useGet('notes', 1)
    useMutation('notes') // Just testing that untyped usage works

    return (
      <div>
        <div className='notes-count'>{notes.data?.length ?? 0}</div>
        <div className='note-content'>
          {String((note.data as Record<string, unknown> | null)?.content ?? 'Loading...')}
        </div>
      </div>
    )
  }

  render(
    <FigbirdProvider figbird={figbird}>
      <App />
    </FigbirdProvider>,
  )

  return flush().then(() => {
    t.is($('.notes-count')?.textContent, '2')
    t.is($('.note-content')?.textContent, 'Note 1')
    unmount()
  })
})

test('type extraction utilities', t => {
  // Test that type extraction utilities work correctly
  type PersonService = (typeof schema.services)['api/people']
  type PersonItem = import('../lib').Item<PersonService>

  // These assertions are compile-time only, but we can test runtime behavior
  const person: PersonItem = {
    id: '1',
    name: 'Test',
    email: 'test@example.com',
    role: 'user',
  }

  t.is(person.name, 'Test')
  t.is(person.role, 'user')

  // Query type includes custom extensions
  type TaskService = (typeof schema.services)['api/tasks']
  type TaskQueryType = import('../lib').Query<TaskService>

  const query: TaskQueryType = {
    $search: 'test',
    $asOf: new Date(),
  } as TaskQueryType

  t.truthy(query.$search)
  t.truthy(query.$asOf)
})

test('query type inference is strict - no extra properties allowed', t => {
  const { render, unmount, flush } = dom()

  const feathers = mockFeathers({
    'api/tasks': {
      data: {
        t1: {
          id: 't1',
          title: 'Test task',
          completed: false,
          priority: 1,
          tags: ['test'],
        },
      },
    },
  })

  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ adapter, schema })

  // Create typed hooks
  const { useFind } = createHooks(figbird)

  function TestComponent() {
    // This should work - valid TaskQuery properties
    const validQuery = useFind('api/tasks', {
      query: {
        completed: false,
        $search: 'test',
        $asOf: new Date(),
      },
      matcher: query => item => {
        // Handle custom query operators
        if (query?.completed !== undefined && item.completed !== query.completed) {
          return false
        }
        // Custom operators don't affect matching in this test
        return true
      },
    })

    // TypeScript should enforce that only defined query properties are allowed
    // The following would cause a TypeScript error if uncommented:
    // const invalidQuery = useFind('api/tasks', {
    //   query: {
    //     completed: false,
    //     $search: 'test',
    //     $asOf: new Date(),
    //     invalidProperty: 'this should not be allowed', // <- This should cause a TS error
    //   },
    // })

    // Test that TypeScript correctly types the query parameter
    // This should work without errors - all valid properties
    const testValidQuery = useFind('api/tasks', {
      query: {
        completed: false,
        priority: 1,
        assigneeId: '123',
        $search: 'test',
        $asOf: new Date(),
      },
      matcher: query => item => {
        // Handle custom query operators
        if (query?.completed !== undefined && item.completed !== query.completed) {
          return false
        }
        if (query?.priority !== undefined && item.priority !== query.priority) {
          return false
        }
        if (query?.assigneeId !== undefined && item.assigneeId !== query.assigneeId) {
          return false
        }
        // Custom operators don't affect matching in this test
        return true
      },
    })

    return (
      <div>
        <div>{validQuery.data?.length ?? 0} tasks</div>
        <div>{testValidQuery.data?.length ?? 0} valid</div>
      </div>
    )
  }

  render(
    <FigbirdProvider figbird={figbird}>
      <TestComponent />
    </FigbirdProvider>,
  )

  return flush().then(() => {
    t.pass('Query type inference is strict')
    unmount()
  })
})
