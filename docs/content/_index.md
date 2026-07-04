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

- **Relational queries** — declare relations in your schema once, then `.related()` assembles entity graphs from per-service caches
- **Live queries** — results update as records are created, modified, or removed, locally or via realtime events
- **Suspense-native** — cold reads suspend, warm reads render synchronously; loading states live in boundaries, not branches
- **Optimistic mutations** — declared once per surface, rolled back on failure everywhere at once
- **Query preparation** — routers and hover handlers warm the exact queries screens will read
- **Full TypeScript** — define a schema once, get inference through builders, relations, and mutations
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

// Typed hooks + the builder proxy, bound to this instance.
export const { useQuery, useMutation, q } = createHooks(figbird)
```

```tsx
// components — one import, no provider required
import { useQuery, useMutation, q } from './figbird'

function OpenIssues() {
  const { data: issues } = useQuery(
    q.issues.where({ status: 'open' }).orderBy('id', 'desc').related('creator'),
  )
  return issues.map(issue => (
    <div key={issue.id}>
      {issue.title} — {issue.creator?.name}
    </div>
  ))
}
```

No `FigbirdProvider` is needed — the hooks are bound to the instance they were created with. (A provider, when present, overrides the bound instance; see [FigbirdProvider](#figbirdprovider).)

# Concepts

## Schema

The schema is the first thing you write: it declares your services, their types, and the
relationships between them — and it is where all of figbird's TypeScript inference comes from,
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
    'api/people': service<PersonService>({ path: 'api/people' }),
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
- `useMutation('tasks').create(...)` — payloads and return types from the service definition
- `useQuery(definition, args)` — args typed from the definition's build function (or validated by its Standard Schema)

## Queries

Every query starts from `q.<service>` and reads like the request it makes:

```ts
q.issues // all issues
q.issues.where({ status: 'open' }) // filtered
q.issues.where({ priority: { $gte: 50 } }) // comparison operators
q.issues.orderBy('updatedAt', 'desc').limit(30) // windowed
q.issues.where({ id }).one() // single item — null when no match
q.issues.get(id) // by primary key — error when missing
q.issues.related('comments') // with relations
```

Builders are immutable — every method returns a new builder — and identified by a stable hash of their contents, so you can build them inline in render with no dependency arrays:

```tsx
function IssueList({ status }: { status: string }) {
  const { data } = useQuery(q.issues.where({ status }))
  // a new builder every render, but the same query identity while `status` is stable
}
```

`.where()` autocompletes and type-checks the fields of the service's item type, and also admits everything it can't statically know: dotted relational paths (`'creator.teamId'`), server-only operators (`$regex`), and dynamically-built filter objects.

### `.one()` vs `.get()`

Both return a single item, with a deliberate semantic difference:

- `.where({ id }).one()` resolves to **`null`** when nothing matches — "find me the one matching row, if any".
- `.get(id)` is a primary-key lookup that enters the **error** state when the row doesn't exist — "this row must exist" (mirroring `service.get(id)` and NotFound semantics).

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
    // embed: the parent carries a server-maintained list of ids; figbird fans
    // every parent's list into ONE batched IN(...) fetch, preserving order
    spotlight: embed({ sourceField: 'spotlightIssueIds', destService: 'issues' }),
  },
})
```

`destField` defaults to `'id'`; fields accept arrays for compound keys. Relations stay live: a realtime event on any involved service — a new comment, a renamed user, a new junction row — flows into the assembled result.

Relational queries fetch efficiently: a single `IN (...)` query per relation level (not per parent), junction traversal in two queries, `embed` in one. The exception is a **windowed relation** — `.related('recent', i => i.orderBy(...).limit(5))` needs one query *per parent* because per-parent windows can't be expressed as a single find; figbird warns past 10 parents and points at `embed` as the batched alternative.

Relational filters work too — filter parents by a field on a related entity with a dotted path:

```ts
q.issues.where({ 'creator.teamId': 5 })
```

The server resolves the join; on the client, figbird's matcher evaluates the path against the entity cache so realtime events keep the result fresh.

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
4. **Params change** → that's a *different query* with a cold cache entry, so it suspends — the hook never shows old data labeled with new params. Keeping the previous UI on screen during the switch is one `startTransition` away; see [the no-flash checklist](#no-flash-checklist).

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

`useMutation` exposes the four CRUD methods. Every mutation returns a promise that settles on the **server response**, and the cache updates flow to every query referencing the data:

```ts
const issues = useMutation('issues')

await issues.create({ title: 'Ship it' })
await issues.patch(id, { status: 'closed' })
await issues.update(id, fullItem)
await issues.remove(id)
```

### Optimistic mutations

The `optimistic` flag decides **when the UI may show the change**:

- **off (default)** — "show it only once it's real": the cache updates after the server acks. Right for critical surfaces — settings, policies, anything where the user must know it saved.
- **on** — "show it now, roll back on failure": the cache updates immediately (and everywhere), and a server error rolls the change back everywhere at once. Right for collaborative, high-frequency surfaces — task lists, drag-reorder, inline edits.

Optimism is usually a property of a whole surface, so declare it once at the hook and let every call inherit it:

```ts
// A task board — everything on this surface is optimistic
const tasks = useMutation('tasks', { optimistic: true })
tasks.create({ id: crypto.randomUUID(), title })
tasks.patch(id, { done: true })

// A settings modal — the safe default, UI waits for the ack
const policies = useMutation('policies')
await policies.create(policy)
```

Per-call options override in both directions: `tasks.remove(id, { optimistic: false })`. You can also pass an explicit synthesized item as the optimistic value: `{ optimistic: { ...item, computedField } }`.

**Optimistic creates need a client-generated id** — without one there is nothing to track and roll back, so the create simply applies non-optimistically. `update`/`patch`/`remove` need nothing extra.

Per-call adapter params ride along in the same options object: `create(data, { params: { query: { ... } } })`.

## Preparation

Three pieces make preparation work: `defineQuery` gives a query a stable, args-keyed identity;
`prepare` starts it early with an explicit lease; `prefetch` warms it speculatively.

### defineQuery

A named query is an args-keyed query factory. The same definition read from a component, prepared by a router, or prefetched on hover resolves to the **same cache entry**:

```ts
export const issueDetail = figbird.defineQuery('issueDetail', ({ id }: { id: number }) =>
  q.issues.get(id).related('creator').related('comments'),
)

// component
const { data } = useQuery(issueDetail, { id: 42 })
```

Args are typed from the build function. When args arrive from an untrusted source — URL params, storage — pass a [Standard Schema](https://github.com/standard-schema/standard-schema) validator (zod, valibot, arktype…) as the middle argument; it runs at every call site and throws `QueryArgsError` on bad input, turning silent cache-splits (`{ id: "42" }` vs `{ id: 42 }`) into loud failures:

```ts
export const issueDetail = figbird.defineQuery(
  'issueDetail',
  z.object({ id: z.coerce.number().int().positive() }),
  ({ id }) => q.issues.get(id).related('comments'),
)

figbird.prepare(issueDetail, { id: '42' }) // coerces "42" → 42 before building
```

### prepare

`prepare()` is the router's primitive: it starts a query and returns an explicit a `promise` that resolves when the data is ready, and `release()` to drop the pin keeping it alive. Routers await route-critical data before committing a navigation; the destination screen then reads the same cache entry synchronously:

```ts
// route definition — router metadata like a priority is attached by the app
prepare: ({ params }) => [
  { ...figbird.prepare(issueDetail, { id: Number(params.id) }), priority: 'route' },
  { ...figbird.prepare(issueComments, { id: Number(params.id) }), priority: 'defer' },
]
```

Preparation is an *earlier read*, not a different one — the component still calls `useQuery(issueDetail, { id })`.

### prefetch

`prefetch()` is for speculative warming — the idempotent, fire-and-forget sibling of `prepare()`, built for "the user will probably need this" moments — hover, viewport entry, likely-next-page:

```tsx
<Row onMouseEnter={() => figbird.prefetch(issueDetail, { id: issue.id })} />
```

Safe to call at any frequency: if the query was prefetched within `staleTime` (default 30s) it's a no-op. Otherwise it fetches and holds an internal pin that auto-releases after `staleTime` — the data stays cached either way, so a later `useQuery` gets a warm, synchronous read (no Suspense fallback). If the user clicks through, the component's own subscription takes over seamlessly.

```ts
figbird.prefetch(issueDetail, { id }, { staleTime: 60_000 })
```

Rule of thumb: `prepare()` when you need to *await* readiness or control the lease; `prefetch()` when you just want things warm.

## Realtime

Figbird subscribes to realtime events per service (at most once per service) the moment a query against it is active. What happens when an event arrives is decided by the query's **classification** — the library's central idea:

- **local-exact** — membership, order, and values are provable from local state. Events merge directly into the cached result: a created record that matches appears, a patched record updates in place, a removed one disappears. No network.
- **server-window** — the query is windowed (`$limit` / `$skip` / `$sort`, or `.paginate()`). Visible rows are known, but an event may change membership invisibly — a row you can't see may now belong — so events trigger a **refetch** of the window instead of a guess.
- **server-authoritative** — membership or values depend on logic only the server can evaluate: `$regex` and other non-local operators, `$select` projections, or an explicit `.server()`. Events always trigger a refetch.

Classification is automatic and per query node — the root and each relation classify independently. Adding `.limit(30)` to a query flips it from merge to refetch; that's by design, and `figbird.explain()` will tell you exactly that:

```ts
figbird.explain(q.issues.where({ title: { $regex: term } }).limit(30).related('comments'))
// {
//   nodes: [
//     { path: '(root)', service: 'issues', class: 'server-authoritative',
//       reasons: [{ code: 'server-only-operator', detail: '$regex' },
//                 { code: 'window-filter', detail: '$limit' }],
//       realtime: 'refetch' },
//     { path: 'comments', service: 'comments', class: 'local-exact',
//       reasons: [], realtime: 'merge' },
//   ]
// }
```

Use `.server()` on a builder when a query *looks* locally provable but isn't — server-computed virtual fields, permission-dependent membership, search ranking:

```ts
q.documents.where({ visibleTo: userId }).server()
```

A practical consequence worth knowing: an **unwindowed** relation like `.related('comments')` is local-exact, so a teammate's new comment merges straight from the socket event with no refetch. If you don't need a window, don't add one.

# Guides

## No-flash checklist

`useQuery` never lies about identity: when a query's params change, that is a _different_
query with a cold cache entry, and the hook suspends rather than showing old data labeled
with new params. Honoring that contract without loading flashes takes three moves — one
per failure mode:

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

Combining `prepare`, `prefetch`, and lazy route chunks: the pattern that makes navigations feel instant is starting everything the destination needs — data *and* code — before the screen renders, in parallel:

```ts
// 1. Named queries live in an eagerly-loaded module
export const issueDetail = figbird.defineQuery('issueDetail', ({ id }: { id: number }) =>
  q.issues.get(id).related('creator').related('labels'),
)

// 2. The route fires data preparation and the lazy chunk import in parallel —
//    navigation latency becomes max(chunk, data) instead of chunk + data
{
  path: '/issues/:id',
  resolver: () => import('./pages/IssueDetail/screen'),
  prepare: ({ params }) => [figbird.prepare(issueDetail, { id: Number(params.id) })],
}

// 3. Hover starts the same queries even earlier — clicking is then a warm read
<Row onMouseEnter={() => figbird.prefetch(issueDetail, { id })} />

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

// Mutations
await figbird.mutate({ serviceName: 'tasks', method: 'patch', id, data: { done: true } })
```

## Custom adapters

Figbird works with any REST / WebSocket / RPC API wrapped in a Figbird-compatible adapter:

1. Structure your API around services or resources
2. Support the operations `find`, `get`, `create`, `update`, `patch`, `remove`
3. For realtime, emit `created`, `patched`, `updated`, `removed` events after mutations
4. Optionally implement `subscribeToReconnect` so active queries refetch after connectivity gaps

For example, a `comments` resource maps to `GET /comments`, `GET /comments/:id`, `POST /comments`, `PUT/PATCH/DELETE /comments/:id`, with `find` returning `{ data, total, limit, skip }` or similar. See `lib/adapters/feathers.ts` for the reference implementation of the `Adapter` interface.

# API Reference

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

The parent carries a server-maintained list of destination ids; figbird fans every parent's
list into one batched `IN (...)` fetch and assembles per-parent slices preserving the server's
order.

## Figbird

The core instance holding the adapter, schema, and shared query state.

```ts
const figbird = new Figbird({ adapter, schema, eventBatchProcessingInterval? })
```

| Member | Description |
| --- | --- |
| `q` | The builder proxy — `q.issues.where(...)`. Requires a schema. |
| `defineQuery(...)` | Named, args-keyed query factory — see [figbird.defineQuery](#figbirddefinequery). |
| `prepare(definition, args)` | Awaitable query lease for routers — see [figbird.prepare](#figbirdprepare). |
| `prefetch(definition, args, opts?)` | Idempotent speculative warming — see [figbird.prefetch](#figbirdprefetch). |
| `explain(...)` | Static classification report — see [figbird.explain](#figbirdexplain). |
| `inspect()` | Live-query snapshot — see [figbird.inspect](#figbirdinspect). |
| `events` | Observability channel — see [figbird.events](#figbirdevents). |
| `query(desc, config?)` | Low-level descriptor query (see [Using outside React](#using-outside-react)). |
| `relationalQuery(builder)` | Low-level relational query ref for non-React use. |
| `mutate(desc)` | Low-level mutation. |
| `getState()` / `subscribeToStateChanges(fn)` | Raw internal state — debugging only; prefer `inspect()`. |

## figbird.defineQuery

```ts
figbird.defineQuery(name, build)
figbird.defineQuery(name, argsSchema, build) // Standard Schema-validated args
```

Named, args-keyed query factory — `prepare`, `prefetch`, and `useQuery` against the same
definition and args share one cache entry. See [defineQuery](#definequery).

## figbird.prepare

```ts
const { key, promise, release } = figbird.prepare(definition, args)
```

Starts a query and returns an awaitable lease — the router-grade primitive. See
[prepare](#prepare).

## figbird.prefetch

```ts
figbird.prefetch(definition, args, { staleTime? }) // staleTime defaults to 30s
```

Idempotent, fire-and-forget speculative warming with a self-releasing pin. See
[prefetch](#prefetch).

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
})
```

Events carry ids, durations, and item counts — lightweight enough to subscribe in production.

## createHooks

Binds a Figbird instance to typed React hooks:

```ts
export const { useQuery, useMutation, q } = createHooks(figbird)
```

Returns the current generation — `useQuery`, `useMutation`, and `q` (the builder proxy) —
plus the deprecated legacy hooks (`useFind`, `useGet`, `useMethod`, `useService`,
`useFeathers`) for older codebases.

Instance resolution: hooks use the bound instance directly, so no provider is required. If a
`FigbirdProvider` is present in the tree, **it wins** — that's the injection point for
per-request SSR instances and tests. A dev-mode error fires if a provider holds a *different*
instance than the bound one.

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

Options: `skip?: boolean`, `suspense?: boolean` (must be static per call site).

Result fields (suspense form): `data` (guaranteed for the exact query passed), `error`
(non-null when a refetch failed while data is showing — cold errors throw instead),
`isFetching` (background fetch in flight on the current query), `refetch()`.

## useMutation

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

## FigbirdProvider

Optional. Hooks from `createHooks` work without any provider; use one to inject a different
instance into a subtree — per-request instances in SSR, or a fresh instance per test:

```tsx
<FigbirdProvider figbird={testFigbird}>{ui}</FigbirdProvider>
```

`useFigbird()` reads the context instance (throws without a provider); `useFigbirdMaybe()`
returns `undefined` instead.

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

## useMethod

**Deprecated.** Calls a custom Feathers service method with local lifecycle state:
`const [call, { status, data, error }] = useMethod('notes', 'archive')`. Custom methods
declared in the schema are fully typed.

## useService

**Deprecated.** Returns the typed raw Feathers service for operations outside Figbird's
caching layer: `useService('notes').archive(ids)`.

## useFeathers

**Deprecated.** Returns the typed raw Feathers client: `useFeathers().service('notes')`.
