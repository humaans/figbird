# Figbird

Effortless realtime data management for React + Feathers applications. Used in [Humaans](https://humaans.io/).

## Install

    $ npm install figbird

## Usage (TypeScript single file)

```ts
import React from 'react'
import feathers from '@feathersjs/client'
import io from 'socket.io-client'
import {
  FigbirdProvider,
  Figbird,
  FeathersAdapter,
  createSchema,
  service,
  createHooks,
} from 'figbird'

// 1) Define domain types and services
interface Note { id: string; content: string; tag?: string }
interface Task { id: string; title: string; completed: boolean }

interface NoteService { item: Note }
interface TaskService { item: Task; query?: { completed?: boolean } }

const schema = createSchema({
  services: {
    notes: service<NoteService>(),
    tasks: service<TaskService>(),
  },
})

// 2) Create Feathers client + Figbird
const client = feathers()
client.configure(feathers.socketio(io('http://localhost:3030')))

const adapter = new FeathersAdapter(client)
const figbird = new Figbird({ adapter, schema })
const { useFind, useGet, useMutation } = createHooks(figbird)

// 3) Use typed hooks
function Notes() {
  const { data, meta, status } = useFind('notes', { query: { tag: 'ideas', $limit: 10 } })
  if (status === 'loading') return <>Loading…</>
  return <div>Showing {data?.length ?? 0} notes (total {meta.total})</div>
}

function TaskDetails({ id }: { id: string }) {
  // useGet returns only the item (no meta by default)
  const { data } = useGet('tasks', id)
  return <div>{data?.title}</div>
}

function NewTaskButton() {
  const { create } = useMutation('tasks')
  return (
    <button onClick={() => create({ title: 'New task', completed: false })}>
      Add Task
    </button>
  )
}

export default function App() {
  return (
    <FigbirdProvider figbird={figbird}>
      <Notes />
      <TaskDetails id="123" />
      <NewTaskButton />
    </FigbirdProvider>
  )
}
```

## Features

### Idiomatic React Hooks

Fetch some data with `const { data } = useFind('notes')` and your components will re-render in realtime as the data changes upstream. Modify the data using `const { patch } = useMutation('notes')` and the updates will be instantly propagated to all components referencing the same objects.

- `useGet`
- `useFind`
- `useMutation`

### Live Queries

Works with Feathers realtime events and with local data mutations. Once a record is created/modified/removed, all queries referencing this record get updated. For example, if your data is fetched using `useFind('notes', { query: { tag: 'ideas' } })` and you then patch some note with `patch({ tag: 'ideas' })`, the query will update immediately and re-render all components referencing that query. Adjust behavior per query:

- `merge` - merge realtime events into cached queries as they come (default)
- `refetch` - refetch data for this query from the server when a realtime event is received
- `disabled` - ignore realtime events for this query

### Fetch policies

Fetch policies allow you to fine tune Figbird to your requirements. With the default `swr` (stale-while-revalidate) Figbird uses cached data when possible for maximum responsiveness, but refetches in the background on mount to make sure data is up to date. Other policies include `cache-first`, which will use cache and not refresh from the server (compatible with realtime), and `network-only`, which always fetches from the network.

- `swr` - show cached data if possible and refetch in the background (default)
- `cache-first` - show cached data if possible and avoid fetching if data is there
- `network-only` - always refetch data on mount

## API Reference

Visit the [documentation site](https://humaans.github.io/figbird/) for full API reference.
