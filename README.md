# Figbird

A data fetching library for React + Feathers applications. Used in production at [Humaans](https://humaans.io/).

Figbird gives you React hooks that fetch data and keep it updated. When a record changes - from this component, another component, or a realtime event from the server - every query referencing that data re-renders with the new state. No cache invalidation, no manual refetching.

## Install

```sh
pnpm add figbird
```

## Usage

```ts
import { Figbird, FeathersAdapter, FigbirdProvider, createHooks } from 'figbird'

const figbird = new Figbird({
  adapter: new FeathersAdapter(feathersClient),
})

export const { useFind, useGet, useMutation, useService } = createHooks(figbird)

function App() {
  return (
    <FigbirdProvider figbird={figbird}>
      <Notes />
    </FigbirdProvider>
  )
}

function Notes() {
  const { data } = useFind('notes')
  const notesService = useService('notes')

  return data?.map(note => (
    <div key={note.id} onClick={() => notesService.patch(note.id, { read: true })}>
      {note.content}
    </div>
  ))
}
```

`useService('notes')` returns the Feathers service for that schema service. When you create hooks
from a typed Figbird instance, the returned service is narrowed by the literal service name and
includes typed CRUD methods plus any custom methods declared in the schema.

## Features

- **Live queries** - results update as records are created, modified, or removed
- **Shared cache** - same data across components, always consistent
- **Realtime built-in** - Feathers websocket events update your UI automatically
- **Fetch policies** - `swr`, `cache-first`, or `network-only` per query
- **Full TypeScript** - define a schema once, get inference everywhere

## Documentation

Visit [humaans.github.io/figbird](https://humaans.github.io/figbird/) for full documentation and API reference.
