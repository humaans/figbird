---
title: 'Figbird'
draft: false
toc: true
---

# Figbird

A realtime, relational data layer for [React](https://reactjs.org/) + [Feathers](https://feathersjs.com/) applications. Used in production at [Humaans](https://humaans.io/).

Figbird gives you one query hook that fetches an entity graph — a record together with its relations — and keeps it updated. When a record changes, from this component, another component, or a realtime event from the server, every query referencing that data re-renders with the new state. No cache invalidation, no manual refetching.

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
- **Optimistic mutations, by default** — writes show immediately and roll back on failure everywhere at once; `confirmed` for surfaces that wait
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
  relationships: ({ one, many }) => ({
    issues: {
      creator: one({ sourceField: 'creatorId', destService: 'users' }),
      comments: many({ sourceField: 'id', destService: 'comments', destField: 'issueId' }),
    },
    comments: {
      author: one({ sourceField: 'authorId', destService: 'users' }),
    },
  }),
})

export const figbird = new Figbird({
  adapter: new FeathersAdapter(feathersClient),
  schema,
})

// The daily-use kit, bound to this instance.
export const { useQuery, q, m, defineQuery, prepare, prefetch, useAction, useMutating } =
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

No `FigbirdProvider` is needed — the hooks are bound to the instance they were created with. (A provider, when present, overrides the bound instance; see [FigbirdProvider](#figbirdprovider).)

# Concepts

## Schema

The schema is the first thing you write: it declares your services, their types, and the
relationships between them — and it is where all of Figbird's TypeScript inference comes from,
with no code generation.

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
  relationships: ({ one, many, embed }) => ({
    /* ... */
  }),
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
q.locations.all() // preload the complete set (reference data)
```

Builders are immutable — every method returns a new builder — and identified by a stable hash of their contents, so you can build them inline in render with no dependency arrays:

```tsx
function IssueList({ status }: { status: string }) {
  const { data } = useQuery(q.issues.where({ status }))
  // a new builder every render, but the same query identity while `status` is stable
}
```

`.where()` autocompletes and type-checks the fields of the service's item type, and also admits everything it can't statically know: dotted relational paths (`'creator.teamId'`), server-only operators (`$regex`), and dynamically-built filter objects.

`.get(id)` is the resource-endpoint fetch (`GET /issues/:id`) with "this must exist"
semantics: a cold fetch of a missing row enters the error state, while realtime removal
of a row you're viewing nulls the data — hence `T | null`. Chaining `.where()` after it
sends the conditions along as `params.query`. For "the first match of a filter, if any",
use `.where(...).limit(1)` and destructure the array.

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

Relation names autocomplete from the schema and the result type is assembled automatically — including nesting and cardinality (`one` → `T | null`, `many`/`embed` → `T[]`).

Three relationship kinds cover the shapes you'll meet:

```ts
relationships: ({ one, many, embed }) => ({
  issues: {
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
  },
  teams: {
    // embed: the parent carries a server-maintained list of ids; Figbird fans
    // every parent's list into ONE batched IN(...) fetch, preserving order
    spotlight: embed({ sourceField: 'spotlightIssueIds', destService: 'issues' }),
  },
})
```

`destField` defaults to `'id'`; fields accept arrays for compound keys. Relations stay live: a realtime event on any involved service — a new comment, a renamed user, a new junction row — flows into the assembled result.

Relational queries fetch efficiently: a single `IN (...)` query per relation level (not per parent), junction traversal in two queries, `embed` in one. The exception is a **windowed relation** — `.related('recent', i => i.orderBy(...).limit(5))` needs one query _per parent_ because per-parent windows can't be expressed as a single find; Figbird warns past 10 parents and points at `embed` as the batched alternative.

Relational filters work too — filter parents by a field on a related entity with a dotted path:

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

The contract, precisely:

1. **First mount, cold cache** → suspends. The only time it suspends.
2. **First mount, warm cache** → returns cached data synchronously, revalidates in the background (`isFetching: true`).
3. **Refetch with data present** (background revalidation, realtime-triggered, manual) → never suspends; current data stays up with `isFetching: true`.
4. **Params change** → that's a _different query_ with a cold cache entry, so it suspends — the hook never shows old data labeled with new params. Keeping the previous UI on screen during the switch is one `startTransition` away; see [the no-flash checklist](#no-flash-checklist).

**Errors after success don't unmount the screen.** If a refetch fails while data is showing, the hook keeps returning the last good `data` with `error` set — show a toast or a banner; the next successful fetch clears it. Only a cold read with no data ever produced throws to the error boundary.

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

## Pagination

`.paginate()` turns a query into an infinite-scroll accumulator — each loaded page is its own window on the server, and `data` is the concatenation of all loaded pages:

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

Realtime events on a paginated query refetch the affected pages rather than merging locally — an inserted row may displace a page boundary invisibly, so the server stays the source of truth.

## Mutations

The write side is three pieces, each owning a different granularity:

1. **`m`** — the write proxy, the counterpart of `q`: services are properties, verbs are
   methods (`m.issues.patch(id, data)`), plus any custom methods from the schema. Not a
   hook — callable at module scope, in event handlers, in non-React code.
2. **`useAction(name?, fn)`** — per-action `pending`/`error` state around any async
   function. One hook call site per action.
3. **`useMutating(filter?)`** — "is anything in flight" at the entity, service, or
   instance level, seen across the whole app.

The split exists because pending state has two different identities. _Which button is
saving_ is an app-level concept the library can't know (reassign and close are both
`patch` on `issues`) — so it lives at the hook call site. _Is anything mutating this
record_ is keyed by facts figbird does know (service, method, id) — so it comes from the
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

Writes are **optimistic by default** — "show it now, roll back on failure": the cache
updates immediately (and everywhere), and a server error rolls the change back everywhere
at once, emitting `mutate:rollback` for observability. This is the right mode for most
product surfaces — task lists, inline edits, drag-reorder, comments.

Surfaces where the user must know the change saved before walking away — settings,
policies, anything contractual — opt out with the `confirmed` variant: "show it only once
it's real", the cache updates after the server acks:

```ts
m.issues.patch(id, { status: 'closed' }) // optimistic — the default, no flags

m.policies.confirmed.create(policy) // waits for the server ack
const policies = m.policies.confirmed // or name the surface once
```

Two things make the default safe. First, **awaiting is unaffected**: the promise settles
on the server response in both modes, so a flow that awaits and then shows "saved" behaves
identically — optimism only ever controlled when the _cache_ shows the change. Second,
failures are never silent: rollback is global, `useAction` gives every action an `error`
slot, and the events channel sees everything. `confirmed` is greppable on purpose — it
names your critical surfaces.

### Creates and ids: the id contract

**Optimistic creates carry a client-generated id the server will accept.** Identity is
what everything downstream is built on — React keys, realtime echo dedup, navigation,
child-row foreign keys — and an optimistic item without a real id has none. So the two
modes have symmetric id stories:

```ts
// Optimistic: you mint the identity — real from the first frame
const id = crypto.randomUUID()
void m.issues.create({ id, title })
navigate(`/issues/${id}`) // safe: you own the id

// Confirmed: the server mints the identity — await it
const issue = await m.issues.confirmed.create({ title })
navigate(`/issues/${issue.id}`)
```

An optimistic create without an id **throws synchronously** — the message names both
escapes (provide an id, or use `confirmed`). This is deliberate: silently degrading would
mean the default's stated semantics ("shows immediately") quietly don't hold.

Because the optimistic item and the server's echo share the same id, the realtime
`created` event merges idempotently instead of duplicating, and rollback removes exactly
the item you created. Servers with auto-assigned ids (auto-increment PKs) can't accept
client ids — those services pair with `confirmed` creates, which is the honest shape of
that constraint: optimistic creation without client-mintable identity was never coherent.

### Per-call options

Per-call options carry call-specific _data_ only — write policy lives on the handle
variant, not per call:

- `params` — adapter params passthrough: `create(data, { params: { query: { ... } } })`.
- `optimisticItem` — an explicit synthesized cache item when the payload doesn't carry
  computed fields: `patch(id, data, { optimisticItem: { ...item, computedField } })`.
  Ignored on `confirmed` handles, which never show unconfirmed state.

### Per-action state: useAction

A screen with six buttons has six actions — each gets its own `useAction`, with its own
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
devtools read in the app's vocabulary — "close ok · 340ms" — with the underlying
`mutate:*` rows alongside.

Semantics, precisely:

- `pending` is a **counter**, not a flag — with overlapping runs it stays true until the last settles.
- `error` and `data` are **slots**: the last settled outcome, cleared the moment a new run starts (a retry wipes the stale message immediately).
- `run()` **never rejects** — failures land in `error`, so `onClick={run}` is always safe. Sequencing and per-call recovery belong inside the action body, which is plain async JS — `try`/`catch` and return values work natively there. Corollary: `await run()` followed by success logic is a bug (it resolves on failure too); put the consequence in the body.
- The body runs as a **React Action** (async transition): if it triggers a navigation or a query change that would suspend, React keeps the previous UI committed instead of flashing a fallback — `await m.issues.remove(id); navigate('/')` leaves the old screen up until the destination is ready. Urgent synchronous UI (closing an editor, clearing an input) belongs _before_ `run()`, not inside the body. The `pending` flip itself stays urgent, so button labels swap immediately.
- The wrapped function is captured fresh each render — it closes over current props/state, no deps array.
- `reset()` clears `error`/`data` back to idle.

`useAction` wraps _any_ async function, not just figbird calls — it's the write-side
member of the no-flash kit and composes with `useDelayedFlag(action.pending, 300)` for
flicker-free labels. `run` also works directly as a React 19 form action —
`<form action={submit.run}>` — where the body receives the `FormData` and
`useFormStatus` lights up in the form's children.

**One identity, one call site.** Hoisting a single `useAction` over N list rows re-creates
the shared-slot problem one level up ("which row is pending?"). Give each row component
its own action; if you catch yourself wanting keyed pending state inside one hook, the
component boundary is in the wrong place. For the cross-cutting question, use
`useMutating`.

**Toggle actions and rapid clicks.** An action body closes over the render it was created
in — two rapid clicks of a toggle both read the same `issue.status` and patch the same
value, losing an update. This isn't a `useAction` quirk; it's what closures do. The
mitigation is the disable pattern below (`useMutating` + `disabled`), which serializes
writes per record — or express the change as data the server can apply idempotently.

### Entity-level activity: useMutating

`useMutating` answers "is any mutation in flight" — for one entity, one service, or the
whole instance — no matter where the mutation was fired from:

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
`useMutating({ service, id })` while any action on that record is in flight — each
button's `useAction.pending` still labels _which_ one is running.

Caveats: optimistic creates are tracked by their client-generated id (the id contract
guarantees one); `confirmed` creates without a client id and custom-method calls carry no
`id`, so they never match an `{ id }` filter (they do match service-level filters).

### Custom methods

For everything beyond CRUD that your services expose — `archive`, `sendReminder`, domain
actions — declare the method in the schema's `methods` and it appears directly on the
handle, fully typed:

```ts
await m.notes.archive(['id-1', 'id-2']) // args and result typed from the schema
await m.notes.call('undeclared', arg) // untyped escape hatch
```

**Custom methods don't write to the CRUD cache** — their result shape is unknown to
figbird, so unlike the `create`/`update`/`patch`/`remove` sitting next to them on the
handle, calling one changes no query results by itself. Realtime events from the server
keep affected queries fresh, as with any other server-side change. They _do_ flow through
the mutation tracker and the `mutate:*` observability events, so `useMutating` and
devtools see them. Wrap them in `useAction` for UI state like any other write. Reserved
names always mean the built-in: a schema method named `create`/`update`/`patch`/`remove`/
`call`/`confirmed` is shadowed by the handle — reach it via `call()`.

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

Args are typed from the build function. When args arrive from an untrusted source — URL params, storage — pass a [Standard Schema](https://github.com/standard-schema/standard-schema) validator (zod, valibot, arktype…) as the middle argument; it runs at every call site and throws `QueryArgsError` on bad input, turning silent cache-splits (`{ id: "42" }` vs `{ id: 42 }`) into loud failures:

```ts
export const issueDetail = defineQuery(
  z.object({ id: z.coerce.number().int().positive() }),
  ({ id }) => q.issues.get(id).related('comments'),
)

prepare(issueDetail, { id: '42' }) // coerces "42" → 42 before building
```

### prepare

`prepare()` is the router's primitive: it starts a query and returns an explicit lease — a `promise` that resolves when the data is ready, and `release()` to drop the pin keeping it alive. Routers await route-critical data before committing a navigation; the destination screen then reads the same cache entry synchronously:

```ts
// route definition — the `prepare:` key is the router's convention; the calls inside
// are Figbird's prepare(). Metadata like `priority` belongs to the router, not Figbird.
prepare: ({ params }) => [
  { ...prepare(issueDetail, { id: Number(params.id) }), priority: 'route' },
  { ...prepare(issueComments, { id: Number(params.id) }), priority: 'defer' },
]
```

Preparation is an _earlier read_, not a different one — the component still calls `useQuery(issueDetail, { id })`.

### prefetch

`prefetch()` is for speculative warming — the idempotent, fire-and-forget sibling of `prepare()`, built for "the user will probably need this" moments — hover, viewport entry, likely-next-page:

```tsx
<Row onMouseEnter={() => prefetch(issueDetail, { id: issue.id })} />
```

Safe to call at any frequency: if the query was prefetched within `staleTime` (default 30s) it's a no-op. Otherwise it fetches and holds an internal pin that auto-releases after `staleTime` — the data stays cached either way, so a later `useQuery` gets a warm, synchronous read (no Suspense fallback). If the user clicks through, the component's own subscription takes over seamlessly.

```ts
prefetch(issueDetail, { id }, { staleTime: 60_000 })
```

Rule of thumb: `prepare()` when you need to _await_ readiness or control the lease; `prefetch()` when you just want things warm.

## Realtime

Figbird subscribes to realtime events per service (at most once per service) the moment a query against it is active. What happens when an event arrives is decided by the query's **classification** — the library's central idea:

- **local-exact** — membership, order, and values are provable from local state. Events merge directly into the cached result: a created record that matches appears, a patched record updates in place, a removed one disappears. No network.
- **server-window** — the query is windowed (`$limit` / `$skip` / `$sort`, or `.paginate()`). Visible rows are known, but an event may change membership invisibly — a row you can't see may now belong — so events trigger a **refetch** of the window instead of a guess.
- **server-authoritative** — membership or values depend on logic only the server can evaluate: `$regex` and other non-local operators, `$select` projections, or an explicit `.server()`. Events always trigger a refetch.

Classification is automatic and per query node — the root and each relation classify independently. Adding `.limit(30)` to a query flips it from merge to refetch; that's by design, and `figbird.explain()` will tell you exactly that:

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

Use `.server()` on a builder when a query _looks_ locally provable but isn't — server-computed virtual fields, permission-dependent membership, search ranking:

```ts
q.documents.where({ visibleTo: userId }).server()
```

### Reconciliation cadence

A refetch triggered by an event is a **reconciliation**, not a freshness requirement:
correctness demands the query reconciles with the server _eventually_ after the last
relevant event, not within milliseconds of each one. The engine owns the cadence — there
is no per-query throttle config — via two built-in guards on event-driven refetches:

- **Cooldown with a trailing edge.** A query reconciles at most once per
  `reconcileCooldown` (default 2s, a `Figbird` constructor option; `0` disables). The
  first event refetches immediately, so isolated changes land as fast as ever; further
  events within the window coalesce into **one guaranteed trailing refetch** — a
  500-event bulk import costs each affected query about two refetches instead of fifty,
  and still lands on the final answer. The trailing edge is the correctness guarantee;
  the interval is UX tuning.
- **Hidden tabs don't reconcile.** When the tab is hidden, event-driven refetches are
  deferred (queries show as `pending` in `inspect()`) and reconcile once on
  `visibilitychange` — including the reconnect sweep, so a background tab riding through
  network blips stops replaying refetch storms. Local-exact merges keep flowing while
  hidden (they're free); only network reconciliation pauses. Inject a custom
  `visibility` source in the constructor for non-browser environments.

Manual `refetch()`, first fetches, and SWR revalidation are user/loader intent and are
never gated.

A practical consequence worth knowing: an **unwindowed** relation like `.related('comments')` is local-exact, so a teammate's new comment merges straight from the socket event with no refetch. If you don't need a window, don't add one.

### Freshness tolerance: staleTime

By default every mount revalidates cached data in the background (SWR). `staleTime` is the
reader's tolerance: data younger than it skips the revalidation.

```ts
useQuery(q.currencies, { staleTime: 60_000 }) // revalidate at most once a minute
useQuery(q.currencies, { staleTime: Infinity }) // cache-first
```

It is a read-site option, not query identity — readers with different tolerances share one cache
entry, and the most demanding one keeps it freshest. `prepare()` and `prefetch()` accept it too.

### Freezing a query: .snapshot()

`.snapshot()` fetches once and then ignores realtime entirely — no merges, no event-triggered
refetches — for the root and every relation under it. `refetch()` is the only way it moves.
Frozen and live reads of the same filters don't share a cache entry (snapshot-ness changes what
the data means). Use for audit views, diff screens, "results as of when you searched".

### Reference data: .all()

`.all()` preloads a service's complete row set — the explicit verb for reference tables
(locations, currencies, roles). On success the service is **fully materialized**: every later
find the client can evaluate — including sorted/limited windows — is answered locally from
the cache with **no network roundtrip**, and realtime events maintain the set (windowed reads
recompute locally). Typically paired with preparation at the app shell:

```ts
export const allLocations = defineQuery('allLocations', () => q.locations.all())

// at the app shell — args omitted: the definition takes none
prepare(allLocations)

// later, anywhere — no fetch:
useQuery(q.locations.where({ countryCode: 'GB' }).orderBy('name').limit(10))
```

A few properties worth knowing:

- `.all()` refuses filters — "all" means all; read subsets separately
- it may chain `.related()` to preload joined reference sets
- it reconciles on reconnect, even with no subscribers
- server-only predicates (`$regex`, `$select`, `.server()`) still go to the server

Whether a service warrants `.all()` is the schema author's judgment call — reach for it only
where row counts are bounded.

# Guides

## No-flash checklist

`useQuery` never lies about identity: when a query's params change, that is a _different_
query with a cold cache entry, and the hook suspends rather than showing old data labeled
with new params. Honoring that contract without loading flashes takes three moves — one
per failure mode. The helpers below — `useDebouncedTransition`, `DelayedFallback`,
`useDelayedFlag` — all ship with Figbird.

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
renders nothing briefly, then the skeleton — fast loads never flash:

```tsx
<Suspense fallback={<DelayedFallback delay={250}><Skeleton /></DelayedFallback>}>
```

For `isFetching` spinners (background revalidation), the same principle is
`useDelayedFlag(isFetching, 300, 800)` — show only if slow, and once shown, don't yo-yo.

One more pattern from the same family: when navigating between details of the same shape (issue 1 → issue 2), key the Suspense boundary by the id — each destination gets its own cold boundary and skeleton instead of briefly showing the previous item's data:

```tsx
<Suspense key={issueId} fallback={<DetailSkeleton />}>
  {children}
</Suspense>
```

## Instant navigation

Combining `prepare`, `prefetch`, and lazy route chunks: the pattern that makes navigations feel instant is starting everything the destination needs — data _and_ code — before the screen renders, in parallel:

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

Because all three paths resolve to the same cache entry (the definition + args hash), there is no coordination to do — preparation is simply an earlier read.

## Using outside React

The core is framework-agnostic — useful for background sync, tests, and non-React code.

```ts
const figbird = new Figbird({ adapter, schema })

// Relational queries — same builders as the hooks
const ref = figbird.relationalQuery(q.issues.where({ status: 'open' }).related('creator'))
const unsub = ref.subscribe(state => {
  // { status, data, error, isFetching }
})
ref.getSnapshot()
ref.refetch()
unsub()

// Descriptor queries — the low-level primitive
const query = figbird.query({
  serviceName: 'tasks',
  method: 'find',
  params: { query: { completed: true } },
})
query.subscribe(state => {})

// Mutations — the m proxy works outside React too (it's not a hook anywhere)
await figbird.m.tasks.patch(id, { done: true }) // optimistic by default
await figbird.m.tasks.confirmed.patch(id, { done: true }) // waits for the ack
await figbird.m.tasks.archive([id]) // custom schema methods, typed

// ...or the low-level descriptor form
await figbird.mutate({ serviceName: 'tasks', method: 'patch', id, data: { done: true } })
```

## Custom adapters

Figbird works with any REST / WebSocket / RPC API wrapped in a Figbird-compatible adapter:

1. Structure your API around services or resources
2. Support the operations `find`, `get`, `create`, `update`, `patch`, `remove`
3. For realtime, emit `created`, `patched`, `updated`, `removed` events after mutations
4. Optionally implement `subscribeToReconnect` so active queries refetch after connectivity gaps

For example, a `comments` resource maps to `GET /comments`, `GET /comments/:id`, `POST /comments`, `PUT/PATCH/DELETE /comments/:id`, with `find` returning `{ data, total, limit, skip }` or similar. See [`lib/adapters/feathers.ts`](https://github.com/humaans/figbird/blob/master/lib/adapters/feathers.ts) for the reference implementation of the `Adapter` interface.

## Comparison

Every data library is a bet on where your app's complexity lives. Figbird's bet: a
**server-authoritative backend with realtime events**, read by **long-lived, app-shaped
screens** that many people look at simultaneously. Here's how that bet compares to the
alternatives — honestly, since each of these is the right tool for a different shape of
problem.

### TanStack Query

TanStack Query caches the results of arbitrary async functions under opaque keys. That
generality is its superpower — it works with any backend, any protocol, no schema — and
its limitation: the cache doesn't know what's _inside_ a result. The same record living in
ten queries is ten copies, and keeping them coherent is your job, via the invalidation
choreography (`onSuccess` → `invalidateQueries`) that dominates real TanStack codebases.
Freshness is heuristic: `staleTime`, refetch-on-focus, polling.

Figbird's cache is **normalized and event-driven**: entities live once, queries are
projections over them, and a mutation or socket event updates every query referencing the
record — there is no invalidation API because there's nothing to invalidate. Optimistic
updates are the default with automatic rollback, versus TanStack's hand-written
`onMutate`/snapshot/rollback recipe per mutation. Relations assemble client-side with
full types.

**Choose TanStack when** your API is heterogeneous (mixed REST endpoints, third-party
APIs, no consistent resource shape), you have no realtime channel, or you want the
ecosystem's maturity and escape hatches. **Figbird's model needs** service-shaped
resources and (to shine) server-emitted events — without them you keep SWR but lose the
realtime freshness model that makes the cache self-maintaining.

### React Server Components

RSC moves reads to the server: zero client JS for data fetching, direct data access, great
first paint. It's a request/response model — the page is data at a moment in time, and
freshness means revalidating and re-rendering server trees (`revalidatePath`/`Tag`), which
is coarse and navigation-shaped.

Figbird is for the screen that _stays open_: an issue tracker, an HRIS, a dashboard where
a teammate's change should appear in the open view in milliseconds without anyone
navigating. That requires a live client cache, socket events merging into it, and
optimistic writes — the exact things RSC deliberately doesn't have (client interactivity
falls back to client components anyway, at which point you need a client data layer and
you're back to this comparison).

**These compose rather than compete**: RSC for the document-shaped parts (marketing,
content, settings pages you visit once), figbird for the app-shaped workspace inside.
**Choose RSC alone when** your product is read-mostly and request-scoped — figbird's
machinery is dead weight on a blog.

### Relay + GraphQL

Relay is the most principled client cache in the ecosystem: normalized store, declarative
per-component data requirements (fragments), and compile-time guarantees against over-
and under-fetching. Those properties cost a GraphQL server, a compiler step, codegen, and
fragment ceremony at every component boundary — and the property that ceremony chiefly
buys, **data masking for cross-team decoupling**, matters at hundreds-of-engineers scale
and mostly doesn't below it.

Figbird targets the same normalized-store outcome with none of the pipeline: one
TypeScript schema, inference instead of codegen, composition via plain functions instead
of fragments, and your existing services instead of a GraphQL layer. And realtime is
first-class rather than bolted on — GraphQL subscriptions exist, but wiring them to
update a normalized store correctly is famously left as an exercise; in figbird that
wiring _is_ the library.

**Choose Relay when** you're at the org scale masking was built for, you need field-level
fetch efficiency (figbird fetches whole rows), or GraphQL is already your API layer.
**Figbird gives up** field selection and compile-time query validation in exchange for
having no pipeline at all.

### Zero (and sync engines generally)

Zero syncs a queryable replica to the client: reads are local-first and instant, writes
rebase through custom mutators, and there is no refetch model because the replica diffs
in continuously. Where the models overlap isn't accidental — figbird deliberately borrows
Zero's philosophy where it fits a server-authoritative world: client-generated ids,
optimistic-by-default writes, queries as live views.

The difference is the infrastructure bet. Zero requires running its sync layer
(zero-cache, Postgres logical replication) and adopting its permission model — you're
committing your backend architecture to the sync engine. Figbird runs against the
Feathers-style backend you already have: services, hooks, existing permissions, deployed
today, adoptable one screen at a time. And its **classification system** keeps
server-only semantics natural — `$regex` search, permission-dependent membership, complex
joins classify as server-authoritative and reconcile by refetch, where a local replica
must either sync everything the query needs or fall back to the server anyway.

**Choose Zero when** you're greenfield on Postgres, can operate the sync infrastructure,
and want local-first reads everywhere — it's the stronger end state. **Choose figbird
when** the server must stay authoritative with its existing logic, or you want most of
the live-app experience (realtime views, optimistic writes, warm navigation via
`prepare`/`prefetch`/`.all()`) without changing your backend.

# API: Core

## q

The read proxy — services as properties, each yielding an immutable, hashable query
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
(non-null when a refetch failed while data is showing — cold errors throw instead),
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

The write proxy — services as properties, mirroring `q`. Handles are stateless,
instance-bound plain values (not hooks): access them at module scope and call from
anywhere. Writes are optimistic by default; `confirmed` variants update the cache only
after the server acks. Handles hold no pending/error state by design; that's
[useAction](#useaction) and [useMutating](#usemutating). Per-call `options` carry data
only: `{ params?: AdapterParams, optimisticItem?: Item }`. Also available as `figbird.m`,
with `figbird.mutations(name)` as the dynamic-service-name door.

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

Per-action UI lifecycle around any async function — one hook call site per action. The
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

Returns a boolean, live via `useSyncExternalStore` over `figbird.mutating` — the core's
synchronous tracker, so it's correct for components that mount mid-mutation and it sees
writes from any surface. See [Entity-level activity](#entity-level-activity-usemutating).

## defineQuery

```ts
defineQuery(build)
defineQuery(argsSchema, build) // Standard Schema-validated args
defineQuery(name, build) // optional name — labels errors and devtools, never identity
defineQuery(name, argsSchema, build)
```

Args-keyed query factory — a pure value, not tied to an instance; `prepare`,
`prefetch`, and `useQuery` against the same definition and args share one cache entry.
The `createHooks` kit returns a schema-typed version; the standalone export from
`'figbird'` serves non-React code. See [Preparation](#preparation).

## figbird.prepare

```ts
const { key, promise, release } = figbird.prepare(definition, args, { staleTime? })
```

Starts a query and returns an awaitable lease — the router-grade primitive. `args` may be
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

Debounced value committed inside a React transition — the search-input pattern. Debouncing
alone still flashes when the value commits; a transition alone queries per keystroke. See
[the no-flash checklist](#no-flash-checklist).

## DelayedFallback

```tsx
<Suspense fallback={<DelayedFallback delay={250}><Skeleton /></DelayedFallback>}>
```

A Suspense fallback that only appears when loading is actually slow — fast loads never flash
a skeleton.

## useDelayedFlag

```ts
const showSpinner = useDelayedFlag(isFetching, 300, 800)
```

Spinner flag that turns on only after `delay` ms of sustained truth, and once shown stays for
at least `minVisible` ms — no flashing, no yo-yo.

# API: Setup

## createSchema

```ts
const schema = createSchema({ services, relationships? })
```

Builds the typed schema. `services` keys become literal service names that every API narrows
on; the optional `relationships` factory receives `{ one, many, embed }` helpers typed against
your services, so `destService` autocompletes.

## service

```ts
service<{ item: Note; query?: NoteQuery; create?; update?; patch?; methods? }>(options?)
```

Declares one service's types. Only `item` is required — omitted payloads default to
`Partial<item>` for create/patch and `item` for update. `options.path` maps an ergonomic
schema key to the transport-level service path. `methods` types custom Feathers methods.

## one

```ts
creator: one({ sourceField: 'creatorId', destService: 'users' })
```

Single related item — assembles as `T | null`. `destField` defaults to `'id'`; fields accept
`string | string[]` for compound keys.

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
const figbird = new Figbird({ adapter, schema, eventBatchProcessingInterval? })
```

| Member                                        | Description                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `q`                                           | The builder proxy — `q.issues.where(...)`. Requires a schema.                                                       |
| `prepare(definition, args)`                   | Awaitable query lease for routers — also returned bound from `createHooks`. See [figbird.prepare](#figbirdprepare). |
| `prefetch(definition, args, opts?)`           | Idempotent speculative warming — also returned bound from `createHooks`. See [figbird.prefetch](#figbirdprefetch).  |
| `m` / `mutations(service)`                    | The write proxy (and its dynamic-name door) — also returned bound from `createHooks`. See [m](#m).                  |
| `mutating`                                    | Synchronous in-flight mutation tracker (`subscribe`/`getSnapshot`) — `useMutating` is its React binding.            |
| `explain(...)`                                | Static classification report — see [figbird.explain](#figbirdexplain).                                              |
| `inspect()`                                   | Live-query snapshot — see [figbird.inspect](#figbirdinspect).                                                       |
| `events`                                      | Observability channel — see [figbird.events](#figbirdevents).                                                       |
| `query(desc, config?)`                        | Low-level descriptor query (see [Using outside React](#using-outside-react)).                                       |
| `relationalQuery(builder)`                    | Low-level relational query ref for non-React use.                                                                   |
| `mutate(desc)` / `call(service, method, ...)` | Low-level mutation / custom-method call.                                                                            |
| `getState()` / `subscribeToStateChanges(fn)`  | Raw internal state — debugging only; prefer `inspect()`.                                                            |

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

Meta behavior: `find` returns `{ data, meta }` (`FindMeta`: `{ total, limit, skip }`); `get` returns only the item.

## createHooks

Binds a Figbird instance to typed React hooks:

```ts
export const { useQuery, q, m, defineQuery, prepare, prefetch, useAction, useMutating } =
  createHooks(figbird)
```

Returns the daily-use kit — `useQuery`, `q` (the read proxy), schema-typed
`defineQuery`, instance-bound `prepare`/`prefetch`, and the write side: `m` (the write
proxy), `useAction` (per-action state), and `useMutating` (in-flight activity) — along
with `useFeathers` (the raw-client escape hatch) and the deprecated legacy hooks
(`useMutation`, `useFind`, `useGet`) for older codebases.

Instance resolution: hooks use the bound instance directly, so no provider is required. If a
`FigbirdProvider` is present in the tree, **it wins** — that's the injection point for
per-request SSR instances and tests. A dev-mode error fires if a provider holds a _different_
instance than the bound one.

## FigbirdProvider

Optional. Hooks from `createHooks` work without any provider; use one to inject a different
instance into a subtree — per-request instances in SSR, or a fresh instance per test:

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
No fetching happens — callable anywhere, assertable in tests. See
[Realtime](#realtime) for a worked example.

## figbird.inspect

```ts
figbird.inspect()
// → [{ queryId, serviceName, method, query, classification,
//      status, isFetching, itemCount, fetchedAt, subscriberCount }]
```

Read-only snapshot of every query currently in the store — the stable projection to build
devtools on (internal store shapes stay free to change).

## figbird.events

Emits lifecycle facts — fetches, realtime events, mutations (including optimistic rollbacks).
Delivery is batched on a microtask and never happens mid-render, so subscribing from React
components is safe:

```ts
const unsub = figbird.events.subscribe(event => {
  // event.kind: 'fetch:start' | 'fetch:end' | 'fetch:error' | 'realtime'
  //           | 'mutate:start' | 'mutate:end' | 'mutate:error' | 'mutate:rollback'
  //           | 'action:start' | 'action:end' | 'action:error'
})
```

Events carry ids, durations, and item counts — lightweight enough to subscribe in
production. `mutate:*` events carry a `mutationId` correlating one mutation's
start/end/error/rollback, and their `method` is a CRUD name or a custom method name —
custom-method calls flow through the same lifecycle events. `action:*` events come from
named `useAction` hooks and speak the app's vocabulary ("reassign · 340ms"), with the
`mutate:*` rows they wrap alongside.

## useFeathers

Returns the underlying Feathers client — the escape hatch for one-off operations outside
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
pending-state machines on multi-action screens. Note its semantics are legacy on purpose:
writes through `useMutation` are **non-optimistic unless flagged**, unlike `m`. Fully
functional and not going away soon.

```ts
const m = useMutation(serviceName, { optimistic?: boolean })

m.create(data, options?)   // Promise<Item>; arrays create in batch
m.update(id, data, options?)
m.patch(id, data, options?)
m.remove(id, options?)
m.status  // 'idle' | 'loading' | 'success' | 'error' — last call from this hook
m.data    // last mutation result
m.error   // last mutation error
```

Per-call `options`: `{ optimistic?: boolean | Item, params?: AdapterParams }` — overrides the
hook default in both directions.

## useFind

**Deprecated** — prefer `useQuery(q.service.where(...))`.

```ts
const { data, meta, status, isFetching, error, refetch } = useFind(serviceName, params)
```

`params` combines Feathers params with Figbird options (builder queries manage all of these
automatically — `swr` + classification-driven realtime):

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
