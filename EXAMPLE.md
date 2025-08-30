# Figbird TypeScript API - New Schema-Based Design

This example demonstrates the new ergonomic TypeScript API for Figbird that provides powerful type narrowing and better development experience.

## API Overview

The new API uses a **two-phase approach** for maximum type safety and ergonomics:

1. **Service Definition Phase**: Define service types with `service<ServiceType>()`
2. **Schema Creation Phase**: Map service names to service definitions in an object

```typescript
interface PersonService {
  item: Person
  create?: CreatePersonData
  update?: UpdatePersonData  
  patch?: PatchPersonData
  query?: PersonQuery
}

const schema = createSchema({
  services: {
    people: service<PersonService>(),  // ✨ Clean literal name preservation
    tasks: service<TaskService>(),     // ✨ Perfect service narrowing
  },
})
```

## Complete Example

```typescript
import { createSchema, service, createHooks, Figbird, FeathersAdapter } from 'figbird'
import type { FeathersClient } from 'figbird'

// 1. Define your data types
interface Person {
  id: string
  name: string
  email: string
  role: 'admin' | 'user'
  createdAt: Date
}

// 2. Define your service type with custom payload types
interface PersonService {
  item: Person
  create: {
    name: string
    email: string
    // Note: role is not included - will be set server-side
  }
  patch: {
    name?: string
    role?: 'admin' | 'user'
    // Note: email changes not allowed via patch
  }
  // update and query get sensible defaults:
  // update: Person (full replacement)
  // query: Record<string, unknown>
}

interface TaskService {
  item: Task
  create: { title: string }
  patch: { title?: string; completed?: boolean }
}

// 3. Create your schema using the new two-phase approach
const schema = createSchema({
  services: {
    people: service<PersonService>(),    // Literal name "people" preserved
    tasks: service<TaskService>(),       // Literal name "tasks" preserved  
  },
})

// 4. Create Figbird instance
const feathers = {} as FeathersClient
const adapter = new FeathersAdapter(feathers)
const figbird = new Figbird({ schema, adapter })

// 5. Create typed hooks
const { useFind, useMutation } = createHooks(figbird)

// 6. Use in your components with full type safety!
function PeopleComponent() {
  // ✨ useFind('people') returns QueryResult<Person[], FeathersFindMeta> (NOT a union!)
  const peopleQuery = useFind('people')
  
  // ✨ useFind('tasks') returns QueryResult<Task[], FeathersFindMeta> (perfectly narrowed!)
  const tasksQuery = useFind('tasks')
  
  const { create, patch } = useMutation('people')

  const handleCreatePerson = async () => {
    // TypeScript enforces PersonService['create'] type
    const newUser = await create({
      name: 'Jane Doe',
      email: 'jane.doe@example.com',
      // role: 'admin' // ❌ TypeScript error - not in create type
    })
    // newUser is correctly typed as Person
    console.log(newUser.id, newUser.role) // ✅ All Person properties available
  }

  const handlePatchPerson = async (id: string) => {
    // TypeScript enforces PersonService['patch'] type  
    await patch(id, {
      name: 'Jane Smith',
      role: 'admin',
      // email: 'new@email.com' // ❌ TypeScript error - not in patch type
    })
  }

  return (
    <div>
      {/* ✨ peopleQuery.data is Person[] | null - perfectly typed! */}
      {peopleQuery.data?.map(person => (
        <div key={person.id}>
          <h3>{person.name}</h3>
          <p>{person.email}</p>
          <span>Role: {person.role}</span>
        </div>
      ))}
      
      {/* ✨ tasksQuery.data is Task[] | null - no union types! */}  
      {tasksQuery.data?.map(task => (
        <div key={task.id}>
          <h4>{task.title}</h4>
          <span>Done: {task.completed}</span>
        </div>
      ))}
    </div>
  )
}
```

## Key Benefits

### ✅ **Ergonomic API**
- Clean two-phase definition: `people: service<PersonService>()`
- Clean, readable service definitions
- Sensible defaults for unspecified types

### ✅ **Powerful Type Narrowing**
- `useFind('people')` automatically infers `Person[]` return type
- No more union types - each service gets its own specific types
- Full intellisense and autocomplete support

### ✅ **Flexible Mutation Types**
- Different payload types for create, update, and patch operations
- Server-enforced business rules can be reflected in types
- Compile-time safety prevents invalid mutations

### ✅ **Extensible Design**
- Add custom query types for advanced filtering
- Easy to add new services without breaking existing ones
- Backward compatibility for non-schema usage

## Type Defaults

When you don't specify certain payload types, Figbird provides intelligent defaults:

```typescript
interface PersonService {
  item: Person  // ✅ Required
  // create: defaults to Partial<Person>
  // update: defaults to Person
  // patch: defaults to Partial<Person>  
  // query: defaults to Record<string, unknown>
}
```

## Advanced Usage

### Custom Query Types

```typescript
interface TaskQuery {
  $search?: string
  priority?: 'low' | 'medium' | 'high'
  completed?: boolean
}

interface TaskService {
  item: Task
  query: TaskQuery
}

const tasks = useFind('tasks', {
  query: {
    priority: 'high',      // ✅ Typed
    $search: 'important',  // ✅ Typed
    // invalid: true       // ❌ TypeScript error
  }
})
```

### Non-Schema Services

Services not defined in the schema still work but fall back to weaker typing:

```typescript
// This works but gets Record<string, unknown> types
const unknownData = useFind('some-random-service')
```

This new API makes Figbird much more pleasant to use with TypeScript while maintaining all the powerful realtime and caching features you expect!