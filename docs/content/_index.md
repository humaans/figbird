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

// Pure, schema-bound React bindings.
export const { useQuery, q, useMutations, defineQuery, useAction, useMutating } =
  createHooks(schema)
```

```tsx
import { FigbirdProvider } from 'figbird'
import { figbird, q, useMutations, useQuery } from './figbird'

function OpenIssues() {
  const m = useMutations()
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

Render the application beneath a provider:

```tsx
<FigbirdProvider figbird={figbird}>
  <App />
</FigbirdProvider>
```

The schema binding is import-safe; the provider selects the runtime used by the React tree.

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
  relationships: {/* per-service factories — see Relations */},
})
```

Omitted payload types default sensibly: `Partial<item>` for create and patch, `item` for update. Service keys are preserved as literal types, so every API narrows on the service name. The `path` option separates ergonomic schema keys from transport-level service paths.

### What flows where

- `q.tasks.where({ completed: true })` — field names and value types check against `item` (with an open index signature for dotted paths and server operators)
- `.orderBy('title')` — autocompletes item fields without rejecting computed ones
- `.related('author')` — relation names come from the schema; the result type assembles automatically, nesting included
- `m.tasks.create(...)` — payloads and return types from the service definition; declared custom `methods` appear on the handle, fully typed
- `useQuery(definition(args))` — input typed from the definition's build function or Standard Schema

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
of a row you're viewing enters the error state with `ItemRemovedError` and null data. Use
`isItemRemovedError(error)` when that case needs separate handling. Chaining `.where()`
after it sends the conditions along as `params.query`. For "the first match of a filter,
if any", use `.where(...).limit(1)` and destructure the array.

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

`destField` defaults to `'id'`. Each service's factory gets helpers scoped to it, so every field name above type-checks: `sourceField` against the source item, `destService` against the schema, `destField` against the destination item. A generated schema fails to compile at exactly the relationship that went stale.

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

With definitions, conditionally bind the request — `null` skips the query without
invoking the definition's build function, so no non-null assertion is needed:

```ts
const { data } = useQuery(id ? issueDetail({ id }) : null)
```

### Several queries at once

Under Suspense, two `useQuery` calls in one component fetch sequentially — the first
throws its promise before the second ever runs. When one boundary needs several
_unrelated_ roots, `useQueries` starts every fetch first and suspends once for the
whole set:

```tsx
const [people, announcements] = useQueries([
  q.people,
  q.announcements.orderBy('createdAt', 'desc').limit(5),
])
```

Each element carries the same contract as the `useQuery` suspense result for its
builder — `data`, `error`, `isFetching`, `refetch`, and the same semantics: a cold
error on any query throws to the error boundary, while a failed refetch surfaces on
that element's `error` with its last good `data` still rendering. A `.paginate()`
element widens with its own `loadMore`/`hasMore`/… family, exactly like the single
hook; calling `loadMore()` appends that element's next page without disturbing the
others.

Reach for this only when the roots are genuinely independent — connected data belongs
in a single builder with `.related()`. Without Suspense there is no waterfall to
avoid: multiple `{ suspense: false }` `useQuery` calls already run in parallel.

## Pagination

`.paginate()` turns a query into an infinite-scroll accumulator. Each loaded page is its own window on the server, and `data` is the concatenation of all loaded pages:

```tsx
const { data, loadMore, hasMore, isLoadingMore, loadMoreError, total } = useQuery(
  q.issues
    .where({ status: 'open' })
    .orderBy('updatedAt', 'desc')
    .paginate({ pageSize: 25, includeTotal: true })
    .related('creator'),
)
```

- `loadMore()` appends the next page (no-op while one is in flight or when done)
- `hasMore` is sticky during loads so the button doesn't flicker
- `loadMoreError` reports a failed page load; calling `loadMore()` again retries the same page
- `total` comes from the first page's metadata when `includeTotal: true`
- `refetch()` re-fetches page 0 in place and drops follow-up pages (the dataset may have shifted)

The server owns page boundaries. Figbird merges a realtime event locally only when it
can prove that the event leaves the current window unchanged; otherwise it refetches.

### Cursor pagination

Pagination uses `$limit` and `$skip` by default. Configure cursor-backed Feathers
services once on the adapter; query builders and hook results stay the same:

```ts
import { cursorPagination, FeathersAdapter, offsetPagination } from 'figbird'

const cursor100 = cursorPagination({
  maxPageSize: 100,
  cursorStability: 'ordering',
})

const adapter = new FeathersAdapter(feathers, {
  defaultPagination: cursor100,
  pagination: {
    'api/legacy-reports': offsetPagination(),
  },
})
```

Without `defaultPagination`, services use offset pagination. List cursor services in
`pagination` when cursor support is the exception:

```ts
const adapter = new FeathersAdapter(feathers, {
  pagination: {
    'api/documents': cursor100,
    'api/identity-documents': cursor100,
  },
})
```

The default mapping matches this protocol:

```ts
// request query
{
  $limit: 25,
  $after: null, // an opaque endCursor on later pages
  $total: true, // page one of paginate({ includeTotal: true }) only
}

// response
{
  data: [...],
  total: 123, // optional; normally returned on page one
  limit: 25,
  hasPreviousPage: false,
  hasNextPage: true,
  startCursor: 'first-opaque-token',
  endCursor: 'last-opaque-token',
}
```

Figbird treats the cursor as opaque and chains pages sequentially. `hasNextPage` is
authoritative, so a full-sized final page still stops correctly. `.all()` drains the
same cursor chain without requesting a server count; once complete, the row count is
exact. `maxPageSize` caps `.all()` batches and rejects larger explicit `.paginate()`
page sizes before a request reaches Feathers. For `.paginate()`, realtime changes
normally rebuild the currently loaded prefix with fresh cursors while the old rows
remain visible, then replace the prefix in one update.

`cursorStability: 'ordering'` opts a service into a narrower local fast path. It
promises that cursors remain valid when result-set membership and ordering inputs
are unchanged, as they do for ordinary keyset cursors. An updated or patched row is
then replaced locally across the loaded prefix when every explicit filter and sort
field is present and unchanged. An explicit `$sort` is required for that proof.
Creates, removals, changed inputs, implicit ordering, `.server()`, unknown query
controls, and unavailable virtual fields still rebuild from page one. Omit
`cursorStability` for snapshot/version cursors or any protocol invalidated by
arbitrary row changes.

An explicit `refetch()` keeps the usual behavior: discard later pages and restart at
page one.

For a different server protocol, override the two mappings:

```ts
cursorPagination({
  query: ({ limit, after, includeTotal }) => ({
    first: limit,
    ...(after !== undefined ? { after } : {}),
    ...(includeTotal ? { includeCount: true } : {}),
  }),
  pageInfo: response => {
    const result = response as {
      page: { more: boolean; next?: string; count?: number }
    }
    if (!result.page.more) {
      return { hasMore: false, total: result.page.count }
    }
    if (!result.page.next) {
      throw new Error('Missing cursor for the next page')
    }
    return {
      hasMore: true,
      endCursor: result.page.next,
      total: result.page.count,
    }
  },
})
```

Cursor controls live outside the logical Figbird query. They therefore never become
filters, never need custom matcher support, and do not affect realtime query
classification.

Custom adapters choose pagination directly; they do not use these Feathers options.
Implement `pageSource(serviceName)` for services with adapter-native sequential
pagination, or return `undefined` to keep the query engine's `$limit`/`$skip` path.
The adapter's `findAll` implementation owns exhaustive reads in either case.

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
const id = crypto.randomUUID()
await m.issues.create({ id, title: 'Ship it' })
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

### Writes to the same record are serialized

Figbird sends CRUD calls for the same service and id in call order. Calls for different
records can run in parallel. Every optimistic change still appears immediately:

```ts
const id = crypto.randomUUID()

const created = m.issues.create({ id, title: 'Draft' })
const titled = m.issues.patch(id, { title: 'Ready' })
const closed = m.issues.patch(id, { status: 'closed' })
const removed = m.issues.remove(id)

await Promise.all([created, titled, closed, removed])
```

The optimistic remove hides the item immediately. The adapter receives `create`, `patch`,
`patch`, and `remove` one at a time. Each server response becomes the new confirmed base,
then Figbird reapplies the remaining changes. An old response cannot resurrect an earlier
version. If a patch fails, Figbird removes that change and reapplies the later ones. If a
create fails, Figbird cancels the writes that depend on its id.

Confirmed writes with the same service and id follow the same ordering, so they cannot
overtake optimistic writes. Id-less confirmed creates, batch creates, and custom methods
have no single record id and do not join this ordering. Use a mutation queue when one
feature needs ordered writes across records or services. Use a server transaction when
the writes must commit atomically.

Active optimistic projections are replayed over fetch responses. Locally decidable
queries update immediately. Relations assemble from cached data and fetch missing leaves.
When the server must decide query membership or ordering, Figbird waits for the record's
writes to settle before reconciling the query.

### Adapter-backed transactions

Use `figbird.transaction()` when several CRUD writes must commit or roll back as one server
operation. Transactions are a capability, not an emulation: Figbird throws if the adapter
does not provide an atomic transport and never falls back to sequential requests.

```ts
await figbird.transaction(tx => {
  tx.m.tasks.patch(taskId, { columnId: nextColumnId })
  tx.m.columns.patch(previousColumnId, { count: previousCount - 1 })
  tx.m.columns.patch(nextColumnId, { count: nextCount + 1 })
})
```

The callback collects synchronously; its methods return `void`, and the outer promise settles
when the transaction commits. Payloads, patches, service names, and `confirmed` options retain
the same schema inference as `m`. Optimistic operations project as one observer-visible cache
update and roll back together. `tx.m.columns.confirmed.patch(...)` keeps that operation hidden
until commit.

Transaction operations wait behind earlier writes to every affected record, then reserve those
record lanes until the adapter transaction settles. Each entity can appear only once in a
transaction. Creates must be collected one at a time and carry a stable id, including confirmed
creates, because multi-record ordering needs an identity before dispatch. The transaction DSL is
CRUD-only; custom methods have adapter-specific argument and cache semantics.

For Feathers, opt into the `api/batch` tuple contract explicitly:

```ts
import { FeathersAdapter, feathersBatchTransactions } from 'figbird'

const adapter = new FeathersAdapter(feathers, {
  transactions: feathersBatchTransactions(), // defaults to api/batch
})
```

The batch service must return one ordered `{ status: 'fulfilled', value }` or
`{ status: 'rejected', reason }` entry per call and guarantee that any rejection rolls back the
whole batch. `feathersBatchTransactions()` rejects the Figbird transaction if any entry rejects.
Use `serviceName` and `params` options when the batch endpoint differs.

### Ordered autosave with mutation queues

`m` sends independent records in parallel. A feature such as a workflow editor may instead
need one open-ended stream: create an action, create a task that references it, then accept
more edits in whatever order the user makes them. Define its policy once, then select one
reconnectable instance per workflow:

```ts
const workflowSync = defineMutationQueue({
  schedule(operation) {
    return isTextPatch(operation) ? { wait: 800, maxWait: 3200 } : { wait: 300 }
  },
})

function useWorkflowSync(workflowId: string) {
  const sync = useMutationQueue(workflowSync, `workflow:${workflowId}`)

  return {
    sync,
    addTask(actionId: string, taskId: string) {
      return Promise.all([
        sync.m.actions.create({ id: actionId, title: 'Draft' }),
        sync.m.tasks.create({ id: taskId, actionId, title: '' }),
        sync.m.tasks.patch(taskId, { title: 'Write launch plan' }),
      ])
    },
  }
}
```

Call `useMutationQueue()` or `useMutationQueue(definition)` for a component-owned queue.
On unmount, it sends scheduled work. If it is paused on an error, it discards the failed
operation and everything after it.

Pass a definition and key to reconnect after a remount. Hooks with the same definition,
key, and Figbird instance share the same pending, saving, or failed queue. Definitions
give keys a namespace, so equal keys from different features cannot collide. Figbird
removes an unowned queue when it becomes idle. It retains unfinished queues for five
minutes, then detaches them so an abandoned error cannot remain paused forever.

Every call projects immediately. The queue sends adapter calls in registration order.
Consecutive unsent patches coalesce when their service, id, params, and
optimistic-or-confirmed mode match. Their payloads merge shallowly, later values win, and
all callers share the request promise. Structurally equal plain-object params match even
when callers create new objects. Patches with `optimisticItem` do not coalesce. An
ordinary write or any other queued operation ends the group.

Queue writes still use Figbird's per-record ordering. An ordinary `m.tasks.patch()` cannot
overtake an earlier `sync.m.tasks.patch()` on the same task. An ordinary write to another
record can still run in parallel.

Use `sync.flush()` to skip current debounce delays. A terminal error pauses the queue with its
optimistic state intact; inspect `sync.status`, `sync.pending`, and `sync.error`, then call
`sync.retry()` or `sync.discard()`. Discard rolls back the failed operation and all later queued
work. A successful remove cancels later patches from the deleted record lifetime; if the remove
fails, old-lifetime patches become visible again and may proceed, while a queued same-ID recreate
and its dependent writes are cancelled.

Outside React, use `figbird.createMutationQueue(config)`. A mutation queue is ordered, not
atomic or durable. An unfinished keyed queue can survive component navigation, but no
queue survives a page reload. Register a parent create before a child create that
references it. Enable retries for creates only when the server treats their
client-generated ids idempotently.

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
- `optimisticItem` — an explicit synthesized cache item for optimistic creates, updates, and
  patches when the payload doesn't carry computed fields:
  `patch(id, data, { optimisticItem: { ...item, computedField } })`.
- `optimisticPatch` — a partial local projection when the wire payload uses a different
  shape: `patch(id, { isCompleted: true }, { optimisticPatch: { status: 'completed' } })`.

`optimisticItem` and `optimisticPatch` are mutually exclusive: one replaces the complete local
item, while the other merges fields into it. Creates accept only `optimisticItem`; removes and
`confirmed` handles accept only `params`, because neither applies an optimistic projection.

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

`useMutating` answers "is any mutation active" for one entity, one service, or the
whole instance, no matter where the mutation was fired from:

```ts
const busy = useMutating({ service: 'issues', id: issue.id }) // this record
const saving = useMutating({ service: 'issues' }) // this service
const anything = useMutating() // anywhere
```

It's backed by a synchronous mutation tracker in the core (not the batched events
channel), so it is correct even for components that mount _while_ a mutation is already
already active, and it sees scheduled queue work plus writes from other components, route actions,
and non-React code.

Figbird serializes keyed server writes and rebases their optimistic projections. The
canonical UI use for this hook is preventing duplicate or stale user intent: disable the
whole toolbar with `useMutating({ service, id })` while any action on that record is in
flight. Each button's `useAction.pending` still labels _which_ one is running.

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

Three pieces make preparation work: `defineQuery` creates a callable factory that binds
route inputs into an inert request; `prepare` starts it early with an explicit lease;
`prefetch` warms it speculatively. These APIs come
from your `createHooks` kit (a standalone `defineQuery` is also exported from `'figbird'` for
non-React code, and `prepare`/`prefetch` exist as instance methods).

### defineQuery

A query definition is an args-keyed query factory. Call it with concrete inputs when the
query needs to cross an integration boundary, such as a router. The result is an inert,
instance-independent request: it contains no cache state and can be forwarded as an opaque
value. Every consumer accepts that same request and resolves it to the **same cache entry**:

```ts
export const issueDetail = defineQuery(({ id }: { id: number }) =>
  q.issues.get(id).related('creator').related('comments'),
)

const request = issueDetail({ id: 42 })

// component
const { data } = useQuery(request)
```

Without a schema, args are typed from the build function. When args arrive from an untrusted source like URL params or storage, pass a [Standard Schema](https://github.com/standard-schema/standard-schema) validator (zod, valibot, arktype…) as the middle argument. The callable definition accepts the schema's input type and the build function receives its validated output type. Calling the definition validates and normalizes immediately, turning silent cache-splits (`{ id: "42" }` vs `{ id: 42 }`) into loud failures:

```ts
export const issueDetail = defineQuery(
  z.object({ id: z.coerce.number().int().positive() }),
  ({ id }) => q.issues.get(id).related('comments'),
)

const request = issueDetail({ id: '42' }) // coerces "42" → 42 now
prepare(request)
```

### prepare

`prepare()` is the router's primitive: it starts a query and returns an explicit lease, with a `promise` that resolves when the data is ready and a `release()` to drop the pin keeping it alive. Routers await route-critical data before committing a navigation; the destination screen then reads the same cache entry synchronously:

```ts
// The router only carries opaque requests. Its data adapter decides how to prepare them.
queries: ({ params }) => [issueDetail({ id: Number(params.id) })]

// Argumentless definitions need no route resolver and are forwarded as-is.
queries: [customFieldsQuery, rolesQuery]

const data = {
  prepare: (request: AnyQueryInput<typeof schema>) => figbird.prepare(request),
  prefetch: (request: AnyQueryInput<typeof schema>) => figbird.prefetch(request),
}
```

Preparation is an _earlier read_, not a different one. The component calls
`useQuery(request)` and converges on the same cache key.

### prefetch

`prefetch()` is the idempotent, fire-and-forget sibling of `prepare()`, built for "the user will probably need this" moments like hover or viewport entry:

```tsx
<Row onMouseEnter={() => prefetch(issueDetail({ id: issue.id }))} />
```

Safe to call at any frequency: if the query was prefetched within `staleTime` (default 30s) it's a no-op. Otherwise it fetches and holds an internal pin that auto-releases after `staleTime`. The data stays cached either way, so a later `useQuery` gets a warm, synchronous read with no Suspense fallback. If the user clicks through, the component's own subscription takes over seamlessly.

```ts
prefetch(issueDetail({ id }), { staleTime: 60_000 })
```

Rule of thumb: `prepare()` when you need to _await_ readiness or control the lease; `prefetch()` when you just want things warm.

## Realtime

Figbird subscribes to realtime events per service (at most once per service) the moment a query against it is active. What happens when an event arrives is decided by the query's **classification**. This is the library's central idea:

- **local-exact** — membership, order, and values are provable from local state. Events merge directly into the cached result: a created record that matches appears, a patched record updates in place, a removed one disappears. No network.
- **server-window** — the query is windowed (`$limit` / `$skip` / `$sort`, or `.paginate()`). The predicate is still locally evaluable, but a row you can't see may enter or leave the window invisibly. Events whose effect on the window is **provable** merge locally (see window maintenance below); anything unprovable triggers a **refetch** of the window instead of a guess.
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

### Window maintenance

Server-window doesn't mean every event costs a roundtrip. The visible rows are a
contiguous run of the server result, and the window's predicate is locally evaluable
(anything non-local classifies server-authoritative) — so many event effects are
provable from local state, and figbird merges those directly:

- **In-place patches.** A patch to a visible row that keeps its membership and sort
  position updates in place — editing a row in the page you're looking at never
  refetches.
- **Underfilled windows.** `$limit: 100` that returned 32 rows _is_ the complete
  result set: creates insert at their sorted position, removes remove, patches move
  rows in and out — all local until the window fills.
- **Provable inserts.** A created row that sorts strictly inside a full window's run
  belongs there: it's inserted at its position and the overflow row is evicted. A new
  entry landing at the top of a recent-first list appears instantly, no refetch.
- **Beyond-the-window changes.** A membership change provably past the window only
  adjusts `total`.

Everything unprovable — a removal from a full window (the replacement row is
unknown), anything that shifts the page start of a `$skip` window, boundary ties —
falls back to the refetch, which remains the correctness backstop.

Sort position is judged by the query's `$sort`. For queries without one, tell
figbird the ordering your backend applies by default:

```ts
const figbird = new Figbird({
  adapter,
  schema,
  defaultSort: { createdAt: -1, id: -1 },
})
```

Like custom operators, `defaultSort` is a correctness contract: it must mirror the
order the server actually applies. If a query's real ordering differs, rows merge
into the wrong position until the next fetch — fix it by specifying `$sort` on that
query. With no `$sort` and no `defaultSort`, membership still merges where it's
exact (visible patches keep their position, underfilled first pages append) and
everything positional refetches.

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
- **Reconnects are staggered.** Visible clients wait a random `reconnectJitter`
  before sweeping active queries, defaulting to `[0, 3000]` ms. Reconnects during
  the wait coalesce into one sweep. Set `reconnectJitter: 0` for immediate sweeps.

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

### Fetch retries

Figbird retries a failed fetch up to three times before exposing the error. The default
delay uses exponential backoff: 1s, 2s, then 4s, capped at 30s if you allow more retries.
The query stays in its fetching state between attempts, so a cold query keeps suspending
and a background refetch keeps showing its cached data. Only the final failure enters the
error state.

Retries apply to network failures, timeouts, `408`, `429`, and `5xx` responses. Other
`4xx` responses fail immediately because repeating the same request will not fix them.

Configure the policy on the instance:

```ts
const figbird = new Figbird({
  adapter,
  schema,
  retry: 5, // retries after the initial request
  retryDelay: (attempt, error) => Math.min(500 * 2 ** (attempt - 1), 10_000),
})
```

`attempt` is one-based: `1` is the first retry. Pass a number for a fixed delay, or
`retry: false` to disable automatic retries. A manual `refetch()` after the final error
starts a new retry budget.

Descriptor queries can override the instance policy with numeric `retry` and
`retryDelay` options:

```ts
useFind('audit-log', { retry: false })
figbird.queryDesc(desc, { retry: 1, retryDelay: 250 })
```

Each network attempt emits its own fetch lifecycle events and contributes to the query's
fetch and error counts in `inspect()`.

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
the service is **fully materialized**: later reads the client can evaluate — finds with
filters and a known order, sorted and limited windows, and `get(id)` — are answered locally
from the cache with **no network roundtrip**, and realtime events maintain the set.
An unsorted find still goes to the server unless the instance has a `defaultSort`; a complete
row set cannot reveal the server's implicit order. (`.get(id).where(...)`
conditions evaluate locally too when the matcher can decide them; a `get` whose local
answer would be an error — missing id, failing predicate — still asks the server, which
owns the error shape.) Typically paired with preparation at the app shell:

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
- finds without `$sort` use the network unless the instance declares `defaultSort`
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
// 1. Query definitions live in an eagerly-loaded module
export const issueDetail = defineQuery(({ id }: { id: number }) =>
  q.issues.get(id).related('creator').related('labels'),
)

// 2. The route fires data preparation and the lazy chunk import in parallel —
//    navigation latency becomes max(chunk, data) instead of chunk + data
{
  path: '/issues/:id',
  resolver: () => import('./pages/IssueDetail/screen'),
  queries: ({ params }) => [issueDetail({ id: Number(params.id) })],
}

// 3. Hover starts the same queries even earlier — clicking is then a warm read
<Row onMouseEnter={() => prefetch(issueDetail({ id }))} />

// 4. The screen just reads — warm visits render synchronously, no fallback
const { data } = useQuery(issueDetail({ id }))
```

Because all three paths resolve to the same builder AST hash, there is no coordination to do.
Preparation is simply an earlier read. The router does not need to understand Figbird's
definition, input, or request shape; its data adapter receives the request as an opaque value.

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

// Bound requests share the same cache entry as useQuery(issueDetail({ id: 42 }))
figbird.query(issueDetail({ id: 42 }))

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

Render the component beneath `<FigbirdProvider figbird={figbird}>`, then:

- simulate server-side changes: `feathers.service('issues').emit('patched', {...})` —
  they flow through the realtime pipeline like socket events
- assert fetch behavior: `feathers.service('issues').counts.find`
- mutations through `useMutations()` or `figbird.m` hit the mock's CRUD, which emits the
  realtime echo like a real server would

Figbird's own test suite runs on this client.

## Custom adapters

Figbird works with any REST / WebSocket / RPC API wrapped in a Figbird-compatible adapter:

1. Structure your API around services or resources
2. Support the operations `find`, `get`, `create`, `update`, `patch`, `remove`
3. For realtime, emit `created`, `patched`, `updated`, `removed` events after mutations
4. Optionally implement `subscribeToReconnect` so active queries refetch after connectivity gaps
5. Optionally implement `isRetryableError` to return `false` for errors that another query
   attempt cannot fix; adapters without it treat all query errors as retryable

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

| Method                                   | Meaning                                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `.where(filters)`                        | Merge filter conditions (deep-merged across calls); typed against the item, admits dotted paths and `$` operators |
| `.orderBy(field, dir?)`                  | Add a sort clause; calls accumulate                                                                               |
| `.limit(n)` / `.skip(n)`                 | Window the result (`$limit` / `$skip`)                                                                            |
| `.get(id)`                               | Resource fetch by pk (`GET /:service/:id`); `.where()` after it rides along as `params.query`                     |
| `.related(name, refine?)`                | Attach a schema relation; the refine callback filters/windows/nests the related query                             |
| `.paginate({ pageSize, includeTotal? })` | Infinite-scroll accumulator — the hook result widens with `loadMore`/`hasMore`/`total`                            |
| `.server()`                              | Mark server-maintained: realtime events refetch instead of merging locally                                        |
| `.snapshot()`                            | Freeze as point-in-time: realtime is ignored; only `refetch()` moves it                                           |
| `.all()`                                 | Preload the complete set; later reads against the service answer locally                                          |

Builders are immutable values identified by a stable content hash, so constructing them
inline in render needs no dependency arrays. Also available as `figbird.q`.

## useQuery

```ts
// Suspense (default)
const { data, error, isFetching, refetch } = useQuery(builder)
const { data } = useQuery(definition(args))

// Paginated builders widen the result
const { data, loadMore, hasMore, isLoadingMore, loadMoreError, total } = useQuery(
  q.issues.paginate({ pageSize: 25, includeTotal: true }),
)

// Tagged union, never suspends or throws
const result = useQuery(builder, { suspense: false })
// result: { status: 'idle' | 'loading' | 'success' | 'error', data, error, isFetching, refetch }
// Paginated builders widen the success arm with the same loadMore family as above

// Conditional fetching
const { data } = useQuery(builder, { skip: id == null }) // data: T | undefined
```

Options: `skip?: boolean`, `suspense?: boolean` (must be static per call site), `staleTime?: number` (freshness tolerance — see [Realtime](#realtime)).

Result fields (suspense form): `data` (guaranteed for the exact query passed), `error`
(non-null when a refetch failed while data is showing; cold errors throw instead),
`isFetching` (background fetch in flight on the current query), `refetch()`.

## useQueries

```ts
const [issues, users] = useQueries([q.issues.where({ status: 'open' }), q.users])
```

Suspends on every cold query in the array at once — all fetches in parallel, one
suspension for the set (see [Several queries at once](#several-queries-at-once)).
Each element has the `useQuery` suspense result shape for its builder (`data`,
`error`, `isFetching`, `refetch`, plus the `loadMore`/`hasMore`/… family on a
`.paginate()` element). Suspense-only. Options: `staleTime?: number`.

## m and useMutations

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
instance-bound plain values. Inside React, get it from `useMutations()` so it follows the
nearest `FigbirdProvider`. Outside React, use `figbird.m` directly. Writes are optimistic by
default; `confirmed` variants update the cache only
after the server acks. Handles hold no pending/error state by design; that's
[useAction](#useaction) and [useMutating](#usemutating). Per-call `options` carry data only:
creates accept `params` and `optimisticItem`; updates and patches also accept the mutually exclusive
`optimisticPatch`; removes and `confirmed` handles accept only `params`. Also available as
`figbird.m`.
Like `q`, the proxy is callable for dynamic service names: `m(name)` is `m.<name>` with a
string-typed door.

## defineMutationQueue and useMutationQueue

```ts
const autosave = defineMutationQueue({
  schedule: operation => ({ wait: operation.method === 'patch' ? 500 : 0 }),
  retry: 2,
  retryDelay: 1000,
})

const local = useMutationQueue() // owned by this component
const configured = useMutationQueue(autosave) // configured, still component-owned
const reconnectable = useMutationQueue(autosave, `issue:${issueId}`)
```

`defineMutationQueue(config?)` creates an immutable policy value. Keep it at module scope.
The optional `schedule` function controls debounce timing; `retry` and `retryDelay`
control automatic retries.

`useMutationQueue()` returns a serial queue with an `m` write proxy. Pass a definition to
use its policy. Pass a definition and key to reconnect to unfinished work after a remount.
The returned queue exposes `status`, `pending`, `error`, `flush()`, `retry()`, and
`discard()`. See [Ordered autosave with mutation queues](#ordered-autosave-with-mutation-queues).

## figbird.createMutationQueue

```ts
const sync = figbird.createMutationQueue({
  schedule: operation => ({ wait: operation.method === 'patch' ? 500 : 0 }),
})

sync.m.tasks.patch(id, { title })
```

Creates the same serial queue outside React. The caller owns its lifetime. This form does
not have a reconnect key; keep the queue object for as long as the feature needs it. Call
`sync.detach()` when its owner goes away. Detaching sends scheduled work, or discards work
from a terminal failure, and prevents new calls.

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

Per-action UI lifecycle around any async function, one hook call site per action. It is
separate from `useMutations()`: the latter selects stable service commands, while each
`useAction()` call owns the pending, error, and result state for one UI action. The
body runs as a React Action (async transition), so suspense-triggering consequences
(navigation after a write, a query change) keep the previous UI on screen; `run` also
works directly as a React 19 `<form action>`. Named actions emit `action:start/end/error`
on the observability channel through the provider instance. See
[Per-action state](#per-action-state-useaction) for the semantics
and the one-identity-one-call-site rule.

## useMutating

```ts
useMutating() // any active mutation, anywhere
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

const request = definition(args)
```

Args-keyed query factory. A pure value, not tied to an instance. Calling it validates and
normalizes concrete args into an inert `QueryRequest`, also independent of an instance.
`query`, `prepare`, `prefetch`, `explain`, `useQuery`, and `useQueries` accept that request.
Argumentless definitions can be passed directly without first creating a request.
These three forms share the generic `QueryInput` contract. Adapter packages can use
`AnyQueryInput<Schema>` to erase the result type at their integration boundary without
reproducing Figbird's input union or importing internal builder types.
The `createHooks` kit returns a schema-typed version; the standalone export from
`'figbird'` serves non-React code. See [Preparation](#preparation).

## figbird.prepare

```ts
const { key, promise, release } = figbird.prepare(definition(args), { staleTime? })
```

Starts a query and returns an awaitable lease, the router-grade primitive. Argumentless
definitions can be passed directly. See [prepare](#prepare).

## figbird.prefetch

```ts
figbird.prefetch(definition(args), { staleTime? }) // staleTime defaults to 30s
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
`destField` defaults to `'id'`.

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
const figbird = new Figbird({
  adapter,
  schema,
  eventBatchInterval?,
  retry?,
  retryDelay?,
  reconnectJitter?,
})
```

| Member                                            | Description                                                                                                                                                 |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `q`                                               | The builder proxy — `q.issues.where(...)`. Requires a schema.                                                                                               |
| `prepare(request, opts?)`                         | Awaitable query lease for routers. Argumentless definitions can be passed directly. See [figbird.prepare](#figbirdprepare).                                     |
| `prefetch(request, opts?)`                        | Idempotent speculative warming. Argumentless definitions can be passed directly. See [figbird.prefetch](#figbirdprefetch).                                      |
| `refetch(service?)`                               | Manual refetch escape hatch for changes Figbird can’t observe, such as custom methods without events or out-of-band writes. Call `figbird.refetch(...)`.                  |
| `m`                                               | The instance’s write proxy: `figbird.m.issues.patch(...)`, or `figbird.m(service)` for dynamic names. In React, access the provider instance through `useMutations()`. See [m](#m). |
| `transaction(fn)`                                 | Adapter-backed atomic CRUD collector. Optimistic projection, commit, and rollback are grouped across services. See [Adapter-backed transactions](#adapter-backed-transactions). |
| `createMutationQueue(config?)`                    | Explicitly owned serial writes across records or services. See [figbird.createMutationQueue](#figbirdcreatemutationqueue).                                |
| `mutating`                                        | Synchronous active-mutation tracker (`subscribe`/`getSnapshot`) — `useMutating` is its React binding.                                                       |
| `explain(...)`                                    | Static classification report — see [figbird.explain](#figbirdexplain).                                                                                      |
| `inspect()`                                       | Live-query snapshot — see [figbird.inspect](#figbirdinspect).                                                                                               |
| `events`                                          | Observability channel — see [figbird.events](#figbirdevents).                                                                                               |
| `query(builder)`                                  | Live query ref for non-React use — the `useQuery` mirror; also accepts a bound request or argumentless definition. See [Using outside React](#using-outside-react).               |
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
  - `pagination` — cursor strategies keyed by service path; see [Cursor pagination](#cursor-pagination)
  - `operators` — custom query operators the client can evaluate (`{ $asOf: asOf => item => boolean }`); queries using them stay realtime-mergeable. See [Teaching the client custom operators](#teaching-the-client-custom-operators)
  - `transactions` — optional atomic transaction transport; use `feathersBatchTransactions()` for an `api/batch`-style service

Meta behavior: `find` returns `{ data, meta }` (`FindMeta`: `{ total, limit, skip }`); `get` returns only the item.

## createHooks

Binds a schema to import-safe, typed React hooks:

```ts
export const { useQuery, useFigbird, useMutations, q, defineQuery, useAction, useMutating } =
  createHooks(schema)
```

Returns the daily-use kit: `useQuery`, `q` (the read proxy), schema-typed
`defineQuery`, and the write side — `useMutations` (the provider instance's write proxy),
`useAction` (per-action state), and `useMutating` (in-flight activity). It also includes
typed `useFigbird`, `useFeathers` (the raw-client
escape hatch), and the deprecated legacy hooks (`useMutation`, `useFind`, `useGet`) for
older codebases.

Creating the kit and reading `q` have no runtime side effects. Every generated hook resolves
the nearest `FigbirdProvider`. Imperative code uses the explicit instance directly:
`figbird.m`, `figbird.prepare`, `figbird.prefetch`, and `figbird.refetch`.

Construct the provider's Figbird instance with the same schema object passed to `createHooks`.
Provider-bound APIs and schema-built queries throw if the schemas differ, preventing types from
one schema from being applied to another runtime.

## FigbirdProvider

Required for runtime-backed hooks from `createHooks`, such as `useQuery`, `useMutations`, and
`useMutating`. It supplies the instance to a tree and is the injection point for application
roots, per-request SSR instances, stories, and tests. `useAction` can also run without a provider;
when one exists, it uses that instance for observability events.

```tsx
<FigbirdProvider figbird={testFigbird}>{ui}</FigbirdProvider>
```

The standalone `useFigbird()` export reads only the context instance and throws without a
provider; `useFigbirdMaybe()` returns `undefined` instead. The typed `useFigbird` returned by a
`createHooks` kit reads the same provider.

# API: Observability

## Browser devtools extension

Figbird devtools run as a Chrome or Firefox DevTools extension.

Build the extensions from this repository:

```sh
npm run devtools:build
```

- Chrome: open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**,
  and select `extensions/build/chrome`.
- Firefox: open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**,
  and select `extensions/build/firefox/manifest.json`.

Open the browser developer tools and select the **Figbird** panel. The panel connects to
the newest Figbird instance on the inspected page and starts debug collection. Closing the
panel drops the connection; without a connection, Figbird does not retain devtools history
or subscribe to its event stream.

Paginated queries appear as one operation rather than one row per fetched page. Query
details show whether the operation uses offset or cursor pagination. Cursor details show
the loaded page chain, each opaque `after` and next cursor, completion state, total when
requested, and whether realtime updates merge when stable or reconcile from the server.

Run `npm run devtools:package` to produce Chrome and Firefox zip archives under
`extensions/build/` for store upload or direct distribution. See `extensions/README.md`
for QA and packaging details.

## figbird.explain

```ts
figbird.explain(builderOrRequest)
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
//      page?, status, isFetching, itemCount, fetchedAt, subscriberCount }]
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
  //           | 'reconcile:started'
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

The extension retains bounded query, event, and write history while its panel is connected.

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
- `retry` — failed fetches to retry before exposing the error; `false` disables retries
- `retryDelay` — fixed delay in milliseconds between retries
- `allPages` — fetch all pages (`parallel` + `parallelLimit` control concurrency)
- `matcher` — custom `(query) => (item) => boolean` for realtime merging
- `matcherKey` — opt into sharing equivalent custom-matcher queries across hooks;
  without it, matcher queries remain hook-scoped

## useGet

**Deprecated** — prefer `useQuery(q.service.get(id))`.

```ts
const { data, status, isFetching, error, refetch } = useGet(serviceName, id, params)
```

Same Figbird params as `useFind` (minus pagination). No `meta` by default.
Realtime removal enters the error state with `ItemRemovedError`, matching
`useQuery(q.service.get(id))`; use `isItemRemovedError(error)` to identify it.
