import type { FeathersClient } from '../../lib'
import {
  createHooks,
  defineSchemaFor,
  FeathersAdapter,
  Figbird,
  type ServiceCreate,
  type ServiceItem,
  type ServicePatch,
  type ServiceQuery,
} from '../../lib'

interface Person {
  id: string
  name: string
  status: 'active' | 'inactive'
}

interface PersonCreate {
  name: string
}

interface PersonPatch {
  status?: Person['status']
}

interface PersonQuery {
  status?: Person['status']
  $search?: string
}

interface Task {
  id: string
  title: string
  done: boolean
}

interface GeneratedApiSchemaTypes {
  'api/people': {
    item: Person
    create: PersonCreate
    patch: PersonPatch
    query: PersonQuery
  }
  'api/tasks': {
    item: Task
  }
}

export const schemaFromNames = defineSchemaFor<GeneratedApiSchemaTypes>()({
  services: ['api/people', 'api/tasks'],
})

type AppSchema = typeof schemaFromNames

const feathers = {} as FeathersClient
const adapter = new FeathersAdapter(feathers)
const figbird = new Figbird({ schema: schemaFromNames, adapter })
const { useFind, useMutation } = createHooks(figbird)

export type PeopleItem = ServiceItem<AppSchema, 'api/people'>
export type PeopleQuery = ServiceQuery<AppSchema, 'api/people'>
export type PeopleCreate = ServiceCreate<AppSchema, 'api/people'>
export type PeoplePatch = ServicePatch<AppSchema, 'api/people'>
export type TaskCreate = ServiceCreate<AppSchema, 'api/tasks'>
export type PeopleService = (typeof schemaFromNames.services)['api/people']

export const people = useFind('api/people', {
  query: {
    status: 'active',
    $search: 'Ada',
  },
})

const { create, patch } = useMutation('api/people')

export const createdPerson = create({ name: 'Ada' })
export const patchedPerson = patch('person-1', { status: 'inactive' })
