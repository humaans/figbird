import test from 'ava'
import { dirname, join } from 'path'
import { getTypeAtPosition } from './type-helpers'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, 'fixtures', 'typed-feathers-client.ts')

// ========================================
// CRUD method type tests
// ========================================

test('typed feathers client - get returns Note', t => {
  const type = getTypeAtPosition(fixturePath, 'NotesGetResult')
  t.is(type, 'Note')
})

test('typed feathers client - find returns Note array or paginated', t => {
  const type = getTypeAtPosition(fixturePath, 'NotesFindResult')
  // find can return either an array or a paginated result
  t.true(
    type.includes('Note[]') || type.includes('data: Note[]'),
    `Expected find to return Note[] or paginated result, got: ${type}`,
  )
})

test('typed feathers client - create returns Note or Note[]', t => {
  const type = getTypeAtPosition(fixturePath, 'NotesCreateResult')
  // create can return Note or Note[] depending on overload
  t.true(
    type === 'Note' || type === 'Note[]' || type === 'Note | Note[]',
    `Expected Note, Note[], or Note | Note[], got: ${type}`,
  )
})

test('typed feathers client - update returns Note', t => {
  const type = getTypeAtPosition(fixturePath, 'NotesUpdateResult')
  t.is(type, 'Note')
})

test('typed feathers client - patch returns Note', t => {
  const type = getTypeAtPosition(fixturePath, 'NotesPatchResult')
  t.is(type, 'Note')
})

test('typed feathers client - remove returns Note', t => {
  const type = getTypeAtPosition(fixturePath, 'NotesRemoveResult')
  t.is(type, 'Note')
})

// ========================================
// Custom methods tests
// ========================================

test('typed feathers client - archive custom method returns correct type', t => {
  const type = getTypeAtPosition(fixturePath, 'NotesArchiveResult')
  t.is(type, '{ count: number; }')
})

test('typed feathers client - search custom method returns correct type', t => {
  const type = getTypeAtPosition(fixturePath, 'NotesSearchResult')
  t.is(type, 'Note[]')
})

// ========================================
// Service type narrowing tests
// ========================================

test('typed feathers client - tasks service returns Task type', t => {
  const type = getTypeAtPosition(fixturePath, 'TasksGetResult')
  t.is(type, 'Task')
})

test('typed feathers client - service types are correctly narrowed and distinct', t => {
  const notesType = getTypeAtPosition(fixturePath, 'NotesServiceType')
  const tasksType = getTypeAtPosition(fixturePath, 'TasksServiceType')

  // Types should be different - each service should have its own typed methods
  t.not(notesType, tasksType, 'Notes and Tasks service types should be distinct')

  // Notes service should include Note type
  t.true(notesType.includes('Note'), `Notes service type should include Note, got: ${notesType}`)

  // Tasks service should include Task type
  t.true(tasksType.includes('Task'), `Tasks service type should include Task, got: ${tasksType}`)
})
