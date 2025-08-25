/**
 * Test fixture demonstrating automatic meta type inference from Figbird instance
 * This shows the improved DX where we don't need to manually pass FeathersFindMeta
 */

import type { FeathersClient } from '../../lib'
import { createHooks, createSchema, FeathersAdapter, Figbird, service } from '../../lib'

// Define domain types
interface Task {
  id: string
  title: string
  completed: boolean
  priority: 'low' | 'medium' | 'high'
}

interface Project {
  id: string
  name: string
  description: string
  taskIds: string[]
}

// Create schema
const schema = createSchema({
  services: [service<Task, 'tasks'>('tasks'), service<Project, 'projects'>('projects')],
})

// Mock Feathers client
const feathersClient = {} as FeathersClient

// Create adapter with FeathersAdapter (which has FeathersFindMeta as its meta type)
const adapter = new FeathersAdapter(feathersClient, {
  defaultPageSize: 25,
})

// Create Figbird instance with the adapter
// The Figbird instance now carries both Schema and TMeta types
const figbird = new Figbird({
  adapter,
  schema,
})

// Create hooks by passing the figbird instance
// This automatically infers BOTH the schema AND the meta type!
// No need to manually pass FeathersFindMeta anymore! 🎉
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const hooks = createHooks(figbird)

// Type-level tests - extract return types for specific services
export type TasksQuery = ReturnType<typeof hooks.useFind<'tasks'>>
export type TasksData = TasksQuery['data'] // Should be Task[] | null
export type TasksMeta = TasksQuery['meta'] // Should be FeathersFindMeta
export type TasksMetaTotal = TasksMeta['total'] // Should be number | undefined
export type TasksMetaLimit = TasksMeta['limit'] // Should be number | undefined
export type TasksMetaSkip = TasksMeta['skip'] // Should be number | undefined

export type ProjectQuery = ReturnType<typeof hooks.useGet<'projects'>>
export type ProjectData = ProjectQuery['data'] // Should be Project | null
export type ProjectMeta = ProjectQuery['meta'] // Should be FeathersFindMeta

// Also test backward compatibility - the old API should still work
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const backwardCompatHooks = createHooks<typeof schema>()
export type BackwardCompatQuery = ReturnType<typeof backwardCompatHooks.useFind<'tasks'>>
export type BackwardCompatMeta = BackwardCompatQuery['meta'] // Should be Record<string, unknown>
