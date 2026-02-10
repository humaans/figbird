/* eslint-disable @typescript-eslint/no-unused-vars */
import type { FeathersClient, ServiceMethods } from '../../lib'
import { createHooks, createSchema, FeathersAdapter, Figbird, service } from '../../lib'

interface Integration {
  id: string
  status: 'connected' | 'disconnected'
}

interface SyncedUser {
  id: string
  email: string
}

interface IntegrationService {
  item: Integration
  methods: {
    listSyncedUsers: (params: { integrationId: string }) => Promise<SyncedUser[]>
    disconnectUser: (params: {
      employmentId: string
      personId: string
      integrationId: string
    }) => Promise<{ disconnected: boolean }>
  }
}

interface Task {
  id: string
  title: string
  done: boolean
}

interface TaskService {
  item: Task
}

const schema = createSchema({
  services: {
    integrations: service<IntegrationService>(),
    tasks: service<TaskService>(),
  },
})

const feathers = {} as FeathersClient
const adapter = new FeathersAdapter(feathers)
const figbird = new Figbird({ schema, adapter })
const { useMutation } = createHooks(figbird)

const integrationMutation = useMutation('integrations')
const taskMutation = useMutation('tasks')

export type IntegrationMutationMethodName = Parameters<typeof integrationMutation.call>[0]
export type IntegrationCallListSyncedUsersArgs = Parameters<
  typeof integrationMutation.call<'listSyncedUsers'>
>
export type IntegrationCallDisconnectUserArgs = Parameters<
  typeof integrationMutation.call<'disconnectUser'>
>

const listSyncedUsersPromise = integrationMutation.call('listSyncedUsers', {
  integrationId: 'int-1',
})
const disconnectUserPromise = integrationMutation.call('disconnectUser', {
  employmentId: 'emp-1',
  personId: 'person-1',
  integrationId: 'int-1',
})

export type IntegrationCallListSyncedUsersReturn = Awaited<typeof listSyncedUsersPromise>
export type IntegrationCallDisconnectUserReturn = Awaited<typeof disconnectUserPromise>
export type IntegrationMutationData = typeof integrationMutation.data

export type TaskMutationMethodName = Parameters<typeof taskMutation.call>[0]
export type TaskCreateReturn = Awaited<ReturnType<typeof taskMutation.create>>
export type TaskPatchReturn = Awaited<ReturnType<typeof taskMutation.patch>>
export type TaskUpdateReturn = Awaited<ReturnType<typeof taskMutation.update>>
export type TaskRemoveReturn = Awaited<ReturnType<typeof taskMutation.remove>>

export type IntegrationSchemaMethodNames = keyof ServiceMethods<typeof schema, 'integrations'>

// @ts-expect-error - only schema custom method names are allowed
integrationMutation.call('notAMethod')
// @ts-expect-error - args are inferred from the selected method signature
integrationMutation.call('listSyncedUsers', { integrationId: 123 })
