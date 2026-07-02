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

interface TaskService {
  item: Task
}

interface ProjectService {
  item: Project
}

// Create schema
const schema = createSchema({
  services: {
    tasks: service<TaskService>(),
    projects: service<ProjectService>(),
  },
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
const { useFind, useGet } = createHooks(figbird)

// Use the hooks to test type inference
export const tasksResult = useFind('tasks')
export const projectResult = useGet('projects', '123')

// Type-level tests - these will be checked by the test
export type TasksData = typeof tasksResult.data
export type TasksMeta = typeof tasksResult.meta
export type TasksMetaTotal = typeof tasksResult.meta.total
export type TasksMetaLimit = typeof tasksResult.meta.limit
export type TasksMetaSkip = typeof tasksResult.meta.skip

export type ProjectData = typeof projectResult.data

// Test that meta type for find is always inferred from the adapter
// Since we're using FeathersAdapter, it will always be FeathersFindMeta
const feathersNoMeta = {} as FeathersClient
const adapterNoExplicitMeta = new FeathersAdapter(feathersNoMeta)
const figbirdNoExplicitMeta = new Figbird({ adapter: adapterNoExplicitMeta, schema })
const backwardCompatHooks = createHooks(figbirdNoExplicitMeta)
export const backwardCompatResult = backwardCompatHooks.useFind('tasks')
export type BackwardCompatMeta = typeof backwardCompatResult.meta
