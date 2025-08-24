import test from 'ava'
import { useEffect, useState } from 'react'
import {
  FeathersAdapter,
  Figbird,
  FigbirdProvider,
  service,
  useFigbird,
  useFind,
  useGet,
  useMutation,
} from '../lib'
import { dom, mockFeathers } from './helpers'

// Define typed entities
interface Person {
  id: string
  name: string
  email: string
  age?: number
  role: 'admin' | 'user'
  [key: string]: unknown
}

interface Task {
  id: string
  title: string
  completed: boolean
  assigneeId?: string
  priority: number
  tags: string[]
  [key: string]: unknown
}

interface Project {
  id: string
  name: string
  description: string
  ownerId: string
  status: 'active' | 'archived' | 'draft'
  [key: string]: unknown
}

// Custom query extensions for specific services
interface TaskQuery {
  $search?: string
  $asOf?: Date
  [key: string]: unknown
}

// Define schema with typed services
const schema = {
  services: [
    service<Person>('api/people'),
    service<Task, TaskQuery>('api/tasks'),
    service<Project>('api/projects'),
  ],
} as const

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

  function PersonList() {
    // Type is inferred as QueryResult<Person[]>
    const people = useFind<AppSchema, 'api/people'>('api/people')

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

    if (!people.data) return <div>Loading...</div>

    return (
      <div>
        {people.data.map(person => (
          <div key={(person as Person).id} className='person'>
            {(person as Person).name} - {(person as Person).role}
          </div>
        ))}
      </div>
    )
  }

  function TaskDetail() {
    // Type is inferred as QueryResult<Task>
    const task = useGet<AppSchema, 'api/tasks'>('api/tasks', 't1')

    if (!task.data) return <div>Loading...</div>

    // TypeScript knows all the Task properties
    const taskData = task.data as Task
    return (
      <div className='task'>
        <h3>{taskData.title}</h3>
        <p>Priority: {taskData.priority}</p>
        <p>Tags: {taskData.tags.join(', ')}</p>
        <p>Status: {taskData.completed ? 'Done' : 'Pending'}</p>
      </div>
    )
  }

  function TaskManager() {
    const { create, update, patch, remove } = useMutation<AppSchema, 'api/tasks'>('api/tasks')
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
    const tasks = useFind<AppSchema, 'api/tasks'>('api/tasks', {
      query: {
        completed: false,
        priority: 1,
        // Custom query extension is recognized
        $search: 'urgent',
        $asOf: new Date('2024-01-01'),
      },
    })

    return <div>{tasks.data ? `Found ${tasks.data.length} tasks` : 'Loading...'}</div>
  }

  function DirectQueryUsage() {
    const figbird = useFigbird<AppSchema>()
    const [people, setPeople] = useState<Person[] | null>(null)

    useEffect(() => {
      // Direct query API is also typed
      const query = figbird.query<Person[]>({
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

  // Services are defined in an array
  const schema = {
    services: [service<Person>('api/people'), service<Task>('api/tasks')],
  } as const

  type AppSchema = typeof schema

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

  function App() {
    // Use the actual service names
    const people = useFind<AppSchema, 'api/people'>('api/people')
    const tasks = useFind<AppSchema, 'api/tasks'>('api/tasks')

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
        <div className='note-content'>{(note.data as any)?.content ?? 'Loading...'}</div>
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
  type PersonService = (typeof schema.services)[0]
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
  type TaskService = (typeof schema.services)[1]
  type TaskQueryType = import('../lib').Query<TaskService>

  const query: TaskQueryType = {
    $search: 'test',
    $asOf: new Date(),
  } as TaskQueryType

  t.truthy((query as any).$search)
  t.truthy((query as any).$asOf)
})
