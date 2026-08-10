# Figbird

A realtime, relational data layer for React + Feathers applications. Used in production at [Humaans](https://humaans.io/).

Figbird gives you one query hook that fetches an entity graph — a record together with its relations — and keeps it updated. When a record changes, from this component, another component, or a realtime event from the server, every query referencing that data re-renders with the new state. No cache invalidation, no manual refetching.

## Install

```sh
pnpm add figbird
```

## Usage

```tsx
import { Figbird, FeathersAdapter, createSchema, service, createHooks } from 'figbird'

const schema = createSchema({
  services: {
    notes: service<{ item: Note }>(),
    users: service<{ item: User }>(),
  },
  relationships: {
    notes: ({ one }) => ({
      author: one({ sourceField: 'authorId', destService: 'users' }),
    }),
  },
})

const figbird = new Figbird({
  adapter: new FeathersAdapter(feathersClient),
  schema,
})

export const { useQuery, useAction, q, m } = createHooks(figbird)

function Notes() {
  const { data: notes } = useQuery(q.notes.where({ read: false }).related('author'))

  return notes.map(note => <NoteRow key={note.id} note={note} />)
}

function NoteRow({ note }: { note: Note & { author?: User } }) {
  const markRead = useAction('mark read', () => m.notes.patch(note.id, { read: true }))

  return (
    <button onClick={markRead.run} disabled={markRead.pending}>
      {note.content} — {note.author?.name}
    </button>
  )
}
```

No provider needed — the hooks are bound to the instance. Cold reads suspend into your `<Suspense>` boundary; warm reads render synchronously.

## Features

- **Relational queries** — declare relations once, `.related()` assembles live entity graphs
- **Live queries** — results update as records are created, modified, or removed
- **Suspense-native** — loading states live in boundaries, not branches
- **Optimistic mutations** — declared once per surface, rolled back on failure everywhere
- **Prepare & prefetch** — routers and hover handlers warm the exact queries screens will read
- **Full TypeScript** — define a schema once, get inference through builders, relations, and mutations

## Documentation

Visit [humaans.github.io/figbird](https://humaans.github.io/figbird/) for full documentation and API reference.
