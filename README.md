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
- **Ordered autosave queues** — buffer and merge edits across related records without losing optimism
- **Prepare & prefetch** — routers and hover handlers warm the exact queries screens will read
- **Virtualized windows** — bounded relational pages follow any list virtualizer's visible range
- **Full TypeScript** — define a schema once, get inference through builders, relations, and mutations

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

Run [Prepare npm release](https://github.com/humaans/figbird/actions/workflows/prepare-release.yml) in GitHub Actions on `master`. Choose `patch`, `minor`, or `major` for a stable release, or `prerelease` to increment the current `pre` version. Use `prepatch`, `preminor`, or `premajor` to start a new prerelease series. For example, `prerelease` takes `0.24.0-pre.18` to `0.24.0-pre.19`, while `patch` takes it to `0.24.0`.

The workflow opens a PR that updates `package.json` and `package-lock.json`. Review it and merge it. The merge runs the full test suite, builds and checks the package's exports and types, then stages the tarball on npm. Prereleases use the `next` tag; stable releases use `latest`. Dependency updates that leave the version unchanged do not stage a release.

An npm maintainer reviews the tarball in the [Staged Packages tab on npmjs.com](https://www.npmjs.com/) and approves it with 2FA. Approval makes the staged version public. The maintainer can also use `npm stage list figbird`, `npm stage view <stage-id>`, and `npm stage approve <stage-id>`. Approve the current release before preparing another one. If staging fails, fix the cause and rerun the failed GitHub Actions jobs. If a staged package needs replacing, reject it on npm before rerunning.

Before the first release through this workflow, configure `figbird` on npmjs.com:

1. In package settings, add a [trusted publisher](https://docs.npmjs.com/trusted-publishers/) for GitHub Actions with organization `humaans`, repository `figbird`, and workflow filename `publish.yml`. Leave the environment name empty. Allow only `npm stage publish`.
2. Set Publishing access to **Require two-factor authentication and disallow tokens**. Ensure the person approving staged releases has npm publish access and 2FA enabled.
3. In the repository's **Settings > Actions > General > Workflow permissions**, enable **Allow GitHub Actions to create and approve pull requests** so the preparation workflow can open version PRs. For [PRs created with `GITHUB_TOKEN`](https://docs.github.com/en/actions/concepts/security/github_token), a maintainer must select **Approve workflows to run** on the PR before its checks run.
