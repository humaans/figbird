---
title: 'Figbird'
draft: false
toc: true
---

# Figbird

A realtime, relational data layer for [React](https://reactjs.org/) + [Feathers](https://feathersjs.com/) applications. Used in production at [Humaans](https://humaans.io/).

Figbird gives you one query hook that fetches an entity graph (a record together with its relations) and keeps it updated. When a record changes, whether in this component, another component, or on the server, every query referencing it re-renders with the new state. No cache invalidation, no manual refetching.

```tsx
function IssueDetail({ id }: { id: number }) {
  const { data: issue } = useQuery(
    q.issues.get(id).related('creator').related('comments').related('labels'),
  )

  return (
    <article>
      <h1>{issue.title}</h1>
      <p>by {issue.creator?.name}</p>
      <Comments comments={issue.comments} />
    </article>
  )
}
```

## Why Figbird

- **Relational queries** — declare relations once, `.related()` assembles entity graphs
- **Live queries** — results update as records change, locally or via realtime events
- **Suspense-native** — cold reads suspend, warm reads render synchronously
- **Optimistic mutations, by default** — writes show immediately and roll back on failure everywhere at once
- **Query preparation** — routers and hover handlers warm the exact queries screens will read
- **Full TypeScript** — one schema, inference across builders, relations, and mutations
- **Framework-agnostic core** — works outside React for SSR, testing, or background sync

## Installation

```sh
pnpm add figbird
```

## Quick Start

```ts
// figbird.ts — one module wires everything
import { Figbird, FeathersAdapter, createSchema, service, createHooks } from 'figbird'
import { feathersClient } from './feathers'

interface Issue {
  id: number
  title: string
  status: 'open' | 'closed'
  creatorId: number
}
interface User {
  id: number
  name: string
}
interface Comment {
  id: number
  issueId: number
  authorId: number
  body: string
}

export const schema = createSchema({
  services: {
    issues: service<{ item: Issue }>(),
    users: service<{ item: User }>(),
    comments: service<{ item: Comment }>(),
  },
  relationships: {
    issues: ({ one, many }) => ({
      creator: one({ sourceField: 'creatorId', destService: 'users' }),
      comments: many({ sourceField: 'id', destService: 'comments', destField: 'issueId' }),
    }),
    comments: ({ one }) => ({
      author: one({ sourceField: 'authorId', destService: 'users' }),
    }),
  },
})

export const figbird = new Figbird({
  adapter: new FeathersAdapter(feathersClient),
  schema,
})

// The daily-use kit, bound to this instance.
export const { useQuery, q, m, defineQuery, prepare, prefetch, refetch, useAction, useMutating } =
  createHooks(figbird)
```

```tsx
// components — one import, no provider required
import { m, q, useQuery } from './figbird'

function OpenIssues() {
  const { data: issues } = useQuery(
    q.issues.where({ status: 'open' }).orderBy('id', 'desc').related('creator'),
  )

  return issues.map(issue => (
    <div key={issue.id}>
      {issue.title} — {issue.creator?.name}
      {/* q reads, m writes — optimistic by default, rolled back on failure */}
      <button onClick={() => m.issues.patch(issue.id, { status: 'closed' })}>Close</button>
    </div>
  ))
}
```

No `FigbirdProvider` is needed: the hooks are bound to the instance they were created with. (A provider, when present, overrides the bound instance; see [FigbirdProvider](#figbirdprovider).)

# Concepts

## Schema

The schema is the first thing you write. It declares your services, their types, and the
relationships between them, and it is where all of Figbird's TypeScript inference comes
from. There is no code generation.

Each service declares an `item` shape, and optionally `query`, `create`, `update`, `patch` payloads and custom `methods`:

```ts
interface TaskService {
  item: Task
  query?: { completed?: boolean }
  create?: { title: string; completed?: boolean }
  patch?: { title?: string; completed?: boolean }
  methods?: {
    archive: (ids: string[]) => Promise<{ count: number }>
  }
}

const schema = createSchema({
  services: {
    tasks: service<TaskService>(),
    people: service<PersonService>({ path: 'api/people' }),
  },
  relationships: {
    /* per-service factories — see Relations */
  },
})
```

Omitted payload types default sensibly: `Partial<item>` for create and patch, `item` for update. Service keys are preserved as literal types, so every API narrows on the service name. The `path` option separates ergonomic schema keys from transport-level service paths.

### What flows where

- `q.tasks.where({ completed: true })` — field names and value types check against `item` (with an open index signature for dotted paths and server operators)
- `.orderBy('title')` — autocompletes item fields without rejecting computed ones
- `.related('author')` — relation names come from the schema; the result type assembles automatically, nesting included
- `m.tasks.create(...)` — payloads and return types from the service definition; declared custom `methods` appear on the handle, fully typed
- `useQuery(definition, args)` — args typed from the definition's build function (or validated by its Standard Schema)

## Queries

Every query starts from `q.<service>` and reads like the request it makes:

```ts
q.issues // all issues
q.issues.where({ status: 'open' }) // filtered
q.issues.where({ priority: { $gte: 50 } }) // comparison operators
q.issues.orderBy('updatedAt', 'desc').limit(30) // windowed
q.issues.get(id) // one thing, by pk — GET /issues/:id
q.issues.where({ status: 'open' }).limit(1) // first match of a filter, if any
q.issues.related('comments') // with relations
q.issues.where({ id }).snapshot() // point-in-time: frozen until refetch()
q.locations.all() // exhaustive: every row, all pages (materializes the service)
q.issues.where({ status: 'open' }).all() // exhaustive slice: every matching row
```

Builders are immutable (every method returns a new one) and identified by a stable hash of their contents, so you can build them inline in render with no dependency arrays:

```tsx
function IssueList({ status }: { status: string }) {
  const { data } = useQuery(q.issues.where({ status }))
  // a new builder every render, but the same query identity while `status` is stable
}
```

`.where()` autocompletes and type-checks the fields of the service's item type, and also admits everything it can't statically know: dotted relational paths (`'creator.teamId'`), server-only operators (`$regex`), and dynamically-built filter objects.

`.get(id)` is the resource-endpoint fetch (`GET /issues/:id`) with "this must exist"
semantics: a cold fetch of a missing row enters the error state, while realtime removal
of a row you're viewing nulls the data, which is why the type is `T | null`. Chaining
`.where()` after it sends the conditions along as `params.query`. For "the first match of
a filter, if any", use `.where(...).limit(1)` and destructure the array.

## Relations

Relations are declared once in the schema, then attached per query with `.related()`:

```ts
const { data: issue } = useQuery(
  q.issues
    .get(id)
    .related('creator') // one — Issue.creator: User | null
    .related('comments', c =>
      c
        .orderBy('id', 'desc') // refine the related query
        .related('author'),
    ), // nest further — comments[].author: User | null
)
```

Relation names autocomplete from the schema and the result type is assembled automatically, including nesting and cardinality (`one` → `T | null`, `many`/`embed` → `T[]`).

Three relationship kinds cover the shapes you'll meet:

```ts
relationships: {
  issues: ({ one, many }) => ({
    // one: FK on the parent → single item
    creator: one({ sourceField: 'creatorId', destService: 'users' }),

    // many: FK on the child → array
    comments: many({ sourceField: 'id', destService: 'comments', destField: 'issueId' }),

    // many, two-hop: junction table, traversed transparently —
    // consumers say .related('labels') and get Label[] directly
    labels: many(
      { sourceField: 'id', destService: 'issueLabels', destField: 'issueId' },
      { sourceField: 'labelId', destService: 'labels' },
    ),
  }),
  teams: ({ embed }) => ({
    // embed: the parent carries a server-maintained list of ids; Figbird fans
    // every parent's list into ONE batched IN(...) fetch, preserving order
    spotlight: embed({ sourceField: 'spotlightIssueIds', destService: 'issues' }),
  }),
}
```

`one` chains through an intermediate service too — two lookups declared as a single
edge, fetched in two batched queries for any number of parents:

```ts
people: ({ one }) => ({
  // person → current employment → job role, read as person.jobRole
  jobRole: one(
    { sourceField: 'currentEmploymentId', destService: 'employments' },
    { sourceField: 'jobRoleId', destService: 'jobRoles' },
  ),
})
```

The first hop can also point the other way — an FK on the intermediate plus a hop
`query` that selects the one current row (`{ sourceField: 'id', destService:
'employments', destField: 'personId', query: { isCurrent: true } }`). When multiple
intermediate rows match a parent, the first resolves — make the first hop selective.

`destField` defaults to `'id'`; fields accept arrays for compound keys. Each service's factory gets helpers scoped to it, so every field name above type-checks: `sourceField` against the source item, `destService` against the schema, `destField` against the destination item. A generated schema fails to compile at exactly the relationship that went stale.

Relations stay live: a new comment, a renamed user, or a new junction row flows into the assembled result through the service's realtime events.

Relational queries fetch efficiently: a single `IN (...)` query per relation level (not per parent), junction traversal in two queries, `embed` in one. The exception is a **windowed relation** like `.related('recent', i => i.orderBy(...).limit(5))`, which needs one query _per parent_ because per-parent windows can't be expressed as a single find. Figbird warns past 10 parents and points at `embed` as the batched alternative.

You can also filter parents by a field on a related entity, with a dotted path:

```ts
q.issues.where({ 'creator.teamId': 5 })
```

The server resolves the join; on the client, Figbird's matcher evaluates the path against the entity cache so realtime events keep the result fresh.

## Suspense

`useQuery` is Suspense-native: a **cold** read (no cached data) throws a promise to the nearest `<Suspense>` boundary, and a cold **error** throws to the nearest error boundary. Warm reads render synchronously. In component code there is no loading branch:

```tsx
<Suspense fallback={<Skeleton />}>
  <IssueDetail id={id} />
</Suspense>
```

```tsx
function IssueDetail({ id }: { id: number }) {
  const { data, isFetching, refetch, error } = useQuery(q.issues.get(id).related('comments'))
  // data is guaranteed here — no null checks, no status branches
}
```

The exact contract:

1. **First mount, cold cache** → suspends. The only time it suspends.
2. **First mount, warm cache** → returns cached data synchronously, revalidates in the background (`isFetching: true`).
3. **Refetch with data present** (background revalidation, realtime-triggered, manual) → never suspends; current data stays up with `isFetching: true`.
4. **Params change** → that's a _different query_ with a cold cache entry, so it suspends. The hook never shows old data labeled with new params. Keeping the previous UI on screen during the switch is one `startTransition` away; see [the no-flash checklist](#no-flash-checklist).

**Errors after success don't unmount the screen.** If a refetch fails while data is showing, the hook keeps returning the last good `data` with `error` set. Show a toast or a banner; the next successful fetch clears it. Only a cold read with no data ever produced throws to the error boundary.

### Opting out of Suspense

Pass `{ suspense: false }` to get an explicit tagged union that never suspends or throws:

```tsx
const issues = useQuery(q.issues.related('creator'), { suspense: false })

if (issues.status === 'error') return <ErrorNote error={issues.error} />
if (issues.status !== 'success') return <Spinner /> // 'idle' | 'loading'
return <List items={issues.data} />
```

### Skipping

```ts
const { data } = useQuery(q.issues.get(id), { skip: id == null })
// data: Issue | undefined — the type reflects that a skipped query has no data
```

With definitions, put the condition in the args instead — `null` skips the query
without ever invoking the definition's build function, so no non-null assertion
is needed to satisfy the args type:

```ts
const { data } = useQuery(issueDetail, id ? { id } : null)
```

## Pagination

`.paginate()` turns a query into an infinite-scroll accumulator. Each loaded page is its own window on the server, and `data` is the concatenation of all loaded pages:

```tsx
const { data, loadMore, hasMore, isLoadingMore, loadMoreError, totalCount } = useQuery(
  q.issues
    .where({ status: 'open' })
    .orderBy('updatedAt', 'desc')
    .paginate({ pageSize: 25, returnTotal: true })
    .related('creator'),
)
```

- `loadMore()` appends the next page (no-op while one is in flight or when done)
- `hasMore` is sticky during loads so the button doesn't flicker
- `loadMoreError` reports a failed page load; calling `loadMore()` again retries the same page
- `totalCount` comes from the first page's meta when `returnTotal: true`
- `refetch()` re-fetches page 0 in place and drops follow-up pages (the dataset may have shifted)

Realtime events on a paginated query refetch the affected pages rather than merging locally. An inserted row may displace a page boundary invisibly, so the server stays the source of truth.

## Mutations

The write side is three pieces, each owning a different granularity:

1. **`m`** — the write proxy, the counterpart of `q`: services are properties, verbs are
   methods (`m.issues.patch(id, data)`), plus any custom methods from the schema. Not a
   hook: callable at module scope, in event handlers, in non-React code.
2. **`useAction(name?, fn)`** — per-action `pending`/`error` state around any async
   function. One hook call site per action.
3. **`useMutating(filter?)`** — "is anything in flight" at the entity, service, or
   instance level, seen across the whole app.

The split exists because pending state has two different identities. _Which button is
saving_ is an app-level concept the library can't know (reassign and close are both
`patch` on `issues`), so it lives at the hook call site. _Is anything mutating this
record_ is keyed by facts figbird does know (service, method, id), so it comes from the
store. The reads-side rule "params changes are transitions" gets a write-side mirror:
**reads suspend, writes are actions.**

```ts
await m.issues.create({ title: 'Ship it' })
await m.issues.patch(id, { status: 'closed' })
await m.issues.update(id, fullItem)
await m.issues.remove(id)
```

Every mutation returns a promise that settles on the **server response**, and the cache
updates flow to every query referencing the data.

### Optimistic by default; `confirmed` to wait

Writes are **optimistic by default**: show it now, roll back on failure. The cache
updates immediately and everywhere, and a server error rolls the change back everywhere
at once, emitting `mutate:rollback` for observability. Most product surfaces want this
mode: task lists, inline edits, comments.

Some surfaces are different. When the user must know the change saved before walking
away (settings, policies, anything contractual), opt out with the `confirmed` variant.
It shows the change only once it's real; the cache updates after the server acks:

```ts
m.issues.patch(id, { status: 'closed' }) // optimistic — the default, no flags

m.policies.confirmed.create(policy) // waits for the server ack
const policies = m.policies.confirmed // or name the surface once
```

Two things make the default safe. First, **awaiting is unaffected**: the promise settles
on the server response in both modes, so a flow that awaits and then shows "saved" behaves
identically. Optimism only controls when the _cache_ shows the change. Second,
failures are never silent: rollback is global, `useAction` gives every action an `error`
slot, and the events channel sees everything. `confirmed` is greppable on purpose. It
names your critical surfaces.

### Creates and ids: the id contract

**Optimistic creates carry a client-generated id the server will accept.** Everything
downstream is built on identity: React keys, realtime echo dedup, navigation, child-row
foreign keys. An optimistic item without a real id has none of that. So the two modes
have symmetric id stories:

```ts
// Optimistic: you mint the identity — real from the first frame
const id = crypto.randomUUID()
void m.issues.create({ id, title })
navigate(`/issues/${id}`) // safe: you own the id

// Confirmed: the server mints the identity — await it
const issue = await m.issues.confirmed.create({ title })
navigate(`/issues/${issue.id}`)
```

An optimistic create without an id **throws synchronously**, and the message names both
escapes: provide an id, or use `confirmed`. This is deliberate. Silently degrading would
mean the default's stated semantics ("shows immediately") quietly don't hold.

Because the optimistic item and the server's echo share the same id, the realtime
`created` event merges idempotently instead of duplicating, and rollback removes exactly
the item you created. Servers with auto-assigned ids (auto-increment PKs) can't accept
client ids; those services pair with `confirmed` creates. That's not a workaround, it's
the constraint stated plainly: you can't show a create optimistically if you can't name
what you created.

### Per-call options

Per-call options carry call-specific _data_ only. Write policy lives on the handle
variant, not per call:

- `params` — adapter params passthrough: `create(data, { params: { query: { ... } } })`.
- `optimisticItem` — an explicit synthesized cache item when the payload doesn't carry
  computed fields: `patch(id, data, { optimisticItem: { ...item, computedField } })`.
  Ignored on `confirmed` handles, which never show unconfirmed state.

### Per-action state: useAction

A screen with six buttons has six actions. Each gets its own `useAction`, with its own
pending label and its own inline error. There is no shared status slot and nothing to
multiplex:

```tsx
function Toolbar({ issue }: { issue: Issue }) {
  const close = useAction('close', () => m.issues.patch(issue.id, { status: 'closed' }))
  const remove = useAction('delete', async () => {
    await m.issues.remove(issue.id)
    navigate('/') // per-invocation consequences live inside the body
  })

  return (
    <>
      <button onClick={close.run} disabled={close.pending}>
        {close.pending ? 'Closing…' : 'Close'}
      </button>
      <button onClick={remove.run}>{remove.pending ? 'Deleting…' : 'Delete'}</button>
      {close.error ? <span>{close.error.message}</span> : null}
    </>
  )
}
```

The optional name labels `action:start/end/error` events on the observability channel, so
devtools read in the app's vocabulary ("close ok · 340ms") with the underlying
`mutate:*` rows alongside.

The exact semantics:

- `pending` is a **counter**, not a flag: with overlapping runs it stays true until the last settles.
- `error` and `data` are **slots**: the last settled outcome, cleared the moment a new run starts (a retry wipes the stale message immediately).
- `run()` **never rejects**. Failures land in `error`, so `onClick={run}` is always safe. Sequencing and per-call recovery belong inside the action body, which is plain async JS where `try`/`catch` and return values work natively. Corollary: `await run()` followed by success logic is a bug (it resolves on failure too); put the consequence in the body.
- The body runs as a **React Action** (async transition): if it triggers a navigation or a query change that would suspend, React keeps the previous UI committed instead of flashing a fallback. `await m.issues.remove(id); navigate('/')` leaves the old screen up until the destination is ready. Urgent synchronous UI (closing an editor, clearing an input) belongs _before_ `run()`, not inside the body. The `pending` flip itself stays urgent, so button labels swap immediately.
- The wrapped function is captured fresh each render. It closes over current props/state, no deps array.
- `reset()` clears `error`/`data` back to idle.

`useAction` wraps _any_ async function, not just figbird calls. It's the write-side
member of the no-flash kit and composes with `useDelayedFlag(action.pending, 300)` for
flicker-free labels. `run` also works directly as a React 19 form action
(`<form action={submit.run}>`), where the body receives the `FormData` and
`useFormStatus` lights up in the form's children.

**One identity, one call site.** Hoisting a single `useAction` over N list rows re-creates
the shared-slot problem one level up ("which row is pending?"). Give each row component
its own action; if you catch yourself wanting keyed pending state inside one hook, the
component boundary is in the wrong place. For the cross-cutting question, use
`useMutating`.

**Toggle actions and rapid clicks.** An action body closes over the render it was created
in, so two rapid clicks of a toggle both read the same `issue.status` and patch the same
value, losing an update. This isn't a `useAction` quirk; it's what closures do. The
mitigation is the disable pattern below (`useMutating` + `disabled`), which serializes
writes per record. Or express the change as data the server can apply idempotently.

### Entity-level activity: useMutating

`useMutating` answers "is any mutation in flight" for one entity, one service, or the
whole instance, no matter where the mutation was fired from:

```ts
const busy = useMutating({ service: 'issues', id: issue.id }) // this record
const saving = useMutating({ service: 'issues' }) // this service
const anything = useMutating() // anywhere
```

It's backed by a synchronous mutation tracker in the core (not the batched events
channel), so it is correct even for components that mount _while_ a mutation is already
in flight, and it sees writes from other components, route actions, and non-React code.

The canonical use is serializing writes to one record: overlapping optimistic patches to
the same row make rollback ambiguous, so disable the whole toolbar with
`useMutating({ service, id })` while any action on that record is in flight. Each
button's `useAction.pending` still labels _which_ one is running.

Caveats: optimistic creates are tracked by their client-generated id (the id contract
guarantees one); `confirmed` creates without a client id and custom-method calls carry no
`id`, so they never match an `{ id }` filter (they do match service-level filters).

### Custom methods

For everything beyond CRUD that your services expose (`archive`, `sendReminder`, and the
like), declare the method in the schema's `methods` and it appears directly on the
handle, fully typed:

```ts
await m.notes.archive(['id-1', 'id-2']) // args and result typed from the schema
await m.notes.call('undeclared', arg) // untyped escape hatch
```

**Custom methods don't write to the CRUD cache.** Their result shape is unknown to
figbird, so unlike the `create`/`update`/`patch`/`remove` sitting next to them on the
handle, calling one changes no query results by itself. Realtime events from the server
keep affected queries fresh, as with any other server-side change; on services without
realtime events, nudge manually with `figbird.refetch('service')` after the call. They
_do_ flow through the mutation tracker and the `mutate:*` observability events, so
`useMutating` and devtools see them. Wrap them in `useAction` for UI state like any other write. Reserved
names always mean the built-in: a schema method named `create`/`update`/`patch`/`remove`/
`call`/`confirmed` is shadowed by the handle; reach it via `call()`.

## Preparation

Three pieces make preparation work: `defineQuery` gives a query a stable, args-keyed identity;
`prepare` starts it early with an explicit lease; `prefetch` warms it speculatively. All three come
from your `createHooks` kit (a standalone `defineQuery` is also exported from `'figbird'` for
non-React code, and `prepare`/`prefetch` exist as instance methods).

### defineQuery

A named query is an args-keyed query factory. The same definition read from a component, prepared by a router, or prefetched on hover resolves to the **same cache entry**:

```ts
export const issueDetail = defineQuery(({ id }: { id: number }) =>
  q.issues.get(id).related('creator').related('comments'),
)

// component
const { data } = useQuery(issueDetail, { id: 42 })
```

Args are typed from the build function. When args arrive from an untrusted source like URL params or storage, pass a [Standard Schema](https://github.com/standard-schema/standard-schema) validator (zod, valibot, arktype…) as the middle argument. It runs at every call site and throws `QueryArgsError` on bad input, turning silent cache-splits (`{ id: "42" }` vs `{ id: 42 }`) into loud failures:

```ts
export const issueDetail = defineQuery(
  z.object({ id: z.coerce.number().int().positive() }),
  ({ id }) => q.issues.get(id).related('comments'),
)

prepare(issueDetail, { id: '42' }) // coerces "42" → 42 before building
```

### prepare

`prepare()` is the router's primitive: it starts a query and returns an explicit lease, with a `promise` that resolves when the data is ready and a `release()` to drop the pin keeping it alive. Routers await route-critical data before committing a navigation; the destination screen then reads the same cache entry synchronously:

```ts
// route definition — the `prepare:` key is the router's convention; the calls inside
// are Figbird's prepare(). Metadata like `priority` belongs to the router, not Figbird.
prepare: ({ params }) => [
  { ...prepare(issueDetail, { id: Number(params.id) }), priority: 'route' },
  { ...prepare(issueComments, { id: Number(params.id) }), priority: 'defer' },
]
```

Preparation is an _earlier read_, not a different one. The component still calls `useQuery(issueDetail, { id })`.

### prefetch

`prefetch()` is the idempotent, fire-and-forget sibling of `prepare()`, built for "the user will probably need this" moments like hover or viewport entry:

```tsx
<Row onMouseEnter={() => prefetch(issueDetail, { id: issue.id })} />
```

Safe to call at any frequency: if the query was prefetched within `staleTime` (default 30s) it's a no-op. Otherwise it fetches and holds an internal pin that auto-releases after `staleTime`. The data stays cached either way, so a later `useQuery` gets a warm, synchronous read with no Suspense fallback. If the user clicks through, the component's own subscription takes over seamlessly.

```ts
prefetch(issueDetail, { id }, { staleTime: 60_000 })
```

Rule of thumb: `prepare()` when you need to _await_ readiness or control the lease; `prefetch()` when you just want things warm.

## Realtime

Figbird subscribes to realtime events per service (at most once per service) the moment a query against it is active. What happens when an event arrives is decided by the query's **classification**. This is the library's central idea:

- **local-exact** — membership, order, and values are provable from local state. Events merge directly into the cached result: a created record that matches appears, a patched record updates in place, a removed one disappears. No network.
- **server-window** — the query is windowed (`$limit` / `$skip` / `$sort`, or `.paginate()`). Visible rows are known, but an event may change membership invisibly (a row you can't see may now belong), so events trigger a **refetch** of the window instead of a guess.
- **server-authoritative** — membership or values depend on logic only the server can evaluate: `$regex` and other non-local operators, `$select` projections, or an explicit `.server()`. Events always trigger a refetch.

Classification is automatic and per query node; the root and each relation classify independently. Adding `.limit(30)` to a query flips it from merge to refetch. That's by design, and `figbird.explain()` will tell you exactly that:

```ts
figbird.explain(
  q.issues
    .where({ title: { $regex: term } })
    .limit(30)
    .related('comments'),
)
// {
//   nodes: [
//     { path: '(root)', service: 'issues', kind: 'find',
//       class: 'server-authoritative',
//       reasons: [{ code: 'server-only-operator', detail: '$regex' },
//                 { code: 'window-filter', detail: '$limit' }],
//       realtime: 'refetch' },
//     { path: 'comments', service: 'comments', kind: 'find',
//       class: 'local-exact', reasons: [], realtime: 'merge' },
//   ]
// }
```

Use `.server()` on a builder when a query _looks_ locally provable but isn't, say for server-computed virtual fields, permission-dependent membership, or search ranking:

```ts
q.documents.where({ visibleTo: userId }).server()
```

### Teaching the client custom operators

The inverse escape hatch: when your API has a custom operator the client _could_
evaluate, register it on the adapter and queries using it stay realtime-mergeable
instead of classifying server-authoritative. The canonical example is `$asOf` on
effective-dated services:

```ts
const adapter = new FeathersAdapter(feathers, {
  operators: {
    $asOf: asOf => item => isEffectiveOn(item, asOf),
  },
})

// classifies local-exact — a patched endDate or a newly created row merges
// straight from the socket event, no refetch
useQuery(q.people.related('jobRole', r => r.where({ $asOf: today })))
```

The implementation receives the operand from the query (`'2026-07-06'`) and returns
an item predicate. Registered operators apply at the top level of the query, work in
relation refinements and `.all()` materialized reads alike, and show up in
`figbird.explain()` as local.

This is a correctness contract: the predicate must reproduce the server's membership
semantics for that operator _exactly_ — figbird trusts it to decide which realtime
events belong in which results. If the server's operator does more than filter (picks
one row among several, orders, dedupes), keep it unregistered and let refetching stay
authoritative. And mind operators whose meaning shifts with time: "current as of
today" changes at midnight with no event; a day-keyed operand rolls the cache entry
naturally.

### Reconciliation cadence

A refetch triggered by an event is a **reconciliation**, not a freshness requirement:
correctness demands the query reconciles with the server _eventually_ after the last
relevant event, not within milliseconds of each one. The engine owns the cadence (there
is no per-query throttle config) via two built-in guards on event-driven refetches:

- **Cooldown with a trailing edge.** A query reconciles at most once per
  `reconcileCooldown` (default 2s, a `Figbird` constructor option; `0` disables). The
  first event refetches immediately, so isolated changes land as fast as ever. Further
  events within the window coalesce into **one guaranteed trailing refetch**: a
  500-event bulk import costs each affected query about two refetches instead of fifty,
  and still lands on the final answer. The trailing edge is the correctness guarantee;
  the interval is UX tuning.
- **Hidden tabs don't reconcile.** When the tab is hidden, event-driven refetches are
  deferred (queries show as `pending` in `inspect()`) and reconcile once on
  `visibilitychange`. The reconnect sweep is gated too, so a background tab riding
  through network blips stops replaying refetch storms. Local-exact merges keep flowing
  while hidden (they're free); only network reconciliation pauses. Inject a custom
  `visibility` source in the constructor for non-browser environments.

Manual `refetch()`, first fetches, and SWR revalidation are user/loader intent and are
never gated.

One practical consequence: an **unwindowed** relation like `.related('comments')` is local-exact, so a teammate's new comment merges straight from the socket event with no refetch. If you don't need a window, don't add one.

### Freshness tolerance: staleTime

By default every mount revalidates cached data in the background (SWR). `staleTime` is the
reader's tolerance: data younger than it skips the revalidation.

```ts
useQuery(q.currencies, { staleTime: 60_000 }) // revalidate at most once a minute
useQuery(q.currencies, { staleTime: Infinity }) // cache-first
```

It is a read-site option, not query identity: readers with different tolerances share one cache
entry, and the most demanding one keeps it freshest. `prepare()` and `prefetch()` accept it too.

### Freezing a query: .snapshot()

`.snapshot()` fetches once and then ignores realtime entirely, for the root and every
relation under it: no merges, no event-triggered refetches. `refetch()` is the only way it
moves. Frozen and live reads of the same filters don't share a cache entry (snapshot-ness
changes what the data means). Use it for audit views, diff screens, "results as of when
you searched".

### Exhaustive reads: .all()

`.all()` fetches **every row matching the query**. All pages are drained, so the server's
default page cap never silently truncates the result. Without it, an unwindowed find returns a
single server page; that cap is the safety mechanism (an unbounded query shouldn't slurp the
world by accident), and `.all()` is the explicit opt-in to "I want the complete set".

Filtered, it reads a complete slice:

```ts
// every open issue for this team — however many pages that takes
useQuery(q.issues.where({ teamId, status: 'open' }).all())
```

Completeness makes realtime cheap: an event either matches the filter and belongs in
the set or it doesn't, so the slice is maintained by local merges with no refetching.

Unfiltered, it doubles as the reference-data preload (locations, currencies, roles). On success
the service is **fully materialized**: every later find the client can evaluate, including
sorted and limited windows, is answered locally from the cache with **no network roundtrip**,
and realtime events maintain the set. Typically paired with preparation at the app shell:

```ts
export const allLocations = defineQuery('allLocations', () => q.locations.all())

// at the app shell — args omitted: the definition takes none
prepare(allLocations)

// later, anywhere — no fetch:
useQuery(q.locations.where({ countryCode: 'GB' }).orderBy('name').limit(10))
```

A few properties worth knowing:

- `.limit()`/`.skip()` can't be combined with it — windowing contradicts "all"; use
  `.paginate()` for incremental loading. `.orderBy()` is fine: order doesn't affect
  completeness, so a sorted, unfiltered `.all()` still materializes
- a **filtered** `.all()` is complete for that exact query only — it does not materialize the
  service, and narrower reads (say `country + city` after `.where({ country }).all()`) are
  separate queries that fetch on their own
- it may chain `.related()` to preload joined reference sets
- the materialized set reconciles on reconnect, even with no subscribers
- server-only predicates (`$regex`, `$select`, `.server()`) still go to the server

Whether a set warrants `.all()` is your judgment call. Reach for it only where the
matching row count is bounded, for the whole service and for a filtered slice alike.

# Guides

## No-flash checklist

`useQuery` never lies about identity: when a query's params change, that is a _different_
query with a cold cache entry, and the hook suspends rather than showing old data labeled
with new params. Honoring that contract without loading flashes takes three moves, one
per failure mode. The helpers below (`useDebouncedTransition`, `DelayedFallback`,
`useDelayedFlag`) all ship with Figbird.

**1. Param changes (filters, tabs, sort) — wrap the state update in a transition.**
Without it, clicking a filter unwinds to the Suspense fallback while the new query loads.

```tsx
const [isPending, startTransition] = useTransition()
const setStatusFilter = next => startTransition(() => setStatus(next))
// isPending is your "catching up" signal — dim the list, don't unmount it
```

**2. Text inputs (search) — debounce _into_ a transition with `useDebouncedTransition`.**
Debouncing alone still flashes when the value commits; a transition alone queries per
keystroke. This helper does both:

```tsx
const search = useDebouncedTransition(searchInput.trim(), 250)
```

**3. Wanted suspensions (first mount, navigation) — delay the fallback.**
If data arrives in 120ms, a 120ms skeleton is worse than nothing. `DelayedFallback`
renders nothing briefly, then the skeleton, so fast loads never flash:

```tsx
<Suspense fallback={<DelayedFallback delay={250}><Skeleton /></DelayedFallback>}>
```

For `isFetching` spinners (background revalidation), the same principle is
`useDelayedFlag(isFetching, 300, 800)`: show only if slow, and once shown, don't yo-yo.

One more pattern from the same family: when navigating between details of the same shape (issue 1 → issue 2), key the Suspense boundary by the id. Each destination gets its own cold boundary and skeleton instead of briefly showing the previous item's data:

```tsx
<Suspense key={issueId} fallback={<DetailSkeleton />}>
  {children}
</Suspense>
```

## Instant navigation

The pattern that makes navigations feel instant is starting everything the destination needs, data _and_ code, before the screen renders, in parallel:

```ts
// 1. Named queries live in an eagerly-loaded module
export const issueDetail = defineQuery(({ id }: { id: number }) =>
  q.issues.get(id).related('creator').related('labels'),
)

// 2. The route fires data preparation and the lazy chunk import in parallel —
//    navigation latency becomes max(chunk, data) instead of chunk + data
{
  path: '/issues/:id',
  resolver: () => import('./pages/IssueDetail/screen'),
  prepare: ({ params }) => [prepare(issueDetail, { id: Number(params.id) })],
}

// 3. Hover starts the same queries even earlier — clicking is then a warm read
<Row onMouseEnter={() => prefetch(issueDetail, { id })} />

// 4. The screen just reads — warm visits render synchronously, no fallback
const { data } = useQuery(issueDetail, { id })
```

Because all three paths resolve to the same cache entry (the definition + args hash), there is no coordination to do. Preparation is simply an earlier read.

## Using outside React

The core is framework-agnostic, which is useful for background sync, tests, and non-React code. The instance mirrors the React kit exactly: `q` builds, `query` reads, `m` writes.

```ts
const figbird = new Figbird({ adapter, schema })

// Reads — same builders as the hooks; query() is the non-React useQuery
const ref = figbird.query(q.issues.where({ status: 'open' }).related('creator'))
const unsub = ref.subscribe(state => {
  // { status, data, error, isFetching }
})
ref.getSnapshot()
ref.refetch()
unsub()

// Definitions work too — same cache entry as useQuery(issueDetail, { id })
figbird.query(issueDetail, { id: 42 })

// Writes — the m proxy works outside React too (it's not a hook anywhere)
await figbird.m.tasks.patch(id, { done: true }) // optimistic by default
await figbird.m.tasks.confirmed.patch(id, { done: true }) // waits for the ack
await figbird.m.tasks.archive([id]) // custom schema methods, typed
```

Below that sits the **descriptor layer**: plain `{ serviceName, method }` objects, no
schema required. It's the primitive the relational engine itself is built on, and the
only surface a schema-less instance can use.

```ts
const query = figbird.queryDesc({
  serviceName: 'tasks',
  method: 'find',
  params: { query: { completed: true } },
})
query.subscribe(state => {})

await figbird.mutateDesc({ serviceName: 'tasks', method: 'patch', id, data: { done: true } })
```

## Testing

`figbird/testing` ships an in-memory, Feathers-compatible client so component tests
run against real figbird — schema, cache, realtime, optimistic writes — instead of
mocks of it:

```ts
import { mockFeathers } from 'figbird/testing'

const feathers = mockFeathers(
  { issues: { data: { 1: { id: 1, title: 'Ship it', status: 'open' } } } },
  { queryAwareFind: true }, // find honors equality, $in, and $sort filters
)
const figbird = new Figbird({ adapter: new FeathersAdapter(feathers), schema })
```

Render with hooks bound to this instance (or inject it via `FigbirdProvider`), then:

- simulate server-side changes: `feathers.service('issues').emit('patched', {...})` —
  they flow through the realtime pipeline like socket events
- assert fetch behavior: `feathers.service('issues').counts.find`
- mutations through `m` hit the mock's CRUD, which emits the realtime echo like a
  real server would

Figbird's own test suite runs on this client.

## Custom adapters

Figbird works with any REST / WebSocket / RPC API wrapped in a Figbird-compatible adapter:

1. Structure your API around services or resources
2. Support the operations `find`, `get`, `create`, `update`, `patch`, `remove`
3. For realtime, emit `created`, `patched`, `updated`, `removed` events after mutations
4. Optionally implement `subscribeToReconnect` so active queries refetch after connectivity gaps

For example, a `comments` resource maps to `GET /comments`, `GET /comments/:id`, `POST /comments`, `PUT/PATCH/DELETE /comments/:id`, with `find` returning `{ data, total, limit, skip }` or similar. See [`lib/adapters/feathers.ts`](https://github.com/humaans/figbird/blob/master/lib/adapters/feathers.ts) for the reference implementation of the `Adapter` interface.

## Comparison

Every data library is a bet on where your app's complexity lives. Figbird bets on a
**server-authoritative backend with realtime events**, read by **long-lived, app-shaped
screens** that several people have open at once. The libraries below make different
bets. Each is the right tool for a different problem, so the comparisons cut both ways.

### TanStack Query

TanStack Query caches the results of arbitrary async functions under opaque keys.
That's its strength: any backend, any protocol, no schema. It's also the limitation.
The cache can't see inside a result, so the same record fetched by ten queries exists
as ten copies, and keeping them in sync is your job. In practice this means invalidation
choreography: every mutation lists the query keys it may have affected. Freshness is
heuristic: `staleTime`, refetch-on-focus, polling.

Figbird's cache is **normalized**. An entity lives once, queries are views over it, and
a mutation or socket event updates every query that references the record. There is no
invalidation API because there is nothing to invalidate. Optimistic updates are the
default, with automatic rollback; in TanStack that's a hand-written `onMutate` recipe
per mutation.

Choose TanStack when your API is a mix of shapes and vendors, or when you have no
realtime channel. Figbird wants service-shaped resources, and without server-emitted
events you keep the caching but lose the self-updating part.

### React Server Components

RSC moves reads to the server: no client fetching code, direct data access, great first
paint. It's a request/response model. The page is data at a moment in time, and keeping
it fresh means re-rendering server trees, which is coarse and tied to navigation.

Figbird is for the screen that _stays open_. An issue tracker, a dashboard: a teammate's
change should show up in the open view without anyone navigating. That takes a live
client cache, socket events merging into it, and optimistic writes. RSC deliberately has
none of these, and once you add interactivity you're writing client components that need
a data layer anyway.

The two compose well. Use RSC for the document-shaped pages you visit once, figbird for
the workspace inside. If your product is read-mostly and request-scoped, RSC alone is
right; figbird is dead weight on a blog.

### Relay + GraphQL

Relay is the most principled client cache in the ecosystem: normalized store,
per-component data requirements, compile-time guarantees against over- and
under-fetching. The price is a GraphQL server, a compiler step, codegen, and fragment
ceremony at every component boundary. What that ceremony chiefly buys is **data
masking**, which keeps teams decoupled at hundreds-of-engineers scale and mostly
doesn't matter below it.

Figbird reaches the same normalized store with none of that pipeline: one TypeScript
schema, inference instead of codegen, plain functions instead of fragments, your
existing services instead of a GraphQL layer. Realtime is built in rather than bolted
on. GraphQL subscriptions exist, but wiring them into a normalized store correctly is
left to you; in figbird that wiring _is_ the library.

Choose Relay at the scale masking was built for, when you need field-level fetch
efficiency (figbird fetches whole rows), or when GraphQL is already your API.

### Zero (and sync engines generally)

Zero syncs a queryable replica into the client. Reads are local-first and instant,
writes rebase through custom mutators, and there is no refetch model because the replica
diffs in continuously. The overlap with figbird isn't accidental: client-generated ids,
optimistic-by-default writes, and queries as live views are all Zero ideas, borrowed
where they fit a server-authoritative world.

The difference is infrastructure. Zero means running its sync layer (zero-cache,
Postgres logical replication) and adopting its permission model; your backend commits to
the sync engine. Figbird runs against the backend you already have and can be adopted
one screen at a time. It also keeps server-only logic natural: `$regex` search or
permission-dependent membership classify as server-authoritative and reconcile by
refetch, where a replica has to sync everything a query touches or fall back to the
server anyway.

Choose Zero when you're greenfield on Postgres and willing to run the infrastructure;
local-first everywhere is the stronger end state. Choose figbird when the server must
stay authoritative, or you want most of the live-app feel without changing your backend.

# API: Core

## q

The read proxy: services as properties, each yielding an immutable, hashable query
builder. See [Queries](#queries) and [Relations](#relations) for the semantics.

```ts
q.issues // a QueryBuilder for the issues service
q('issues') // dynamic service name
```

The full builder surface:

| Method                                  | Meaning                                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `.where(filters)`                       | Merge filter conditions (deep-merged across calls); typed against the item, admits dotted paths and `$` operators |
| `.orderBy(field, dir?)`                 | Add a sort clause; calls accumulate                                                                               |
| `.limit(n)` / `.skip(n)`                | Window the result (`$limit` / `$skip`)                                                                            |
| `.get(id)`                              | Resource fetch by pk (`GET /:service/:id`); `.where()` after it rides along as `params.query`                     |
| `.related(name, refine?)`               | Attach a schema relation; the refine callback filters/windows/nests the related query                             |
| `.paginate({ pageSize, returnTotal? })` | Infinite-scroll accumulator — the hook result widens with `loadMore`/`hasMore`/`totalCount`                       |
| `.server()`                             | Mark server-maintained: realtime events refetch instead of merging locally                                        |
| `.snapshot()`                           | Freeze as point-in-time: realtime is ignored; only `refetch()` moves it                                           |
| `.all()`                                | Preload the complete set; later reads against the service answer locally                                          |

Builders are immutable values identified by a stable content hash, so constructing them
inline in render needs no dependency arrays. Also available as `figbird.q`.

## useQuery

```ts
// Suspense (default)
const { data, error, isFetching, refetch } = useQuery(builder)
const { data } = useQuery(definition, args)

// Paginated builders widen the result
const { data, loadMore, hasMore, isLoadingMore, loadMoreError, totalCount } = useQuery(
  q.issues.paginate({ pageSize: 25, returnTotal: true }),
)

// Tagged union, never suspends or throws
const result = useQuery(builder, { suspense: false })
// result: { status: 'idle' | 'loading' | 'success' | 'error', data, error, isFetching, refetch }

// Conditional fetching
const { data } = useQuery(builder, { skip: id == null }) // data: T | undefined
```

Options: `skip?: boolean`, `suspense?: boolean` (must be static per call site), `staleTime?: number` (freshness tolerance — see [Realtime](#realtime)).

Result fields (suspense form): `data` (guaranteed for the exact query passed), `error`
(non-null when a refetch failed while data is showing; cold errors throw instead),
`isFetching` (background fetch in flight on the current query), `refetch()`.

## m

```ts
m.notes.create(data, options?)   // Promise<Item>; arrays create in batch
m.notes.update(id, data, options?)
m.notes.patch(id, data, options?)
m.notes.remove(id, options?)
m.notes.archive(...args)         // custom methods from the schema, typed
m.notes.call(method, ...args)    // untyped custom-method escape hatch

m.notes.confirmed                // variant that waits for the server ack
```

The write proxy: services as properties, mirroring `q`. Handles are stateless,
instance-bound plain values (not hooks): access them at module scope and call from
anywhere. Writes are optimistic by default; `confirmed` variants update the cache only
after the server acks. Handles hold no pending/error state by design; that's
[useAction](#useaction) and [useMutating](#usemutating). Per-call `options` carry data
only: `{ params?: AdapterParams, optimisticItem?: Item }`. Also available as `figbird.m`.
Like `q`, the proxy is callable for dynamic service names: `m(name)` is `m.<name>` with a
string-typed door.

## useAction

```ts
const action = useAction(fn) // fn: (...args) => Promise<T> | T
const action = useAction(name, fn) // name labels action:* events for devtools

action.run(...args) // Promise<void> — never rejects; failures land in `error`
action.pending // boolean — counter semantics across overlapping runs
action.error // Error | null — last settled failure, cleared when a new run starts
action.data // T | null — last successful result, cleared when a new run starts
action.reset() // clear error/data
```

Per-action UI lifecycle around any async function, one hook call site per action. The
body runs as a React Action (async transition), so suspense-triggering consequences
(navigation after a write, a query change) keep the previous UI on screen; `run` also
works directly as a React 19 `<form action>`. Named actions emit `action:start/end/error`
on the observability channel (via the kit's bound instance, or the context instance for
the root export). See [Per-action state](#per-action-state-useaction) for the semantics
and the one-identity-one-call-site rule.

## useMutating

```ts
useMutating() // any mutation in flight, anywhere
useMutating({ service, id?, method? }) // narrowed; service accepts schema keys
```

Returns a boolean, live via `useSyncExternalStore` over `figbird.mutating`, the core's
synchronous tracker. It's correct for components that mount mid-mutation and it sees
writes from any surface. See [Entity-level activity](#entity-level-activity-usemutating).

## defineQuery

```ts
defineQuery(build)
defineQuery(argsSchema, build) // Standard Schema-validated args
defineQuery(name, build) // optional name — labels errors and devtools, never identity
defineQuery(name, argsSchema, build)
```

Args-keyed query factory. A pure value, not tied to an instance; `prepare`,
`prefetch`, and `useQuery` against the same definition and args share one cache entry.
The `createHooks` kit returns a schema-typed version; the standalone export from
`'figbird'` serves non-React code. See [Preparation](#preparation).

## figbird.prepare

```ts
const { key, promise, release } = figbird.prepare(definition, args, { staleTime? })
```

Starts a query and returns an awaitable lease, the router-grade primitive. `args` may be
omitted when the definition's build function takes none. See [prepare](#prepare).

## figbird.prefetch

```ts
figbird.prefetch(definition, args, { staleTime? }) // staleTime defaults to 30s
```

Idempotent, fire-and-forget speculative warming with a self-releasing pin. See
[prefetch](#prefetch).

## useDebouncedTransition

```ts
const search = useDebouncedTransition(searchInput.trim(), 250)
```

Debounced value committed inside a React transition: the search-input pattern. Debouncing
alone still flashes when the value commits; a transition alone queries per keystroke. See
[the no-flash checklist](#no-flash-checklist).

## DelayedFallback

```tsx
<Suspense fallback={<DelayedFallback delay={250}><Skeleton /></DelayedFallback>}>
```

A Suspense fallback that only appears when loading is actually slow, so fast loads never
flash a skeleton.

## useDelayedFlag

```ts
const showSpinner = useDelayedFlag(isFetching, 300, 800)
```

Spinner flag that turns on only after `delay` ms of sustained truth, and once shown stays for
at least `minVisible` ms. No flashing, no yo-yo.

# API: Setup

## createSchema

```ts
const schema = createSchema({ services, relationships? })
```

Builds the typed schema. `services` keys become literal service names that every API narrows
on. `relationships` takes one factory per source service, each receiving `{ one, many, embed }`
helpers scoped to that service — so `sourceField`, `destService`, and `destField` all
type-check against the actual items, including both hops of a junction `many`.

## service

```ts
service<{ item: Note; query?: NoteQuery; create?; update?; patch?; methods? }>(options?)
```

Declares one service's types. Only `item` is required; omitted payloads default to
`Partial<item>` for create/patch and `item` for update. `options.path` maps an ergonomic
schema key to the transport-level service path. `methods` types custom Feathers methods.

## one

```ts
creator: one({ sourceField: 'creatorId', destService: 'users' })

// two-hop (chained lookup) — person.jobRole resolves through the employment
jobRole: one(
  { sourceField: 'currentEmploymentId', destService: 'employments' },
  { sourceField: 'jobRoleId', destService: 'jobRoles' },
)
```

Single related item, assembled as `T | null` — single-hop, or chained through an
intermediate service (first match resolves; make the first hop selective).
`destField` defaults to `'id'`; fields accept `string | string[]` for compound keys.

## many

```ts
comments: many({ sourceField: 'id', destService: 'comments', destField: 'issueId' })

// two-hop (junction table) — traversed transparently, consumers get Label[] directly
labels: many(
  { sourceField: 'id', destService: 'issueLabels', destField: 'issueId' },
  { sourceField: 'labelId', destService: 'labels' },
)
```

Array relation, single-hop or two-hop through a junction service.

## embed

```ts
spotlight: embed({ sourceField: 'spotlightIssueIds', destService: 'issues' })
```

The parent carries a server-maintained list of destination ids; Figbird fans every parent's
list into one batched `IN (...)` fetch and assembles per-parent slices preserving the server's
order.

## Figbird

The core instance holding the adapter, schema, and shared query state.

```ts
const figbird = new Figbird({ adapter, schema, eventBatchInterval? })
```

| Member                                            | Description                                                                                                                                                 |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `q`                                               | The builder proxy — `q.issues.where(...)`. Requires a schema.                                                                                               |
| `prepare(definition, args)`                       | Awaitable query lease for routers — also returned bound from `createHooks`. See [figbird.prepare](#figbirdprepare).                                         |
| `prefetch(definition, args, opts?)`               | Idempotent speculative warming — also returned bound from `createHooks`. See [figbird.prefetch](#figbirdprefetch).                                          |
| `refetch(service?)`                               | Manual refetch escape hatch for changes figbird can’t observe (custom methods without events, out-of-band writes) — also returned bound from `createHooks`. |
| `m`                                               | The write proxy — `m.issues.patch(...)`, callable as `m(service)` for dynamic names — also returned bound from `createHooks`. See [m](#m).                  |
| `mutating`                                        | Synchronous in-flight mutation tracker (`subscribe`/`getSnapshot`) — `useMutating` is its React binding.                                                    |
| `explain(...)`                                    | Static classification report — see [figbird.explain](#figbirdexplain).                                                                                      |
| `inspect()`                                       | Live-query snapshot — see [figbird.inspect](#figbirdinspect).                                                                                               |
| `events`                                          | Observability channel — see [figbird.events](#figbirdevents).                                                                                               |
| `query(builder)`                                  | Live query ref for non-React use — the `useQuery` mirror; also accepts `(definition, args)`. See [Using outside React](#using-outside-react).               |
| `queryDesc(desc, config?)`                        | Descriptor-layer query — no schema required.                                                                                                                |
| `mutateDesc(desc)` / `call(service, method, ...)` | Descriptor-layer mutation / custom-method call.                                                                                                             |
| `getState()` / `subscribeToStateChanges(fn)`      | Raw internal state, including the cached entities themselves (`inspect()` omits items). Debug-grade — shapes may change between versions.                   |

## FeathersAdapter

Connects Figbird to a Feathers.js backend: data fetching, realtime subscriptions, reconnect
handling (all active queries refetch on the socket's `reconnect`), and translation between
Figbird's query format and Feathers conventions.

```ts
const adapter = new FeathersAdapter(feathers, options)
```

- `feathers` — feathers client
- `options`
  - `idField` — string or function, defaults to `item => item.id || item._id`
  - `updatedAtField` — string or function, defaults to `item => item.updatedAt || item.updated_at`; used to avoid overwriting newer cached data with older data when requests race
  - `defaultPageSize` — default `query.$limit` when fetching, unset by default so the server decides
  - `defaultPageSizeWhenFetchingAll` — default `query.$limit` when fetching with `allPages`
  - `operators` — custom query operators the client can evaluate (`{ $asOf: asOf => item => boolean }`); queries using them stay realtime-mergeable. See [Teaching the client custom operators](#teaching-the-client-custom-operators)

Meta behavior: `find` returns `{ data, meta }` (`FindMeta`: `{ total, limit, skip }`); `get` returns only the item.

## createHooks

Binds a Figbird instance to typed React hooks:

```ts
export const { useQuery, q, m, defineQuery, prepare, prefetch, refetch, useAction, useMutating } =
  createHooks(figbird)
```

Returns the daily-use kit: `useQuery`, `q` (the read proxy), schema-typed
`defineQuery`, instance-bound `prepare`/`prefetch`, and the write side — `m` (the write
proxy), `useAction` (per-action state), and `useMutating` (in-flight activity). Also
includes `useFeathers` (the raw-client escape hatch) and the deprecated legacy hooks
(`useMutation`, `useFind`, `useGet`) for older codebases.

Instance resolution: hooks use the bound instance directly, so no provider is required. If a
`FigbirdProvider` is present in the tree, **it wins**; that's the injection point for
per-request SSR instances and tests. A dev-mode error fires if a provider holds a _different_
instance than the bound one.

## FigbirdProvider

Optional. Hooks from `createHooks` work without any provider; use one to inject a different
instance into a subtree, like per-request instances in SSR or a fresh instance per test:

```tsx
<FigbirdProvider figbird={testFigbird}>{ui}</FigbirdProvider>
```

`useFigbird()` reads the context instance (throws without a provider); `useFigbirdMaybe()`
returns `undefined` instead.

# API: Observability

## figbird.explain

```ts
figbird.explain(builderOrDefinition, args?)
// → { nodes: [{ path, service, kind, class, reasons, realtime, via? }] }
```

Static analysis of a query: one entry per node (root + each relation, dotted paths for
nesting) with its classification, the structured reasons that produced it
(`{ code: 'server-only-operator', detail: '$regex' }`), and the resulting realtime mode.
No fetching happens, so it's callable anywhere and assertable in tests. See
[Realtime](#realtime) for a worked example.

## figbird.inspect

```ts
figbird.inspect()
// → [{ queryId, serviceName, method, query, classification,
//      status, isFetching, itemCount, fetchedAt, subscriberCount }]
```

Read-only snapshot of every query currently in the store: the stable projection to build
devtools on (internal store shapes stay free to change).

## figbird.events

Emits lifecycle facts: fetches, realtime events, mutations (including optimistic rollbacks).
Delivery is batched on a microtask and never happens mid-render, so subscribing from React
components is safe:

```ts
const unsub = figbird.events.subscribe(event => {
  // event.kind: 'fetch:start' | 'fetch:end' | 'fetch:error' | 'realtime'
  //           | 'mutate:start' | 'mutate:end' | 'mutate:error' | 'mutate:rollback'
  //           | 'action:start' | 'action:end' | 'action:error'
})
```

Events carry ids, durations, and item counts, lightweight enough to subscribe in
production. `mutate:*` events carry a `mutationId` correlating one mutation's
start/end/error/rollback, and their `method` is a CRUD name or a custom method name
(custom-method calls flow through the same lifecycle events). `action:*` events come from
named `useAction` hooks and speak the app's vocabulary ("reassign · 340ms"), with the
`mutate:*` rows they wrap alongside.

## useFeathers

Returns the underlying Feathers client, the escape hatch for one-off operations outside
Figbird's caching layer:

```ts
const feathers = useFeathers()
await feathers.service('notes').get('1')
await feathers.service('notes').archive(['1', '2']) // custom methods fully typed
```

When obtained from `createHooks`, the client and every service are typed from your
schema, including custom `methods`.

# API: Deprecated

## useMutation

**Deprecated** — prefer [m](#m) + [useAction](#useaction) + [useMutating](#usemutating).
This hook is a service client and a single status slot in one, which forces hand-rolled
pending-state machines on multi-action screens. Writes through it are always
non-optimistic; optimistic writes are a feature of `m`. Fully functional and not going
away soon.

```ts
const m = useMutation(serviceName)

m.create(data, params?)   // Promise<Item>; arrays create in batch
m.update(id, data, params?)
m.patch(id, data, params?)
m.remove(id, params?)
m.status  // 'idle' | 'loading' | 'success' | 'error' — last call from this hook
m.data    // last mutation result
m.error   // last mutation error
```

## useFind

**Deprecated** — prefer `useQuery(q.service.where(...))`.

```ts
const { data, meta, status, isFetching, error, refetch } = useFind(serviceName, params)
```

`params` combines Feathers params with Figbird options (builder queries manage all of these
automatically, via `swr` + classification-driven realtime):

- `skip` — don't fetch
- `realtime` — how events affect this query: `merge` (default — matching events merge into the
  cached result), `refetch` (any event on the service refetches; results cached per-query), or
  `disabled` (events don't touch it; refresh manually via `refetch()`)
- `fetchPolicy` — cache vs network: `swr` (default — show cached, revalidate in background),
  `cache-first` (fetch only when nothing is cached), or `network-only` (always fetch;
  hook-scoped results)
- `allPages` — fetch all pages (`parallel` + `parallelLimit` control concurrency)
- `matcher` — custom `(query) => (item) => boolean` for realtime merging

## useGet

**Deprecated** — prefer `useQuery(q.service.get(id))`.

```ts
const { data, status, isFetching, error, refetch } = useGet(serviceName, id, params)
```

Same Figbird params as `useFind` (minus pagination). No `meta` by default.
