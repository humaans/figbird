import type { FeathersClient } from '../../lib'
import { createHooks, createSchema, FeathersAdapter, Figbird, service } from '../../lib'

// Test typed Feathers client with CRUD methods
interface Note {
  id: string
  title: string
  content: string
}

interface CreateNote {
  title: string
  content?: string
}

interface PatchNote {
  title?: string
  content?: string
}

interface NoteQuery {
  search?: string
  $limit?: number
}

interface NotesService {
  item: Note
  create: CreateNote
  patch: PatchNote
  query: NoteQuery
  methods: {
    archive: (ids: string[]) => Promise<{ count: number }>
    search: (term: string, limit?: number) => Promise<Note[]>
  }
}

// Service without custom types (uses defaults)
interface Task {
  id: string
  title: string
  done: boolean
}

interface TaskService {
  item: Task
}

export const schema = createSchema({
  services: {
    notes: service<NotesService>(),
    tasks: service<TaskService>(),
  },
})

// Create Figbird instance
const feathers = {} as FeathersClient
const adapter = new FeathersAdapter(feathers)
const figbird = new Figbird({ schema, adapter })

// Create typed hooks including useFeathers
const { useFeathers } = createHooks(figbird)

// Get typed feathers client
const typedFeathers = useFeathers()

// Get notes service
// oxlint-disable-next-line @typescript-eslint/no-unused-vars
const _notesService = typedFeathers.service('notes')

// Get tasks service
// oxlint-disable-next-line @typescript-eslint/no-unused-vars
const _tasksService = typedFeathers.service('tasks')

// ========================================
// Type exports for CRUD methods on notes
// ========================================

// get returns Note
export type NotesGetResult = Awaited<ReturnType<typeof _notesService.get>>

// find returns array of Notes (or paginated)
export type NotesFindResult = Awaited<ReturnType<typeof _notesService.find>>

// create returns Note
export type NotesCreateResult = Awaited<ReturnType<typeof _notesService.create>>

// update returns Note
export type NotesUpdateResult = Awaited<ReturnType<typeof _notesService.update>>

// patch returns Note
export type NotesPatchResult = Awaited<ReturnType<typeof _notesService.patch>>

// remove returns Note
export type NotesRemoveResult = Awaited<ReturnType<typeof _notesService.remove>>

// ========================================
// Type exports for tasks
// ========================================

export type TasksGetResult = Awaited<ReturnType<typeof _tasksService.get>>

// ========================================
// Custom methods type exports
// ========================================

// archive returns { count: number }
export type NotesArchiveResult = Awaited<ReturnType<typeof _notesService.archive>>

// search returns Note[]
export type NotesSearchResult = Awaited<ReturnType<typeof _notesService.search>>

// ========================================
// Test service type is correctly narrowed
// ========================================

// The typed client should narrow based on service name
export type NotesServiceType = typeof _notesService
export type TasksServiceType = typeof _tasksService
