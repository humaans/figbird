# Figbird 2.0 TypeScript Migration Guide

## Overview

Figbird has been fully converted to TypeScript with a new optional schema-based type system that provides end-to-end type safety for your queries and mutations.

## Key Changes

### 1. Full TypeScript Support

- All code has been converted from JavaScript to TypeScript
- Complete type definitions for all APIs
- Improved IDE autocomplete and type checking

### 2. Optional Schema System

The new schema system allows you to define your service types once and get full type inference throughout your application.

## Migration Guide

### For Existing Users (Backward Compatible)

If you're already using Figbird, your code will continue to work without any changes:

```typescript
// This still works exactly as before
const notes = useFind('notes')
const note = useGet('notes', 1)
const { create, patch, remove } = useMutation('notes')
```

Without a schema, queries return `any` types, maintaining full backward compatibility.

### Adopting the Schema System

To get type safety, define a schema for your services:

```typescript
// schema.ts
import { service } from 'figbird'

// Define your entity types
interface Person {
  id: string
  name: string
  email: string
  age?: number
  role: 'admin' | 'user'
  [key: string]: unknown // Required for BaseItem compatibility
}

interface Task {
  id: string
  title: string
  completed: boolean
  assigneeId?: string
  priority: number
  tags: string[]
  [key: string]: unknown
}

// Create the schema
export const schema = {
  services: [
    service<Person>('api/people'),
    service<Task>('api/tasks'),
  ],
}

export type AppSchema = typeof schema

// Pass the schema when creating Figbird
const adapter = new FeathersAdapter(feathers)
const figbird = new Figbird({ adapter, schema })
```

### Using the Schema with createHooks

The cleanest approach is to use `createHooks` to create typed versions of the hooks:

```typescript
// hooks.ts
import { createHooks } from 'figbird'
import type { AppSchema } from './schema'

// Create typed hooks once
export const { useFind, useGet, useMutation } = createHooks<AppSchema>()

// app.tsx
import { FigbirdProvider } from 'figbird'
import { figbird } from './setup'

function App() {
  return (
    <FigbirdProvider figbird={figbird}>
      <YourApp />
    </FigbirdProvider>
  )
}
```

### Type-Safe Components

With typed hooks, all types flow automatically:

```typescript
// components/MyComponent.tsx
import { useFind, useGet, useMutation } from './hooks'

function MyComponent() {
  // TypeScript knows people is QueryResult<Person[]>
  const people = useFind('api/people')
  
  // TypeScript knows task is QueryResult<Task>
  const task = useGet('api/tasks', 'task-id')
  
  // All mutations are typed
  const { create, update, patch, remove } = useMutation('api/tasks')
  
  // TypeScript enforces correct property types
  const handleCreate = async () => {
    const newTask = await create({
      id: 'new-id',
      title: 'My Task',
      completed: false,
      priority: 1,
      tags: ['important'],
      // assigneeId is optional, so can be omitted
    })
  }
  
  // TypeScript knows the shape of the data
  if (people.data) {
    people.data.forEach(person => {
      console.log(person.name) // ✅ TypeScript knows this is a string
      console.log(person.age)  // ✅ TypeScript knows this is number | undefined
      // console.log(person.foo) // ❌ TypeScript error - property doesn't exist
    })
  }
}
```

## Advanced Features

### Custom Query Parameters

Define service-specific query extensions:

```typescript
interface TaskQuery {
  $search?: string
  $asOf?: Date
  [key: string]: unknown
}

const schema = {
  services: [
    service<Task, TaskQuery>('api/tasks'),
  ],
}

// Now you can use custom query parameters with your typed hooks
const tasks = useFind('api/tasks', {
  query: {
    completed: false,
    $search: 'urgent', // ✅ Custom parameter is recognized
    $asOf: new Date(),
  },
})
```

### Direct Service Names

Services are defined in an array and referenced by their actual names:

```typescript
const schema = {
  services: [
    service<Person>('api/people'),
    service<Task>('api/tasks'),
  ],
}

// Use the actual service name in your components
const people = useFind('api/people')
const tasks = useFind('api/tasks')
```

### Type Extraction Utilities

Extract types from your schema for use elsewhere:

```typescript
import { Item, Query } from 'figbird'

// Extract types from services in the array
type PersonService = (typeof schema.services)[0]
type PersonItem = Item<PersonService>

type TaskService = (typeof schema.services)[1]  
type TaskQuery = Query<TaskService>
```

### Direct Query API

The direct query API is also fully typed:

```typescript
const figbird = useFigbird<AppSchema>()

const query = figbird.query<Person[]>({
  serviceName: 'api/people',
  method: 'find',
})

const unsubscribe = query.subscribe(state => {
  if (state.data) {
    // state.data is typed as Person[]
    console.log(state.data[0].name)
  }
})
```

## Benefits

1. **Type Safety**: Catch errors at compile time instead of runtime
2. **Better IDE Support**: Full autocomplete for all properties and methods
3. **Self-Documenting**: The schema serves as documentation for your API
4. **Refactoring Safety**: Rename properties with confidence
5. **Backward Compatible**: Adopt gradually, no breaking changes

## Best Practices

1. **Define schemas in a central location** for easy sharing across your app
2. **Include index signature** (`[key: string]: unknown`) in your types for BaseItem compatibility
3. **Use type extraction utilities** to avoid duplicating type definitions
4. **Gradually adopt** the schema system - you can migrate one service at a time

## Alternative: Using Untyped Hooks

If you prefer not to use `createHooks`, you can still use the standard hooks with less type safety:

```typescript
import { useFind, useGet, useMutation } from 'figbird'

function MyComponent() {
  // These return any types
  const people = useFind('api/people')
  const task = useGet('api/tasks', 'task-id')
  const { create } = useMutation('api/tasks')
}
```

## Troubleshooting

### "Type 'X' does not satisfy the constraint 'BaseItem'"

Add an index signature to your type:

```typescript
interface Person {
  id: string
  name: string
  [key: string]: unknown // Add this
}
```

### Custom query operators not working

Custom operators (like `$search`, `$asOf`) are automatically detected and handled. They won't cause errors with the matcher.

### Type inference not working

Make sure you:
1. Pass the schema to `new Figbird({ adapter, schema })`
2. Use `createHooks<AppSchema>()` to create typed hooks
3. Import the typed hooks in your components
4. Use `as const` assertion when defining the schema

## Examples

See the [test/schema.test.tsx](test/schema.test.tsx) file for comprehensive examples of the new schema system in action.