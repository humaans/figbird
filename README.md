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
runtime instance, so tests and stories can inject their own client. Imperative
code outside React uses the instance directly: `figbird.m`, `figbird.prepare`, and
`figbird.prefetch`. Construct each injected instance with the same schema object passed to
`createHooks`; provider-bound APIs and schema-built queries throw when the schemas differ.

Cold reads suspend into your `<Suspense>` boundary; warm reads render synchronously.
Transient fetch failures retry up to three times with exponential backoff before Figbird exposes the error. Client errors fail immediately, except for `408` and `429` responses.
Successful results stay fresh for five minutes by default, so short remounts reuse the
cache without another request. Set `staleTime` on `new Figbird(...)` to change the app-wide
default, or pass it to an individual query reader.

## Features

- **Relational queries** — declare relations once, `.related()` assembles live entity graphs
- **Live queries** — results update as records are created, modified, or removed
- **Suspense-native** — loading states live in boundaries, not branches
- **Optimistic mutations** — declared once per surface, rolled back on failure everywhere
- **Atomic transactions** — commit CRUD writes together through an adapter with server transaction support
- **Ordered autosave queues** — buffer and merge edits across related records without losing optimism
- **Prepare & prefetch** — routers and hover handlers warm the exact queries screens will read
- **Virtualized windows** — bounded relational pages follow any list virtualizer's visible range
- **Full TypeScript** — define a schema once, get inference through builders, relations, and mutations

## Transactions

Use `figbird.transaction()` to commit several CRUD writes atomically. For Feathers, enable
the transport when your backend provides an atomic transaction service:

```ts
import { Figbird, FeathersAdapter, feathersTransactions } from 'figbird'

const figbird = new Figbird({
  schema,
  adapter: new FeathersAdapter(feathersClient, {
    transactions: feathersTransactions(),
  }),
})

await figbird.transaction(tx => {
  tx.m.notes.patch(firstNoteId, { read: true })
  tx.m.notes.patch(secondNoteId, { read: true })
})
```

The callback collects writes synchronously. Optimistic changes appear together and roll
back together if the transaction fails. Use `tx.m.notes.confirmed.patch(...)` to wait for
commit before updating the cache. Creates need stable client-generated ids, and each
record can appear only once per transaction.

`feathersTransactions()` calls an application-provided `api/transactions` service. It does
not create the endpoint; the backend must guarantee atomic commit and rollback. Figbird
throws if the adapter has no transaction support. See the [transaction guide](https://humaans.github.io/figbird/#adapter-backed-transactions)
for the server contract and custom endpoint configuration.

## Documentation

Visit [humaans.github.io/figbird](https://humaans.github.io/figbird/) for full documentation and API reference.

## Package entry points

Import the library, including `useGet`, `useFind`, and `useMutation`, from `figbird`.
The in-memory test client is available from `figbird/testing`. These are the supported
JavaScript entry points in both ESM and CommonJS. Internal `core/`, `react/`, `adapters/`,
and `devtools/` paths are private. Package metadata and the TypeScript configuration
remain available as `figbird/package.json` and `figbird/tsconfig.json`.

Run `npm run package:check` to build and verify the packed package's exports and types.

## Releasing

1. Run [Prepare npm release](https://github.com/humaans/figbird/actions/workflows/prepare-release.yml) on `master`. Choose `patch`, `minor`, or `major` for a stable release; `prerelease` to increment the current prerelease; or `prepatch`, `preminor`, or `premajor` to start a new prerelease series.
2. Review the version PR, select **Approve workflows to run**, and merge once checks pass. CI tests, builds, and stages the package on npm using `next` for prereleases or `latest` for stable releases.
3. Review the tarball in npm's [Staged Packages tab](https://www.npmjs.com/) and approve it with 2FA to publish. Approve the current release before preparing another.
