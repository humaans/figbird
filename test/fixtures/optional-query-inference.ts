import { createSchema, service } from '../../lib'

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

export const schema = createSchema({
  services: {
    tasks: service<TaskServiceDefinition>(),
  },
})

export const taskService = schema.services.tasks

type TaskService = (typeof schema.services)['tasks']

export type TaskQueryType = import('../../lib').Query<TaskService>
