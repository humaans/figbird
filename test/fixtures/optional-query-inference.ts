import { defineSchema, defineService } from '../../lib'

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

export const schema = defineSchema({
  services: {
    tasks: defineService<TaskServiceDefinition>(),
  },
})

export const taskService = schema.services.tasks

type TaskService = (typeof schema.services)['tasks']

export type TaskQueryType = import('../../lib').Query<TaskService>
