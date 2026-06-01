import { defineSchema } from '../../lib'

interface Task {
  id: string
  title: string
  completed: boolean
}

interface TaskQuery {
  completed?: boolean
  $search?: string
}

interface TaskServiceDefinition {
  item: Task
  query?: TaskQuery
}

interface AppSchemaTypes {
  tasks: TaskServiceDefinition
}

export const schema = defineSchema<AppSchemaTypes>()

type AppSchema = typeof schema

export type TaskService = import('../../lib').ServiceByName<AppSchema, 'tasks'>

export type TaskQueryType = import('../../lib').Query<TaskService>
