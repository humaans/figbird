# Figbird

A realtime, relational data layer for React + Feathers applications. Used in production at [Humaans](https://humaans.io/).

Figbird gives you one query hook that fetches an entity graph — a record together with its relations — and keeps it updated. When a record changes, from this component, another component, or a realtime event from the server, every query referencing that data re-renders with the new state. No cache invalidation, no manual refetching.

## Install

```sh
pnpm add figbird
```

## Usage

```tsx
import {
  Figbird,
  FigbirdProvider,
  FeathersAdapter,
  createSchema,
  service,
  createHooks,
} from 'figbird'

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

export const { useQuery, useQueryResult, useMutations, useAction, q } = createHooks(schema)

function Notes() {
  const notes = useQuery(q.notes.where({ read: false }).related('author'))

  return notes.map(note => <NoteRow key={note.id} note={note} />)
}

function NoteRow({ note }: { note: Note & { author?: User } }) {
  const m = useMutations()
  const markRead = useAction('mark read', () => m.notes.patch(note.id, { read: true }))

  return (
    <button onClick={markRead.run} disabled={markRead.pending}>
      {note.content} — {note.author?.name}
    </button>
  )
}

function Root() {
  return (
    <FigbirdProvider figbird={figbird}>
      <Notes />
    </FigbirdProvider>
  )
}
```

`createHooks(schema)` is pure and safe to evaluate at import time. The provider selects the
runtime instance, so tests, stories, and SSR requests can inject their own client. Imperative
code outside React uses the instance directly: `figbird.m`, `figbird.prepare`, and
`figbird.prefetch`. Construct each injected instance with the same schema object passed to
`createHooks`; provider-bound APIs and schema-built queries throw when the schemas differ.

Cold reads suspend into your `<Suspense>` boundary; warm reads render synchronously.
Transient fetch failures retry up to three times with exponential backoff before Figbird exposes the error. Client errors fail immediately, except for `408` and `429` responses.

## Features

- **Relational queries** — declare relations once, `.related()` assembles live entity graphs
- **Live queries** — results update as records are created, modified, or removed
- **Suspense-native** — loading states live in boundaries, not branches
- **Optimistic mutations** — declared once per surface, rolled back on failure everywhere
- **Ordered autosave queues** — buffer and merge edits across related records without losing optimism
- **Prepare & prefetch** — routers and hover handlers warm the exact queries screens will read
- **Virtualized windows** — bounded relational pages follow any list virtualizer's visible range
- **Full TypeScript** — define a schema once, get inference through builders, relations, and mutations

## Documentation

Visit [humaans.github.io/figbird](https://humaans.github.io/figbird/) for full documentation and API reference.
