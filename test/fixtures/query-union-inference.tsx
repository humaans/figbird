import { createHooks, createSchema, service } from '../../lib'
import type { QueryBuilderItem } from '../../lib/core/queryBuilder.js'

type FieldBase = {
  id: string
  ownerId: string
  membersPreview: string[]
}

type FieldDefinition = FieldBase &
  (
    | { fieldType: 'string'; format?: 'multiline'; referenceType?: never }
    | { fieldType: 'date'; format?: never; referenceType?: never }
    | { fieldType: 'reference'; format?: never; referenceType: 'person' }
  )

type Person = { id: string; name: string }
type Container = { id: string; fieldId: string }

const schema = createSchema({
  services: {
    fields: service<{ item: FieldDefinition }>(),
    people: service<{ item: Person }>(),
    containers: service<{ item: Container }>(),
  },
  relationships: {
    fields: ({ one, embed }) => ({
      owner: one({ sourceField: 'ownerId', destService: 'people' }),
      membersPreview: embed({
        sourceField: 'membersPreview',
        destService: 'people',
        destField: 'id',
      }),
    }),
    containers: ({ one }) => ({
      field: one({ sourceField: 'fieldId', destService: 'fields' }),
    }),
  },
})

const hooks = createHooks(schema)
const find = hooks.q.fields
const all = find.where({ fieldType: 'string' }).all()
const get = find.get('field-id')
const paginated = find.paginate({ pageSize: 25 })
const expanded = find.related('owner').related('membersPreview', people => people)
const nested = hooks.q.containers.related('field', field => field.related('owner'))

function narrowDefinition(definition: QueryBuilderItem<typeof find>) {
  switch (definition.fieldType) {
    case 'string': {
      const format: 'multiline' | undefined = definition.format
      return format
    }
    case 'date': {
      const format: undefined = definition.format
      return format
    }
    case 'reference': {
      const target: 'person' = definition.referenceType
      return target
    }
    default: {
      definition satisfies never
      throw new Error(`Unknown field definition ${JSON.stringify(definition)}`)
    }
  }
}

/** Compile-time examples only; hooks are never executed by the test runner. */
export function QueryUnionInferenceFixture() {
  // Every query kind keeps the union, and `get` keeps `null`.
  const rootDefinitions: FieldDefinition[] = hooks.useQuery(find)
  const allDefinitions: FieldDefinition[] = hooks.useQuery(all)
  const pageDefinitions: FieldDefinition[] = hooks.useQuery(paginated)
  const definition: FieldDefinition | null = hooks.useQuery(get)
  const result = hooks.useQueryResult(all, { suspense: false })
  if (result.status === 'success') {
    const resultDefinitions: FieldDefinition[] = result.data
    void resultDefinitions
  }
  // @ts-expect-error A single-result query retains nullability.
  const nonNullable: FieldDefinition = hooks.useQuery(get)

  // Relations merge into each union variant.
  const expandedFields = hooks.useQuery(expanded)
  for (const field of expandedFields) {
    const owner: Person | null = field.owner
    const members: Person[] = field.membersPreview
    if (field.fieldType === 'reference') {
      const target: 'person' = field.referenceType
      void target
    }
    // @ts-expect-error An embedded relation replaces the original ID array.
    const memberIds: string[] = field.membersPreview
    void owner
    void members
    void memberIds
  }

  // Nested relations keep the union.
  const containers = hooks.useQuery(nested)
  for (const container of containers) {
    if (container.field?.fieldType === 'reference') {
      const target: 'person' = container.field.referenceType
      const owner: Person | null = container.field.owner
      void target
      void owner
    }
  }

  // Items that match no variant are rejected.
  const base: FieldBase = { id: 'field-id', ownerId: 'owner-id', membersPreview: [] }
  // @ts-expect-error Reference definitions require a reference target.
  const missingTarget: QueryBuilderItem<typeof find> = { ...base, fieldType: 'reference' }
  const invalidDate: QueryBuilderItem<typeof find> = {
    ...base,
    fieldType: 'date',
    // @ts-expect-error Date definitions cannot carry string presentation metadata.
    format: 'multiline',
  }

  void rootDefinitions
  void allDefinitions
  void pageDefinitions
  void definition
  void nonNullable
  void missingTarget
  void invalidDate
  void narrowDefinition
  return null
}
