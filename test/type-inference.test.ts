import test from 'ava'
import { randomBytes } from 'crypto'
import { existsSync, unlinkSync, writeFileSync } from 'fs'
import * as os from 'os'
import { join } from 'path'
import * as ts from 'typescript'

// Helper to get type at a specific position in source code
function getTypeAtPosition(
  source: string,
  marker: string,
  tsConfigOptions: ts.CompilerOptions = {},
): string {
  // Create a temporary file
  const tempFile = join(os.tmpdir(), `figbird-test-${randomBytes(16).toString('hex')}.ts`)
  writeFileSync(tempFile, source)

  try {
    // Create a TypeScript program
    const program = ts.createProgram([tempFile], {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
      skipLibCheck: true,
      ...tsConfigOptions,
    })

    const sourceFile = program.getSourceFile(tempFile)
    if (!sourceFile) throw new Error('Source file not found')

    const checker = program.getTypeChecker()

    // Find the marker position
    const markerIndex = source.indexOf(marker)
    if (markerIndex === -1) throw new Error(`Marker "${marker}" not found in source`)

    // Find the identifier at the marker position
    const position = markerIndex + marker.length - 1

    function findNodeAtPosition(node: ts.Node): ts.Node | undefined {
      if (position >= node.pos && position <= node.end) {
        return ts.forEachChild(node, findNodeAtPosition) || node
      }
      return undefined
    }

    const node = findNodeAtPosition(sourceFile)
    if (!node) throw new Error('No node found at position')

    // Get the type at this location
    const type = checker.getTypeAtLocation(node)
    return checker.typeToString(type, node, ts.TypeFormatFlags.NoTruncation)
  } finally {
    // Clean up temp file
    if (existsSync(tempFile)) {
      unlinkSync(tempFile)
    }
  }
}

test('type inference - useFind narrows to specific service type', t => {
  const source = `
import { createHooks, createSchema, service } from '../lib'

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
  priority: number
  tags: string[]
  [key: string]: unknown
}

interface Project {
  id: string
  name: string
  description: string
  status: 'active' | 'archived' | 'draft'
  [key: string]: unknown
}

const schema = createSchema({
  services: [
    service<Person>('api/people'),
    service<Task>('api/tasks'),
    service<Project>('api/projects'),
  ],
})

type AppSchema = typeof schema
const { useFind, useGet, useMutation } = createHooks<AppSchema>()

// Test variables whose types we'll check
const people = useFind('api/people')
const tasks = useFind('api/tasks')
const projects = useFind('api/projects')
const person = useGet('api/people', '1')
const task = useGet('api/tasks', 't1')
const peopleMutation = useMutation('api/people')
`

  // Check useFind types
  const peopleType = getTypeAtPosition(source, 'const people')
  t.true(
    peopleType.includes('QueryResult<Person[]>'),
    `Expected people type to include QueryResult<Person[]>, got: ${peopleType}`,
  )
  t.false(
    peopleType.includes('Task') || peopleType.includes('Project'),
    `people type should not include Task or Project types, got: ${peopleType}`,
  )

  const tasksType = getTypeAtPosition(source, 'const tasks')
  t.true(
    tasksType.includes('QueryResult<Task[]>'),
    `Expected tasks type to include QueryResult<Task[]>, got: ${tasksType}`,
  )
  t.false(
    tasksType.includes('Person') || tasksType.includes('Project'),
    `tasks type should not include Person or Project types, got: ${tasksType}`,
  )

  const projectsType = getTypeAtPosition(source, 'const projects')
  t.true(
    projectsType.includes('QueryResult<Project[]>'),
    `Expected projects type to include QueryResult<Project[]>, got: ${projectsType}`,
  )
  t.false(
    projectsType.includes('Person') || projectsType.includes('Task'),
    `projects type should not include Person or Task types, got: ${projectsType}`,
  )

  // Check useGet types
  const personType = getTypeAtPosition(source, 'const person')
  t.true(
    personType.includes('QueryResult<Person>'),
    `Expected person type to include QueryResult<Person>, got: ${personType}`,
  )
  t.false(
    personType.includes('Task') || personType.includes('Project'),
    `person type should not include Task or Project types, got: ${personType}`,
  )

  const taskType = getTypeAtPosition(source, 'const task')
  t.true(
    taskType.includes('QueryResult<Task>'),
    `Expected task type to include QueryResult<Task>, got: ${taskType}`,
  )
  t.false(
    taskType.includes('Person') || taskType.includes('Project'),
    `task type should not include Person or Project types, got: ${taskType}`,
  )

  // Check useMutation types
  const mutationType = getTypeAtPosition(source, 'const peopleMutation')
  t.true(
    mutationType.includes('UseMutationResult<Person'),
    `Expected peopleMutation type to include UseMutationResult<Person, got: ${mutationType}`,
  )
})

test('type inference - data property has correct type', t => {
  const source = `
import { createHooks, createSchema, service } from '../lib'

interface Person {
  id: string
  name: string
  email: string
  role: 'admin' | 'user'
  [key: string]: unknown
}

interface Task {
  id: string
  title: string
  completed: boolean
  tags: string[]
  [key: string]: unknown
}

const schema = createSchema({
  services: [
    service<Person>('api/people'),
    service<Task>('api/tasks'),
  ],
})

type AppSchema = typeof schema
const { useFind } = createHooks<AppSchema>()

const people = useFind('api/people')
const peopleData = people.data
const tasks = useFind('api/tasks')
const tasksData = tasks.data
`

  // Check that people.data is Person[] | null
  const peopleDataType = getTypeAtPosition(source, 'const peopleData')
  t.true(
    peopleDataType.includes('Person[]') && peopleDataType.includes('null'),
    `Expected people.data to be Person[] | null, got: ${peopleDataType}`,
  )
  t.false(
    peopleDataType.includes('Task'),
    `people.data should not include Task type, got: ${peopleDataType}`,
  )

  // Check that tasks.data is Task[] | null
  const tasksDataType = getTypeAtPosition(source, 'const tasksData')
  t.true(
    tasksDataType.includes('Task[]') && tasksDataType.includes('null'),
    `Expected tasks.data to be Task[] | null, got: ${tasksDataType}`,
  )
  t.false(
    tasksDataType.includes('Person'),
    `tasks.data should not include Person type, got: ${tasksDataType}`,
  )
})

test('type inference - invalid service names cause errors', t => {
  const source = `
import { createHooks, createSchema, service } from '../lib'

interface Person {
  id: string
  name: string
  [key: string]: unknown
}

const schema = createSchema({
  services: [
    service<Person>('api/people'),
  ],
})

type AppSchema = typeof schema
const { useFind } = createHooks<AppSchema>()

// This should cause a type error
const invalid = useFind('api/invalid-service')
`

  // Create a temporary file
  const tempFile = join(os.tmpdir(), `figbird-test-${randomBytes(16).toString('hex')}.ts`)
  writeFileSync(tempFile, source)

  try {
    // Create a TypeScript program
    const program = ts.createProgram([tempFile], {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
      skipLibCheck: true,
    })

    // Get diagnostics
    const diagnostics = ts.getPreEmitDiagnostics(program)
    const errors = diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error)

    // Should have at least one error about the invalid service name
    t.true(
      errors.some(e => {
        const message = ts.flattenDiagnosticMessageText(e.messageText, '\n')
        return message.includes('api/invalid-service') || message.includes('Argument of type')
      }),
      'Should have a type error for invalid service name',
    )
  } finally {
    // Clean up temp file
    if (existsSync(tempFile)) {
      unlinkSync(tempFile)
    }
  }
})

test('type inference - service query extensions work correctly', t => {
  const source = `
import { createHooks, createSchema, service } from '../lib'

interface Task {
  id: string
  title: string
  [key: string]: unknown
}

interface TaskQuery {
  $search?: string
  $asOf?: Date
}

const schema = createSchema({
  services: [
    service<Task, TaskQuery>('api/tasks'),
  ],
})

type AppSchema = typeof schema
const { useFind } = createHooks<AppSchema>()

// Should accept custom query parameters
const tasks = useFind('api/tasks', {
  query: {
    $search: 'test',
    $asOf: new Date(),
  }
})
`

  // This should compile without errors
  const tempFile = join(os.tmpdir(), `figbird-test-${randomBytes(16).toString('hex')}.ts`)
  writeFileSync(tempFile, source)

  try {
    const program = ts.createProgram([tempFile], {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
      skipLibCheck: true,
    })

    const diagnostics = ts.getPreEmitDiagnostics(program)
    const errors = diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error)

    // Should compile without errors
    t.is(errors.length, 0, 'Should compile without errors when using custom query parameters')
  } finally {
    if (existsSync(tempFile)) {
      unlinkSync(tempFile)
    }
  }
})
