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

export const { useFind, useGet, useMutation } = createHooks(figbird)

function App() {
  return (
    <FigbirdProvider figbird={figbird}>
      <Notes />
    </FigbirdProvider>
  )
}

function Notes() {
  const { data } = useFind('notes')
  const { patch } = useMutation('notes')

  return data?.map(note => (
    <div key={note.id} onClick={() => patch(note.id, { read: true })}>
      {note.content}
    </div>
  ))
}

function IntegrationSync({ integrationId }) {
  const { call, status, error } = useMutation('api/integrations/provider')

  const refreshUsers = async () => {
    await call('listSyncedUsers', { integrationId })
  }

  return <button onClick={refreshUsers}>{status === 'loading' ? 'Syncing...' : 'Sync users'}</button>
}
```

## Features

- **Live queries** - results update as records are created, modified, or removed
- **Shared cache** - same data across components, always consistent
- **Realtime built-in** - Feathers websocket events update your UI automatically
- **Fetch policies** - `swr`, `cache-first`, or `network-only` per query
- **Full TypeScript** - define a schema once, get inference everywhere

## Documentation

Visit [humaans.github.io/figbird](https://humaans.github.io/figbird/) for full documentation and API reference.
