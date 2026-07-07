# Figbird Design

Figbird is a client-side projection engine for server-authoritative Feathers queries, with
relational assembly and realtime-assisted reconciliation.

It is not intended to be a full local database, a general-purpose query engine, or a full sync
system like Zero. The goal is narrower: if an application can express a common relational query
shape in Figbird, Figbird should maintain that projection correctly, use cache where it is safe,
and ask the server to reconcile when correctness cannot be proven locally.

This document is the high-level reference for how the library is designed and why. It also
describes the integration story with `react-space-router` — the two libraries stay independently
useful, but they share one story for modern React SPAs:

- `react-space-router` owns navigation intent, route matching, lazy route modules, and route commit
  policy.
- Figbird owns query identity, data preparation, relational reads, cache projection, realtime
  reconciliation, and Suspense-compatible reads.
- React owns the final reveal via Suspense boundaries and transitions.

The product-level goal is not to expose every loading trade-off. It is to provide one good default:
acknowledge navigation immediately, keep stable context on screen, and reveal destination content
from the Figbird cache as soon as the destination's declared data is ready.

## Positioning

Figbird sits between two well-known shapes of client data layer.

- **Sync engines** (Zero, Replicache, Linear's loom) own a local replica. The client decides
  membership and ordering from the replica; the network is a synchronization protocol, not the
  source of truth at read time. Reads are synchronous and offline-first.
- **Request orchestrators** (TanStack Query, React Router 6.4+ loaders, Apollo Client) own a
  request graph keyed by query inputs. The server is authoritative; the client caches responses
  and decides when to refetch. Realtime, when present, is a side channel that invalidates entries.

Figbird is a request orchestrator with a sync-engine-style read model overlaid on top. The server
remains authoritative for any query whose membership, ordering, or values cannot be proven from
local state. But for the queries the client _can_ prove (local-exact filters, complete relations,
fixed-key lookups) Figbird treats realtime events as enough to maintain the projection without a
roundtrip — and it does the relational assembly itself, so screens read one denormalized tree
rather than five `useFind` calls and a `useMemo` join.

This is the asset Figbird brings that neither a pure sync engine nor a pure request orchestrator
brings cheaply for our stack: relational reads against a Feathers + Socket.IO backend, with the
client doing as much projection maintenance as it can prove correct and falling back to the
server otherwise.

## Architecture Layers

The end-to-end UI story factors into four concerns. Figbird owns one of them; the rest are
deliberately someone else's job.

- **Router (intent).** The router decides what the user wants to see. It owns URL, parameters,
  matched route segments, lazy component resolution, and the moment a route commits. For
  navigation-driven loads it should be able to kick off route-declared Figbird queries before any
  component mounts (fetch-as-you-render).
- **Figbird (query meaning + correctness).** Figbird turns a query builder into a fetch plan, a
  cache entry, a relational projection, and a stream of updates. Identical builders share one
  cache entry; correctness lives in the query classification (local-exact / server-window /
  server-authoritative).
- **React (reveal).** React's Suspense + transitions decide _when_ the user sees the new state.
  Figbird throws promises at cold reads and returns sync data at warm reads; React handles the
  reveal.
- **Product code (criticality).** The screen author decides which route queries are required for
  the initial destination view and which can stream in afterwards. Figbird does not infer this.

Figbird's job is to make each of those concerns clean to consume from the others. The hooks are
the contract.

## Non-Goals

These are explicitly out of scope. They are not bad ideas — they are different products:

- **SSR / RSC / streaming HTML.** Figbird targets live, socket-connected SPAs. The reveal model
  assumes a long-lived process that owns the realtime event stream. Server-rendered first paint
  is a different machine; we do not try to be both.
- **Offline-first / local writes against a replica.** Mutations are remote-first with optimistic
  cache writes layered on top. There is no local persistence layer, no rebase against an
  authoritative log, no operational-transform conflict resolution.
- **General-purpose query engine.** Figbird supports the shapes catalogued below; arbitrary joins,
  aggregates, negation, and recursive traversal are out of scope unless the backend exposes them
  as explicit services.
- **A second first-class rendering story.** See "Suspense-Native Reads" — the strategic read
  contract suspends for cold exact keys. The tagged-union mode exists as `{ suspense: false }` on
  the same hook, but new product-facing APIs should not make `isLoading` branches the normal path.

## API Design Principles

Rules that repeatedly decided API questions; new surface should be tested against them.

- **Defaults fail toward the cheap mistake.** A non-optimistic task-add merely feels slow; an
  optimistic policy-save that fails after the user walked away is silent data loss. Mutations
  default non-optimistic. The same logic keeps validation optional: forced ceremony teaches
  passthrough stubs, which look like safety and are not.
- **Declare intent at the altitude where it is constant.** Optimism is a property of a surface (a
  task list is always optimistic, a settings modal never is), so it is declared once per
  `useMutation` hook, overridable per call — not restated on every call and not frozen into the
  schema.
- **Two contracts, two names.** `prepare()` (awaitable lease) and `prefetch()` (idempotent
  fire-and-forget) could have been one function with a flag; then one name would mean two
  behaviors. When callers genuinely never want each other's contract, split the verb.
- **Admit everything legal, autocomplete everything known.** `.where()` types known item fields
  and keeps an open index signature for dotted relational paths and server-only operators. Types
  that reject legal queries teach casting, which is worse than looseness.
- **Absorb traps, don't export them.** If every consumer must learn the same workaround — deferring
  event delivery off the render path, deduping hover prefetches, delaying Suspense fallbacks — the
  library grows the mechanism and the workaround disappears.
- **One mental model per concern.** The non-Suspense read is an option on `useQuery`, not a second
  hook; preparation is an earlier read, not a different kind of read.
- **The first consumer is the proof.** The demo app is maintained as evidence: anywhere it needs
  machinery, a cast, or an apologetic comment to use the library, that is an API bug to fix here,
  not a recipe to document.

## Core Model

Figbird keeps two distinct kinds of cache:

- Entity cache: the latest known object by service and id.
- Query result cache: the ids and metadata that belong to a specific query result.

Query result membership must be first-class. Relation assembly must use the relevant relation
query result, not the whole entity cache, otherwise broader cached data can leak into refined
relations.

Realtime events are hints, not a complete correctness mechanism. An event can patch an entity,
invalidate a query, trigger a window refill, or cause missing relation leaves to be fetched. If
events may have been missed, active queries need reconciliation with the server.

## Query Classes

Figbird classifies each query node by how it can be maintained.

### Local Exact

The client has enough information to decide membership and update the result locally.

Examples:

```ts
figbird.q.people.where({ companyId })
figbird.q.people.where({ status: 'active' })
figbird.q.companies.get(id).related('departments')
```

These are safe when filters are local predicates, required fields are present in events, and the
query result is complete.

### Server Window

The client can reason about visible rows, but cannot know whether unseen rows should enter or leave
the result.

Examples:

```ts
figbird.q.people.where({ companyId }).orderBy('startDate', 'desc').limit(20)
```

If a visible row leaves this window, the replacement may be row 21, which may not be cached. These
queries need server refill/refetch for correctness. Local merge alone is approximate.

### Server Authoritative

Membership or ordering depends on server-only logic.

Examples include permission scopes, search ranking, custom SQL projections, virtual fields,
reporting-chain logic, and derived visibility rules.

For these, events should usually invalidate or refetch the query node. The client should not try to
reimplement the logic unless the backend exposes the required data and semantics explicitly.

### Manual / Unsupported

Some query shapes are outside Figbird's intended automatic-maintenance model.

Examples:

- Aggregation over unseen rows.
- Negation or absence queries, such as "people with no active employment".
- Arbitrary joins and arbitrary join predicates.
- Search ranking unless represented as a server-authoritative query.
- Complex permission-dependent scopes unless represented as server-authoritative queries.
- Infinite scroll/page merging without explicit cursor/window semantics.

These can still be fetched manually or exposed by the backend as explicit services/views.

## Relations

Relations should be modeled as query nodes with their own membership and completeness.

### One-To-One / Many-To-One

Usually local-exact if the foreign key is present.

```ts
person.related('manager')
employment.related('person')
```

If the related object is missing from cache, Figbird can fetch it.

### One-To-Many

Often local-exact for complete unpaginated relations with local filters.

```ts
company.related('people', p => p.where({ status: 'active' }))
```

Becomes server-window when sorted, limited, skipped, or otherwise windowed.

```ts
company.related('people', p => p.where({ status: 'active' }).orderBy('startDate', 'desc').limit(20))
```

### Many-To-Many

Best supported when the join table is modeled as a first-class service.

```ts
person.related('memberships').related('team')
```

If the many-to-many relationship only exists inside custom server logic, it should be treated as
server-authoritative.

### Derived Relations

Relations like `currentEmployment`, `effectiveCompensation`, or `currentManager` can be supported
if modeled as explicit services or explicit relation queries. If they depend on custom server logic
that the client cannot evaluate, they should be server-authoritative.

## Filtering By Related Fields

A common screen need is "parents matching a predicate over a related entity." A concrete shape
from production: open critical issues whose assignee is active and on my team.

Without first-class support, this is three `useQuery`s and a client-side combine:

```ts
const me = useCurrentUser()
const { data: teammates } = useQuery(q.people.where({ teamId: me.teamId, status: 'active' }))
const { data: issues } = useQuery(q.issues.where({ severity: 'critical', state: 'open' }))
const teammateIds = new Set(teammates.map(t => t.id))
const filtered = issues.filter(i => teammateIds.has(i.assigneeId))
```

Three subscriptions, three `useMemo`s, a client-side filter. Repeated per consumer. Figbird
should accept relation filters directly in `where`:

```ts
useQuery(
  q.issues
    .where({
      severity: 'critical',
      state: 'open',
      'assignee.teamId': me.teamId,
      'assignee.status': 'active',
    })
    .related('assignee'),
)
```

Equivalent verb form for clarity at deeper nesting:

```ts
q.issues
  .where({ severity: 'critical', state: 'open' })
  .havingRelated('assignee', a => a.where({ teamId: me.teamId, status: 'active' }))
  .related('assignee')
```

The dotted-path form and the `havingRelated` form are aliases for the same AST. Pick one as the
canonical runtime representation; expose both as authoring affordances.

Server contract:

The Feathers-side service must be able to resolve relation filters — either by accepting
dotted-path keys or by an internal `$eager`-style operator that translates to a SQL join with
predicates. Without server support this query class is unrunnable; Figbird does not synthesize
it client-side from a separate `.related()` fetch plus a parent filter, because that approach
only works for already-cached parents and is wrong for any new arrival the client hasn't seen.

Relations used in filters must be expressible as joins on the server. For Humaans this is the
realistic case for first-class relations — they are FK-backed in Postgres. Many-to-many
relation filters require the junction table to be expressible as an inner-join predicate
(sequelize include or `$exists`-style operator).

Inner-join semantics:

`havingRelated` (and the dotted-path form) implies an inner join: parents whose related
subquery returns no match are excluded from the result. Today's plain `.related('assignee')`
is left-join (parents without an assignee still appear with `assignee: null`). That distinction
must be preserved — the filter form is what changes the semantics, not the relation declaration.

Realtime semantics:

Membership of a relation-filtered parent query depends on data from two services. Three
classes of event affect the result:

1. **Parent service event.** A new issue arrives, or an existing issue is patched. Membership
   re-evaluates the usual way, with the constraint that the assignee data must be available
   to evaluate the predicate. Figbird already fetches `.related('assignee')` as part of the
   query, so the data is on hand. The matcher must implement dotted-path predicates against
   the assembled object.
2. **Related service event on a referenced entity.** A person whose id appears in the current
   result set has `teamId` changed from `X` to `Y`. Issues currently assigned to that person
   may need to leave the result. Figbird can re-evaluate locally because the assignee is in
   cache and the matcher can re-run against the updated entity.
3. **Related service event on a non-referenced entity.** A person with `teamId === X` and
   `status === 'active'` is created. No issues currently assigned to that person exist, so
   this event has no effect on _current_ membership. A _future_ issue create/patch that
   sets `assigneeId` to this new person is handled by case 1 when it arrives — at which
   point the assignee is fetched and the predicate is evaluated.

Local maintenance is feasible when the relation is fully fetched as part of the query. If
the relation is server-windowed (`.related('assignee', a => a.limit(N))`), the parent query
must be treated as server-window for the same reason any windowed dependency forces the
parent server-window: the visible related set isn't the complete set, so a missing match
might exist outside the window.

Open questions:

- The matcher must handle the case where a new parent event arrives but its related entity
  hasn't been fetched yet. Conservative answer: hold the parent in a pending state until the
  relation leaf is fetched, then evaluate. This extends today's "fetch missing relation leaf"
  path with a "membership undecided until leaf arrives" state.
- `$or` predicates that span parent and relation fields (e.g. "issue.priority === 'urgent' OR
  issue.assignee.role === 'owner'"). The server can express this; the client matcher needs
  the same expressivity. v1 can restrict to AND-of-predicates and grow later.
- Cross-relation filters that span sibling relations (`'assignee.teamId': X AND
'reviewer.role': 'admin'`). Should work by extension of the same matcher rules; document
  explicitly when implemented.

## Ordering And Completeness

Unordered complete sets are the easiest to maintain.

Ordered complete sets can be maintained locally if sort fields are present and deterministic.

Ordered limited windows are maintained locally for the provable subset of event effects and
require server reconciliation for the rest. The visible rows are a contiguous run of the server
result, so an event item whose sort position relative to the run's boundaries is known can be
merged: in-place patches, underfilled windows (the complete result set), inserts that sort
strictly inside the run (evicting the overflow row), and membership changes provably beyond the
window (total-only). What the client cannot know — whether an uncached row slides into a full
window after a removal, anything that shifts the page start of a skipped window, boundary ties —
reconciles by refetch. Sort position is judged by `$sort`, falling back to the configured
`defaultSort` (the backend's implicit order — a correctness contract like custom operators).

Server-derived ordering, such as search rank or permission-aware priority, should be treated as
server-authoritative.

## Realtime And Reconciliation

Figbird should treat events as inputs to a reconciliation strategy.

Examples:

- Entity patched and still matches local-exact query: update the item in place.
- Entity patched and no longer matches local-exact query: remove it.
- Entity created and matches local-exact query: insert it.
- Entity affects server-window query with a provable window effect: merge it locally (in-place
  patch, sorted insert with eviction, underfilled-window insert/remove, total-only adjustment).
- Entity affects server-window query unprovably: mark the window dirty and refetch/refill.
- Foreign key changes: remove from old relation result and add/refetch the new relation result.
- Missing relation leaf is needed for the expressed query shape: fetch it.
- Reconnect after possible missed events: mark active queries stale and reconcile with the server.

Useful internal states for query nodes:

- `fresh`
- `stale`
- `dirty-membership`
- `dirty-order`
- `dirty-window`
- `dirty-relation-leaf`
- `fetching`
- `error-with-previous-data`

The engine should use the most targeted safe reconciliation available, but correctness is more
important than avoiding a refetch.

## Fundamental Limits

Figbird can maintain a client projection exactly when it has either:

- Enough local information to prove membership, ordering, and relation completeness; or
- An authoritative server query it can refetch/reconcile when local proof is impossible.

Figbird cannot locally guarantee correctness when:

- Membership depends on server-only logic.
- Ranking or ordering depends on rows not in cache.
- A limited window needs rows outside the current window.
- Aggregates depend on unseen rows.
- Negation depends on knowing global absence.
- Realtime events were missed and there is no replay/sequence protocol.
- Events contain partial objects that omit fields needed for filters, sorts, or relations.
- Derived relations are not modeled as explicit services, relations, or server-emitted projection
  events.

These are information boundaries, not implementation bugs. Many can be handled by treating the
query node as server-authoritative and refetching it.

## The 80% Target

Figbird handles these cases robustly:

- `get(id)`.
- Full filtered lists with local predicates.
- One-to-one and many-to-one relations.
- One-to-many relations with local filters.
- Nested relations.
- Filtered relations.
- Sorted full relations where sort fields are present.
- Sorted/limited/windowed relations via server refetch.
- Many-to-many via explicit join services.
- Reconnect refetch of active queries.
- Missing relation leaf fetches.
- Explicit server-authoritative escape hatches for custom, permissioned, or search-backed queries.

The public API should remain simple. Users should express the query shape; Figbird should choose the
maintenance strategy internally where possible. If Figbird cannot make a correctness guarantee for a
query shape, that shape should be explicit manual/server-authoritative rather than silently
approximate.

## Coverage

Supported automatically:

- Local-exact root queries and relation queries with matcher-supported predicates.
- Nested one-to-one, many-to-one, and one-to-many relations.
- Fixed-depth self relations expressed with nested `.related(...)` callbacks.
- Many-to-many relationships represented through explicit join services.
- Sorted, skipped, limited, selected, or otherwise server-windowed query nodes via server refetch.
- Unsupported `$` operators such as `$search`, `$asOf`, or `$withVisibility` by treating the query
  node as server-maintained instead of building a local matcher.
- Active-query reconciliation when the adapter reports a transport reconnect.

Supported with explicit `.server()`:

- Server-maintained projections and views whose query fields look ordinary to the client but whose
  membership, ordering, or values depend on backend logic.
- Services where upstream domain changes are re-emitted as realtime events on the projection service
  itself.

Backend/manual responsibilities:

- Emit projection-service realtime events when upstream data changes a server-maintained projection.
- Model many-to-many joins as explicit services if the client should assemble them relationally.
- Model aggregation, negation/absence, recursive traversal, arbitrary joins, and complex reporting
  chains as service/query/view endpoints rather than generic client-side relations.
- Provide replay/sequence support if the product needs stronger missed-event guarantees than
  reconnect refetch of active queries.

## Suspense-Native Reads

Figbird's strategic read hook has one contract: `useQuery` returns data only for the exact query key
passed in the current render. If that key is cold, it suspends. If that same key already has data,
refetches keep returning that data with `isFetching: true`. The common product path should not
contain an `isLoading` branch. `<Suspense>` and `<ErrorBoundary>` own loading and first-read errors
because that is where they compose properly with the rest of the React tree.

The explicit tagged-union mode exists as an option on the same hook — `useQuery(query,
{ suspense: false })` returns `{ status, data, error, isFetching, refetch }` and never suspends or
throws. It is the right tool for components that render their own inline loading/error UI, but it is
not the north-star: documentation and product code lead with Suspense.

### Cache Entries As Tagged Unions

Internally each query's state in `QueryStore` is a tagged union:

```ts
type Entry<T> =
  | { status: 'pending'; promise: Promise<T> }
  | { status: 'success'; data: T; isFetching: boolean }
  | { status: 'error'; error: Error; data?: T }
```

`useQuery` reads the current entry via `useSyncExternalStore` (which gives us tearing-free reads
and direct access to the realtime-driven cache updates). It then translates entry status into
React semantics:

- `pending` → throw `entry.promise`. React unwinds to the nearest `<Suspense>`.
- `success` → return `{ data, isFetching, refetch, error: null }`.
- `error` on first read → throw `entry.error` to the nearest `<ErrorBoundary>`.
- `error` after a prior success → return `{ data: lastSuccess, error, isFetching, ... }`. Don't
  unmount the screen because a refetch failed; the UI shows a toast or inline banner.

This composition (`useSyncExternalStore` + `throw promise`) does work — `useSyncExternalStore`
opts the _subscription_ out of concurrent rendering, but the _render_ still throws when the
selector returns a pending entry. The throw goes through React's normal Suspense plumbing
unchanged. The constraint we accept is that Figbird-driven cache updates are committed
synchronously rather than via transitions. Transitions matter when the router or product code
wraps the state change that causes a different exact query to render.

### Exact Query Reads

A query key is the stable identity derived from the query definition, validated args, and builder
AST. Two reads with the same key share cache state. Two reads with different keys must not share
returned `data`.

`useQuery` should not lie about identity. The `data` it returns must belong to the exact query key
it was called with in the current render. Returning issue `1` from `useQuery(issueDetail, { id: 2 })`
is not acceptable; product code will naturally assume the returned entity matches the inputs it just
passed.

The base contract:

1. **First mount, cold cache.** Throw the pending promise. Suspense fallback shows. This is the
   normal time the user sees a fallback for a `useQuery` call.
2. **First mount, warm cache.** Return cached data synchronously, refetch in the background,
   surface `isFetching: true`. No fallback.
3. **Refetch of the same query key with data present** (focus, realtime, manual `refetch()`).
   Never suspend. Return current data for that same key with `isFetching: true`.
4. **Query key changes and the new key is cold.** Suspend. If product code wants old content to
   remain visible, the old render must remain committed while the new render prepares. It should
   not receive old data as if it were the new query's `data`.

This is not React tearing in the technical sense, but it is semantic tearing: route params,
component props, and returned data no longer describe the same thing. Figbird should avoid that
as a core invariant.

This distinction matters for route params. Moving from `/issues/1` to `/issues/2` is usually a new
detail identity, not "the same query with changed args". Key the detail boundary by `issueId` so
React unmounts the old query instance and mounts a new one. The new instance can suspend cold,
giving the desired destination-shaped loading state:

```tsx
<Suspense key={issueId} fallback={<IssueDetailSkeleton />}>
  <IssueDetail issueId={issueId} />
</Suspense>
```

Figbird should not decide whether a parameter change is a new experience. The route/product
boundary decides that by choosing boundary identity.

### Local Input Transitions

`useQuery(query, args)` reads exactly `args`. When a screen wants old results to remain visible
while new local inputs load, the safe mechanism is React's normal concurrency model: keep the old
render committed while a new exact render attempts the new args.

For discrete local state changes, product code can use `startTransition`:

```tsx
const [filter, setFilter] = useState('active')
const [isPending, startTransition] = useTransition()

function changeFilter(next: string) {
  startTransition(() => setFilter(next))
}

const { data } = useQuery(peopleList, { filter })
```

If `{ filter: next }` is cold and suspends, React can keep the previous committed render on screen:
old `filter`, old query args, and old data remain coherent together until the new exact render is
ready.

For text input, split urgent input state from deferred query state:

```ts
const [draftSearch, setDraftSearch] = useState('')
const search = useDeferredValue(draftSearch)
const { data } = useQuery(peopleSearch, { search })
```

The input can show `draftSearch` immediately. The results are explicitly for `search`. If the UI
renders a "results for X" label, it should use `search`, not `draftSearch`.

The core API should work with plain `useQuery`, route preparation, `startTransition`,
`useDeferredValue`, and keyed Suspense boundaries. Do not add a Figbird-specific deferred-query
hook until repeated product code proves that the React primitives are too verbose.

### Why There Is No Second Hook

A non-Suspense `{ status, data, error }` shape has to exist because some components legitimately
own their loading/error rendering. But it must not become a second mental model — so it is an
_option_ on the one hook (`{ suspense: false }`), not a separately named hook, and both modes run
the same query machinery underneath. The legacy `useFind` / `useGet` shims exist for older
codebases only; they are deprecated and also call into the same machinery.

## Mutations And Optimism

Mutations are remote-first: every `create`/`update`/`patch`/`remove` returns a promise that settles
on the server response, and the resulting entity flows through the same event pipeline as realtime
events — a mutation from one component updates every query referencing the data, exactly as a
socket event from another client would.

The `optimistic` flag decides _when the UI may show the change_, and the two modes deserve their
plain names:

- **"Show it only once it's real"** (default) — the cache updates after the server acks. For
  critical surfaces: settings, policies, anything where the user must know it saved before walking
  away.
- **"Show it now, roll back on failure"** (`optimistic: true`) — the cache applies a synthetic
  event immediately; a server failure applies the inverse event, rolling the change back everywhere
  at once (and emitting `mutate:rollback` on the observability channel).

Optimistic and awaitable are not opposites — the promise settles on the ack in both modes.

Optimistic creates must carry a client-generated id the server will accept (the id contract —
see "The m Proxy, Default Optimism, And The Id Contract" below); an id-less optimistic create
throws. `update`/`patch` synthesize their optimistic item from the cache (`patch` merges onto the
cached entity; an explicit item can be passed via `optimisticItem` for computed fields); a
patch/update on an entity that is not cached applies nothing optimistically — there is nothing
displaying it — and the server response updates the cache as usual. `remove` deletes the cached
row immediately (restored on rollback); an uncached row isn't displayed anywhere, so there is
nothing to apply.

### The Write-Side Split (July 2026)

`useMutation` conflated two roles: a **service client** (a bag of CRUD methods, inviting
one-hook-per-service usage) and a **status tracker** (a single status slot, requiring
one-hook-per-action). The shape suggested the first; the state only worked under the second — so
every multi-action screen hand-rolled a pending-state machine next to it. The root fact: the
library cannot know what an "action" is (reassign and close are both `patch` on `issues`); action
identity exists only in the app's vocabulary, and React's mechanism for app-defined identity is the
hook call site. Meanwhile "is anything mutating this record" IS knowable by the library (service,
method, id).

The replacement factors each granularity to the layer that owns it:

- **`mutations(service, defaults?)`** — the stateless service client. Not a hook (it subscribes to
  nothing); callable at module scope, in event handlers, in non-React code — the same coherence
  move as `prepare`/`prefetch`/`defineQuery` being plain bound functions. Handle-level `optimistic`
  replaces hook-level; custom schema `methods` appear on the handle typed (subsuming `useMethod`,
  which was removed — its calls previously bypassed the core entirely and were invisible to
  observability; they now flow through `figbird.call`, emitting `mutate:*` events and registering
  with the tracker).
- **`useAction(fn)`** — per-action `pending`/`error`/`data` around any async function; one hook
  call site per action. `pending` is a counter (overlapping runs), `error`/`data` are last-settled
  slots cleared on run start, and `run()` never rejects (failures land in `error`; sequencing and
  per-invocation recovery live inside the action body — which is plain async JS where `try`/`catch`
  works natively). The body executes as a React Action (async transition), so suspense-triggering
  consequences — navigate-after-delete, query changes — keep the previous UI committed instead of
  flashing fallbacks; the `pending` flip stays urgent so labels swap immediately. The reads-side
  rule "params changes are transitions" gets its write-side mirror made literal: reads suspend,
  writes are transitions.
- **`useMutating(filter?)`** — entity/service/instance-level in-flight state. Deliberately NOT
  built on the events channel: event delivery is deferred to a microtask and events never replay,
  so a subscriber mounting mid-mutation would report a false negative. A synchronous
  `MutationTracker` in the core (updated at the mutate call sites, exposed as `figbird.mutating`)
  gives `useSyncExternalStore` a correct snapshot at any moment. The canonical use is serializing
  writes per record — overlapping optimistic patches make rollback ambiguous, so the app disables
  the surface while `useMutating({ service, id })` is true.

Non-goals, decided: no keyed status on `useMutation` (stringly identity split across two call
sites); no drop/serial/once modes on `useAction` (the entity-level disable is the real concurrency
policy; button-level modes would paper over it); no event-stream-based `useMutating` (see above).
`useMutation` remains as a deprecated, fully-functional legacy hook.

`mutate:*` events gained a `mutationId` correlating one mutation's lifecycle, and their `method`
widened to admit custom method names.

### The m Proxy, Default Optimism, And The Id Contract (July 2026, second pass)

Three refinements landed together, replacing the first pass's `mutations(service, defaults)`
factory:

**`m` — the write proxy.** Services are properties (`m.issues.patch(...)`), mirroring `q`; one
DSL convention for the whole library: _selections are properties, operations are methods_. The
factory's `defaults` argument is gone, and with it the handle-naming problem (`issues` the handle
vs `issues` the query data). Policy is a fluent variant, not an options bag — matching how the
read side spells policy (`.server()`, `.snapshot()`). `confirmed` is a property, not a method,
because it _selects_ a namespace of verbs rather than operating on a pipeline value. Handle
proxies deny exactly two protocol props: `then` (a callable one makes handles thenable, so an
`await` on a handle returned from an async function hangs forever, unsettled) and `toJSON` (a
callable one turns JSON.stringify — logging, error reporting — into a phantom network write).
Broader duck-typing probes (jest's `asymmetricMatch`, React's `$$typeof`, ...) are deliberately
unguarded: handles are module-scope verbs, not data, and guarding against usage the API doesn't
invite is ceremony. For dynamic service names the proxy is callable — `m(name)`, mirroring
`q(name)` — rather than a separate `figbird.mutations(name)` method.

**Optimistic by default; `confirmed` opts out.** The first pass made optimism a handle-level flag;
the demo then passed `{ optimistic: true }` on every surface — when 100% of call sites set the
same flag, the default is wrong. The inversion is safe _now_ because the write-side split built
its preconditions: failures land in `useAction.error`, rollback is global and observable, and
`useMutating` powers the per-record serialization policy. Awaiting call sites are unaffected in
both modes (the promise settles on the ack; optimism only controls when the cache shows the
change). `confirmed` is deliberately greppable — it names the critical surfaces. The low-level
descriptor (`figbird.mutateDesc`) and the deprecated `useMutation` keep the old non-optimistic
default: the inversion is a property of the `m` DSL, so legacy code changes behavior only when it
migrates. Per-call options carry data only (`params`, `optimisticItem`) — the
`optimistic: boolean | item` flag/payload union is gone from the new DSL.

**The id contract.** Optimistic creates must carry a client-generated id the server will accept
(`crypto.randomUUID()`); an id-less optimistic create throws synchronously, naming both escapes.
Confirmed creates are the mode for server-assigned ids — await the create, the server's item
carries its identity. The principle (Zero/Replicache/Linear-aligned): an optimistic item without
a server-valid id is an item without identity, and everything downstream is built on identity —
React keys, realtime echo dedup (the echo merges idempotently because it shares the client id),
navigation, child-row foreign keys. Servers with auto-assigned ids can't do optimistic creates,
and that is the honest shape of the constraint rather than a limitation to engineer around.
Optimistic creates register their id with the mutation tracker, so `useMutating({ id })` covers
the create→navigate→act-before-ack window.

`useAction` gained an optional name (`useAction('reassign', fn)`) emitting
`action:start/end/error` observability events — devtools speak the app's vocabulary with the
`mutate:*` rows alongside — and its `run` doubles as a React 19 `<form action>` (verified;
`useFormStatus` works in the form's children).

## Prepared Queries

`useQuery` covers the in-component exact-read case. It does not let the _router_ start loading data
before any component mounts. Prepared queries bridge that.

```ts
const issueDetail = defineQuery(({ id }: { id: number }) =>
  q.issues
    .get(id)
    .related('comments', c => c.orderBy('createdAt', 'desc').limit(50))
    .related('labels'),
)

// Anywhere — typically a router loader or a parent component:
const prepared = prepare(issueDetail, { id: 42 })

// Inside the component:
const { data } = useQuery(issueDetail, { id: 42 })
```

Properties:

- **Pure declarations.** `defineQuery(build)` returns an inert value — no cache state, no
  instance dependency — so definitions live in the same layer as the schema. App code gets a
  schema-typed `defineQuery` from its `createHooks` kit; a standalone export serves non-React code.
  The name is optional metadata (a label for `QueryArgsError` and devtools), never identity —
  identity is the built AST's hash, so a required name would be pure ceremony duplicating the
  variable name.
- **Stable identity.** Calling
  `prepare(query, args)` and later `useQuery(query, args)` with the same args hits the same cache
  entry — no need to thread the builder instance through.
- **Args validation, when args are untrusted.** Args are typed from the build function; when they
  arrive from URLs or storage, an optional Standard Schema validator
  (`defineQuery(argsSchema, build)`) runs at every call site and fails loudly rather than
  producing silent cache misses (`{ id: "42" }` vs `{ id: 42 }`). Args from typed code need no
  validator — a mandatory one only teaches consumers to write passthrough stubs.
- **Earlier read, same entry.** `prepare` starts the same query that `useQuery` would read later.
  The component does not receive data from the router; it reads normally from Figbird.
- **Awaitable by orchestration.** `prepare` returns a lightweight handle that can be awaited by a
  router commit policy, inspected for readiness, or ignored by callers that only want to warm the
  cache.
- **Lifecycle-aware.** Prepared entries must be pinned long enough for the navigation they belong
  to, then released if no component subscribes. The router should not create permanent cache
  roots just because a user hovered or briefly navigated.
- **Composable.** A prepared query is still a query; it participates in the same realtime
  reconciliation, relational assembly, and exact-read rules as ad-hoc builders.

This is the integration point for routers, hover prefetch, command-palette prefetch, and parent
components that can see child data needs earlier than the child itself.

The handle shape should be explicit enough to force lifecycle discipline:

```ts
type PreparedQuery = {
  key: string
  promise: Promise<void>
  release(): void
}
```

`promise` resolves when the exact query key has data ready for a Suspense read, or rejects with the
same error that `useQuery` would throw for that key. `release()` drops the temporary preparation pin;
it must not evict data that mounted components are actively reading. Router metadata — such as a
blocking/deferred priority — is deliberately not part of the handle: figbird never reads it, so the
route-prepare function attaches it (`{ ...figbird.prepare(def, args), priority: 'defer' }`).

### Speculative Prefetch

`prepare()` is an explicit lease: a promise to await, a pin to release. That contract is right for
routers and wrong for speculation — a hover handler has no natural moment to release a pin, and
calling `prepare()` repeatedly re-triggers revalidation. So speculation gets its own verb with its
own contract:

```ts
figbird.prefetch(issueDetail, { id }, { staleTime: 30_000 })
```

`prefetch()` is idempotent and fire-and-forget: a no-op when the query was fetched within
`staleTime`, otherwise it fetches and holds an internal pin that auto-releases after `staleTime`.
The data stays cached either way, so a later `useQuery` is a warm synchronous read. Two use cases,
two contracts, two names — a mode flag on `prepare()` would have made one name mean both.

## Read Policies And Reference Data

Three read policies complete the maintenance picture, each placed by one rule: **identity on the
builder** (it changes what the data means), **tolerance at the read site** (it changes only when
we double-check).

- **`staleTime`** (read-site option on `useQuery`/`prepare`/`prefetch`) — the reader's freshness
  tolerance: data younger than it skips the SWR revalidation on mount. `0` (default) revalidates
  always; `Infinity` is cache-first; the useful middle is now expressible. Not part of query
  identity: readers with different tolerances share one entry and the most demanding keeps it
  fresh.
- **`.snapshot()`** (builder verb) — a point-in-time result: fetched once, frozen against
  realtime for the whole tree, moved only by `refetch()`. Part of identity — frozen and live
  reads of the same filters must not share an entry. `explain()` reports `realtime: 'manual'`.
- **`.all()`** (builder verb) — exhaustive fetch: drain every page of every matching row, so
  the server's default page cap never truncates the result. Filtered, it yields a complete
  slice — complete for that exact query only, maintained by local realtime merges (an event
  either matches the filter or doesn't); it does not materialize the service. Unfiltered, on
  success the service is fully materialized: matcher-decidable finds — including sorted/limited
  windows — are answered locally by a small local executor (matcher filter + `$sort` comparator
  - slice), realtime events maintain the set (windowed subsets recompute locally, no network),
    and the materialization root reconciles on reconnect even with no subscribers. Refuses
    `.limit()`/`.skip()` at the verb level (windowing contradicts "all"; `.orderBy()` is fine —
    order doesn't affect completeness); server-only predicates still go to the server. The
    unfiltered form is the one deliberate step toward a local database, scoped to services the
    author explicitly opted in.

The recipe table:

| Data                                          | Recipe                                         |
| --------------------------------------------- | ---------------------------------------------- |
| Reference data (locations, currencies, roles) | unfiltered `.all()` at the shell — reads free  |
| Complete filtered sets ("no page cap" reads)  | `.where(...).all()` — exhaustive, merge-kept   |
| Ordinary live data                            | default: swr + classification                  |
| Expensive-but-tolerant data                   | `staleTime` — bounded revalidation, still live |
| Point-in-time data                            | `.snapshot()` — frozen until `refetch()`       |

## Router Integration

The integration target is `react-space-router`. The shape generalises to any router with a
predictable navigation lifecycle, but the design should fit `space-router`'s existing route object
model rather than importing a different framework's abstractions.

`space-router` already treats route definitions as user-extensible objects and returns a matched
ancestor chain as `route.data`. `defineRoute` does not need to be a runtime framework. It can start
as a typed identity helper around the route objects we already have.

The authoring pattern is: each screen lives in its own folder, with the screen component
code-split via `resolver` and the prepare function declared in a sibling file that the route table
imports synchronously.

```ts
// pages/IssueDetail/prepare.ts
import { issueDetail, issueActivity } from './queries'

export const prepareIssueDetail = ({ figbird, params }: RoutePrepareContext) => [
  // priority is router vocabulary — the app attaches it, figbird never reads it
  { ...figbird.prepare(issueDetail, { id: Number(params.id) }), priority: 'route' },
  { ...figbird.prepare(issueActivity, { id: Number(params.id) }), priority: 'defer' },
]
```

```ts
// routes.ts
import { prepareIssueDetail } from './pages/IssueDetail/prepare'

const routes = defineRoutes([
  defineRoute({
    component: Shell,
    routes: [
      defineRoute({
        component: Protected,
        routes: [
          defineRoute({
            path: '/issues/:id',
            resolver: () => import('./pages/IssueDetail/screen'),
            prepare: prepareIssueDetail,
            navigation: { commit: 'immediate' },
          }),
        ],
      }),
    ],
  }),
])
```

At boot, the app passes `routes` to `<Routes routes={routes} />`. During navigation,
`react-space-router` walks the matched `route.data` segments, fires each segment's `prepare()` and
its lazy `resolver()` import in parallel, and then applies the route commit policy.

Route preparation reruns whenever the matched route changes or whenever route inputs used by the
matched segments change. That includes path params and any query params that the route's `prepare`
function reads. Query params that are only local UI state can stay in product code and use normal
local input transition patterns.

The reason `prepare` lives in the eagerly imported layer rather than inside the lazy screen module
is chunk+data parallelism on cold paths. When the URL changes, the router can fire `prepare()` and
`resolver()` simultaneously, so total navigation latency becomes `max(chunk, data)` instead of
`chunk + data`. If `prepare` lived inside the lazy chunk, the data fetch could not begin until the
chunk had downloaded — the exact serial waterfall the integration is paying complexity to avoid.

Co-location is preserved at the folder level (`pages/IssueDetail/{prepare,queries,screen}.ts`).
The cost is a small bundle increase from the eagerly imported prepare and query definitions; in
practice that is a few kb per route, dwarfed by the screens themselves.

### Boundary Identity

Route commits and query reads are separate from Suspense boundary identity. When a parameter change
should reset the destination and allow cold data to suspend again, product code can key the relevant
boundary:

```tsx
<Suspense key={issueId} fallback={<IssueDetailSkeleton />}>
  <IssueDetail issueId={issueId} />
</Suspense>
```

This is the simplest escape hatch for entity-detail routes, wizard steps, or any destination where
previous content is more confusing than a local loading state. Search/filter changes, pagination
controls, and dense work surfaces usually should not reset the boundary; preserving the old result
while the next result loads is more useful.

The router can grow a `suspenseKey` helper later if this pattern appears everywhere, but it should
not be part of the first design pass. React already gives us keyed boundaries, and that is enough
until repetition proves otherwise.

### Priorities

Each prepared query is tagged by the route-prepare function with one of two priorities. (The tag
lives on the router side of the line — figbird's `PreparedQuery` handle does not carry it.)

- `priority: 'route'` — required for the initial reveal of this route. The route-commit policy
  (below) may wait for these.
- `priority: 'defer'` — should start fetching as early as possible but does not gate the reveal.
  Used for below-the-fold panels, secondary feeds, anything the screen can render a placeholder
  for.

Figbird does not infer this. The screen author classifies each query because correctness here is
a UX judgement (is a stale-empty list acceptable while the user reads the title?), not a fact
derivable from the data graph.

### Commit Policies

Commit policy is a router concern. It answers one question: when should the matched route become
the current route?

- `commit: 'immediate'` (default). Navigate immediately; route-priority queries that are still
  loading suspend at the screen's nearest `<Suspense>`. URL, selected nav state, breadcrumbs, and
  destination chrome update immediately. Best for most B2B screens because it acknowledges the
  user's intent and lets the destination show a local, destination-shaped pending state.
- `commit: 'ready'` — an optional later policy. Wait for all `priority: 'route'` queries to
  resolve, _then_ commit the navigation. The user stays on the previous route during the wait, with
  the link/button/top bar visibly pending. Optional `timeoutMs` caps the wait; on timeout, the
  router falls back to immediate-commit semantics.

The default should be `commit: 'immediate'`. Keeping old content on screen is useful only when the
destination would otherwise mount a large, mostly empty shell or when a sub-600 ms hold avoids a
visibly worse fallback. It should not be the universal SPA pattern; it can make navigation feel
ignored if the URL, selection, and destination context do not update quickly.

The practical middle ground is:

```ts
navigation: { commit: 'ready', timeoutMs: 600 }
```

This says: "If the destination can be made ready almost immediately, avoid showing a fallback. If
not, commit the destination and show its own loading UI."

These are router-level policies, not Figbird-level. Figbird exposes the prepared queries and the
"is this route's set of prepared queries ready" signal; the router decides when to flip. The line
is intentional — the router owns navigation; Figbird owns query state.

### Navigation Pipeline

A Suspense-aware `react-space-router` transition should look like this:

1. Match the destination URL.
2. For each matched segment, fire its `prepare()` and start its lazy `resolver()` in parallel.
3. Mark the navigation target pending immediately so links, selected rows, and the route loading
   bar can respond.
4. Associate the work with a navigation token. Prepared queries from superseded navigations may
   finish, but they must not commit the route or keep preparation pins alive beyond their release
   window.
5. Apply the commit policy:
   - `immediate`: commit the route now.
   - `ready`: wait for route-priority prepared queries and lazy modules, bounded by `timeoutMs`.
6. Commit the route inside a React transition so already revealed parent UI is not replaced by
   accidental fallbacks.
7. Let destination Suspense boundaries reveal any still-deferred or still-cold regions.

This preserves the small `react-space-router` mental model: route objects in, matched route out.
The new machinery is route preparation and commit timing, not a new rendering framework.

### Choosing The Surface

The DX rule should be boring:

- Put data in `route.prepare` when the URL implies it and the router can know it before render.
- Mark prepared data as `priority: 'route'` only when the first destination view is incoherent
  without it.
- Mark prepared data as `priority: 'defer'` when it is useful to start early but a local boundary
  can reveal it later.
- Use plain `useQuery` for exact reads: route/detail data, modals, drawers, hovercards,
  autocomplete, optional sidebars, and drill-downs that are not represented by the URL.
- Use `startTransition`, `useDeferredValue`, or debouncing when the same mounted component changes
  local query inputs and should keep prior input/data pairs visible while the next input resolves.
- Use `navigation.commit: 'ready'` sparingly, usually with `timeoutMs`, when a brief hold on the
  previous screen produces a better experience than mounting the destination fallback.

There should not be separate hooks named `usePreparedQuery`, `useRouteQuery`, or
`useBlockingQuery`. Preparation is an earlier read, not a different kind of read. Components read
with `useQuery(query, args)` regardless of whether the router prepared the same query first.

## UX Timing Contract

The whole point of the design is to put the right shape of UI in front of the user at the right
time. The opinion the library encodes:

- **< 100 ms** — show nothing, no skeleton, no spinner. Cold reads that resolve this fast should
  appear instant. (`commit: 'immediate'` + Suspense fallback that renders nothing for the first
  ~100 ms is the typical wiring.)
- **100 – 500 ms** — show a pending affordance: a route-level progress bar, a desaturated/disabled
  state of the link the user clicked, `isFetching: true` on the screen. _Don't_ show a skeleton
  yet; the data usually arrives before the skeleton would have been a net positive.
- **500 ms – 2 s** — show a skeleton for the section that is still loading. By now the user knows
  something is happening and the skeleton is informative, not noise.
- **> 2 s** — show a determinate progress indicator if possible, or at least an explanation
  (slow connection, large dataset). Consider the operation's design contract broken: this is the
  range where realtime / suspense alone are not enough.

These thresholds inform fallback reveal timing and pending indicators, not anything users have to
wire up by hand. The library ships the kit that encodes them — `DelayedFallback` (fallbacks that
only appear when loading is actually slow), `useDelayedFlag` (spinners that neither flash nor
yo-yo), and `useDebouncedTransition` (text input committed inside a transition) — plus a "no-flash
checklist" in the docs that maps each failure mode to its tool.

## Instance Binding And Introspection

**One instance, optional provider.** `createHooks(figbird)` returns the daily-use kit _bound_ to
that instance — the hooks, `q` (the builder proxy), schema-typed `defineQuery`, and bound
`prepare`/`prefetch` — so a singleton SPA needs no `FigbirdProvider` at all and imports everything
from one module. Context, when
present, overrides the bound instance — that is the injection point for per-request SSR trees and
per-test instances — and a dev-mode error fires when a provider holds a _different_ instance than
the bound one, because that divergence used to be silent (types from one instance, runtime from
another).

**Classification must be visible.** Whether a query node is local-exact, server-window, or
server-authoritative decides its entire realtime behavior, and it flips implicitly — adding
`.limit(30)` turns merge into refetch. Two read-only surfaces keep that legible:

- `figbird.explain(builderOrDefinition)` — a static per-node report: classification, the structured
  reasons that produced it (`{ code: 'server-only-operator', detail: '$regex' }`), and the
  resulting realtime mode. Assertable in tests ("this thread query must stay local-exact"),
  renderable in devtools, and the answer to "why did my list start refetching".
- `figbird.inspect()` — a deliberately small, stable snapshot of every live query (classification,
  status, item count, fetch time, subscriber count). Devtools build on this projection so the
  internal store shapes stay free to change.

**Observability is deferred.** `figbird.events` (fetch/realtime/mutation lifecycle facts) delivers
on a microtask, batched and ordered, with timestamps captured at emit time — some emits happen
synchronously inside a React render, and delivering there would force every React-bound subscriber
to defer manually or hit "setState during render".

## Query Shape Catalogue

These are representative query shapes Figbird should support well. They are intentionally written
as product-shaped examples rather than abstract database tests, because these are the patterns that
should drive regression coverage.

### Narrow Profile Load

Opening a profile by deep link should not require loading every person or job role into core data.

```ts
useQuery(
  figbird.q.people
    .get(personId)
    .related('currentJobRole')
    .related('manager')
    .related('location')
    .related('directReports', r =>
      r.where({ status: 'active' }).orderBy('fullName', 'asc').limit(20),
    ),
)
```

Expected behavior:

- Fetch only the root person and declared relations.
- If `managerId` changes, fetch the new manager and remove the old manager from this projection.
- If a report changes manager or status, update or refetch the direct reports relation as needed.
- Because direct reports are sorted/limited, relation membership is server-windowed and must be
  reconciled with the server when an event could affect the window.

### People Directory Window

```ts
useQuery(
  figbird.q.people
    .where({ status: { $in: ['active', 'newHire'] } })
    .orderBy('fullName', 'asc')
    .limit(50)
    .related('currentJobRole')
    .related('location'),
)
```

Expected behavior:

- Fetch a server window, not all people.
- If a visible person leaves the filter or moves in sort order, refetch/rebalance the window.
- If an unseen person may now belong in the window, refetch/rebalance rather than appending
  approximately.

### Search / Picker Query

```ts
useQuery(
  figbird.q.people
    .where({ $search: searchTerm, status: { $in: ['active', 'newHire'] } })
    .limit(20)
    .related('currentJobRole'),
)
```

Expected behavior:

- Treat search as server-authoritative unless the backend exposes identical local matching and
  ranking semantics.
- Realtime events should invalidate/refetch the active search window.
- This is the replacement for broad `coreData.people` plus client-side filtering in autocomplete
  paths.

### Entity Label / Small Reference Fetch

```ts
useQuery(figbird.q.people.get(personId))
```

Expected behavior:

- Fetch a single missing entity for labels, avatars, pills, audit rows, or foreign-key display.
- Reuse cached entities when present.
- Update labels from realtime patches.
- This is a key ergonomic replacement for `peopleById[id]` from globally preloaded core data.

### Effective-Dated Current Row

```ts
useQuery(
  figbird.q.jobRoles
    .where({ personId, $asOf: today })
    .limit(1)
    .related('person')
    .related('manager'),
)
```

Expected behavior:

- Treat `$asOf`/current-row semantics as server-authoritative unless the service exposes a concrete
  local predicate such as `isCurrent: true`.
- Realtime changes to job-role history should refetch the effective row unless events include enough
  metadata to prove the new current row locally.

### Current Compensation

```ts
useQuery(figbird.q.compensations.where({ personId, $asOf: today }).related('compensationType'))
```

Expected behavior:

- Do not infer current compensation from incomplete local history.
- Use a server-authoritative query or a materialized `isCurrent`/`effectiveForDate` attribute.

### Document Centre Window

```ts
useQuery(
  figbird.q.documents
    .where({
      personId: { $ne: null },
      personStatus: { $in: ['active', 'newHire'] },
      $withVisibility: true,
      $search: search,
    })
    .orderBy('issueDate', 'desc')
    .orderBy('createdAt', 'desc')
    .limit(50)
    .related('person')
    .related('documentType'),
)
```

Expected behavior:

- Visibility, search, and virtual fields such as `personStatus` or `documentTypeName` are
  server-authoritative.
- Realtime events on documents, people, or document types should dirty/refetch the window when they
  can affect membership or ordering.
- Relation assembly should still use cached/fetched relation leaves after the authoritative window is
  resolved.

### Workflow Task Manager Graph

```ts
useQuery(
  figbird.q.workflowActions
    .where({ workflowId })
    .related('tasks', t => t.where({ workflowId }).orderBy('orderIndex', 'asc'))
    .related('email')
    .related('form')
    .related('conditions', c => c.orderBy('orderIndex', 'asc'))
    .related('slackMessage')
    .related('dependencies'),
)
```

Expected behavior:

- This is a bounded graph by `workflowId`; fetching all related rows for one workflow is acceptable.
- Figbird should own remote graph consistency.
- A separate optimistic/domain layer should own staged creates, anticipated child records, mutation
  queues, retries, and temporary/virtual ids.

### Time Away Periods

```ts
useQuery(figbird.q.timeAwayPeriods.where({ personId, date, timeAwayTypeId: 'all' }).server())
```

Expected behavior:

- This is an explicit server-authoritative projection shape.
- The backend should emit realtime events on the `timeAwayPeriods` service when upstream inputs such
  as time away, adjustments, allocations, or working patterns change.
- Figbird should refetch active server-maintained queries from their own service events instead of
  requiring ad hoc `useRealtimeEffect(..., refetch)` calls.

Implementation note:

- `.server()` is the query-builder escape hatch for server-maintained projections, virtual fields,
  search, effective-dated views, and other server-only semantics.
- Events from the queried service do not try to merge the query locally. They mark the query
  server-maintained and trigger a refetch while preserving the existing cached result during the
  background fetch.

### Org Model As-Of View

```ts
useQuery(
  figbird.q.orgUnitAssignments
    .where({ personId, asOf: today })
    .related('orgUnit')
    .related('orgUnitType')
    .related('fieldValues', fv => fv.where({ asOf: today })),
)
```

Expected behavior:

- Fetch assignment rows on demand rather than preloading all org-model data.
- If assignment changes, fetch the new unit/type/field values.
- If field history changes, refetch affected as-of field values unless current value is materialized.

### Spreadsheet Projection

```ts
useQuery(figbird.q.spreadsheetActions.get(spreadsheetTabId))
```

Expected behavior:

- Keep spreadsheet entity data as a service/view projection.
- Figbird should cache it and refetch when the projection service emits realtime events.
- Domain-specific incremental patching may be layered on top, but the generic relational query engine
  should not try to rediscover the projection from arbitrary client joins.

### Custom Values For Visible Fields

```ts
useQuery(
  figbird.q.customValues
    .where({ personId, customFieldId: { $in: visibleCustomFieldIds } })
    .related('customField'),
)
```

Expected behavior:

- Fetch scoped custom values, not all custom values.
- If custom field definitions change visibility or section, refetch or dirty the relevant query.

### Manager Chain

```ts
useQuery(
  figbird.q.people
    .get(personId)
    .related('manager', manager =>
      manager.related('manager', manager => manager.related('manager')),
    ),
)
```

Expected behavior:

- Fixed-depth chains conceptually fit Figbird if expressed as nested relations.
- General recursive traversal should probably be modeled as a server view or a future explicit
  recursive relation feature.

### Role Preview

```ts
useQuery(
  figbird.q.roles.related('permissions').related('members', m => m.limit(5).related('person')),
)
```

Expected behavior:

- Fetch roles and a bounded member preview without preloading all people.
- Membership preview is a server window; changes should refetch the preview relation.

### Home Tasks

```ts
useQuery(
  figbird.q.tasks
    .where({ status: 'active', includeTeamTasks: 'all' })
    .orderBy('dueDate', 'asc')
    .limit(25),
)
```

Expected behavior:

- Treat `includeTeamTasks` as server-authoritative scope logic.
- Realtime task events should invalidate/refetch the active window.

### Notifications / Activity Feed

```ts
useQuery(
  figbird.q.notifications
    .where({ recipientId: userId, readAt: null })
    .orderBy('createdAt', 'desc')
    .limit(30)
    .related('actor')
    .related('subject'),
)
```

Expected behavior:

- Feed windows are server-windowed.
- Mark-as-read removes visible rows and requires server refill for the next unread item.
- Actor/subject labels should be lazy relation leaves, not global preloads.

### Audit Log / Event Feed

```ts
useQuery(
  figbird.q.auditEvents
    .where({ resourceType, resourceId })
    .orderBy('createdAt', 'desc')
    .limit(50)
    .related('actor'),
)
```

Expected behavior:

- Append-only feeds can often merge new top events locally when the sort is monotonic and the event is
  known to belong at the top.
- General sorted windows still need cursor/window semantics and server reconciliation.

### Calendar Range

```ts
useQuery(
  figbird.q.calendarEvents
    .where({ personId, startsBefore: rangeEnd, endsAfter: rangeStart })
    .related('timeAway')
    .related('publicHoliday'),
)
```

Expected behavior:

- Range overlap predicates should be server-authoritative unless represented with explicit local
  fields and matcher semantics.
- Range changes are dynamic query inputs. Use transitions or deferred values when preserving the
  prior range/result pair is better than showing the destination loading state.

### Feature Flags / Configuration

```ts
useQuery(figbird.q.features.where({ enabled: true }))
```

Expected behavior:

- Small app-wide configuration can stay globally fetched.
- Large or user-specific configuration should be scoped and queried on demand.

## Reconciliation Scheduling

Server-window and server-authoritative queries stay correct by refetching when realtime events
indicate their result may have changed. It is worth naming what that refetch _is_: a
**reconciliation**, not a freshness requirement. Correctness demands that a query reconciles with
the server _eventually_ after the last relevant event — nothing requires it to happen within
milliseconds of each one. This reframing is what makes the refetch model safe to run on a busy
screen without turning into a refetch storm.

Two structural facts keep the steady state quiet:

- Reconciliation is event-driven, never polled. When nothing changes on the backend, there is
  zero background traffic.
- The refetch multiplier is the number of _subscribed server-window queries_, not the number of
  queries. Most of a typical screen — reference data, small local-exact sets, `.all()`-materialized
  services, embed-backed relations — merges realtime events locally and never refetches. Features
  that convert queries into the local-exact class (`.all()`, embed) attack the multiplier directly.

The remaining risk is **burst amplification**: a bulk import or workflow fan-out emits hundreds of
events, and every affected server-window query on every connected client refetches — producing
E events × Q window-queries × C clients of near-identical finds arriving at the server in
synchronized waves.

### The engine owns the cadence, not the query

Writing queries must stay seamless. The query expresses _shape_; the engine owns _when_ to
reconcile. There is no per-query throttle option, no `staleTime`, no reconciliation config on the
builder. All of the following are built-in default behaviors of a single global reconciliation
scheduler inside Figbird:

- **Cooldown with a trailing edge** _(shipped, July 2026)_. A query reconciles at most once per
  short interval (`reconcileCooldown`, default 2s, constructor-level; `0` disables). The first
  event in a window refetches immediately — the leading edge keeps isolated changes as fast as
  ever — and events arriving during the cooldown coalesce into one guaranteed trailing refetch,
  the correctness guarantee. A 500-event burst costs each affected query roughly two refetches
  instead of fifty, and still lands on the right answer. Implemented as a single gate
  (`#requestReconcile`) that all three event-driven refetch paths route through: server-maintained
  followups, `realtime: 'refetch'` queries, and the reconnect sweep. Manual `refetch()`, first
  fetches, and SWR revalidation are intent, not reconciliation, and bypass it.
- **Visibility gating** _(shipped, July 2026)_. A hidden tab does not reconcile at all: its
  queries are marked pending (visible in `inspect()`) and reconcile once on `visibilitychange`.
  This extends the existing "no listeners → mark pending, reconcile on next subscribe" behavior
  to "listeners nobody can see." Reconnects while hidden defer the refetch-all sweep the same
  way; local-exact merges keep flowing while hidden — only network reconciliation pauses. The
  visibility source is injectable (`visibility` constructor option) for tests and non-browser
  environments. For an app kept open in a background tab all day, this is a larger traffic
  reduction than any throttle.
- **Deduped, concurrency-capped queue** _(deferred until telemetry demands it)_. Reconciliations
  drain through one global queue, deduped by query id, with a small parallelism cap — clients
  pull at a controlled, leisurely pace rather than all at once.
- **Jitter** _(deferred until telemetry demands it)_. The same burst hits every connected client.
  Randomizing refetch timing client-side breaks the thundering herd against the backend.
- **Priority** _(deferred until telemetry demands it)_. Visible, actively-subscribed queries
  reconcile first.

Instance-level tuning (constructor options on the Figbird instance) may exist for the interval and
concurrency values, but the defaults should be good enough that no consumer ever sets them. Query
call sites never carry scheduling options.

The current engine already provides the primitives this builds on: events batch in a short window,
server-maintained queries dedupe to one refetch per batch, an in-flight fetch absorbs further
refetch requests into a single dirty-flag re-run, and listener-less queries defer reconciliation to
their next subscription.

### Measure before tuning

The observability emitter (`fetch:start` / `fetch:end`) is the input for choosing intervals:
refetches per query per minute, surfaced in devtools, from a production-shaped session. The
expected finding is that steady state is near-zero and only imports and workflow fan-outs spike —
i.e. tune for burst absorption, not sustained rate.

### Deferred: window-boundary pruning

A tempting optimization is proving locally that an event cannot affect a window (e.g. a created
row whose sort key falls outside a desc-sorted window's visible range) and skipping the refetch.
This is real leverage for feed-shaped queries — and exactly the category of cleverness where a
subtle boundary bug produces silently-wrong membership, the failure mode this architecture is
built to avoid. Throttled-but-dumb reconciliation ships first; pruning is added only if measured
numbers show a specific query shape needs it.

## Considered And Rejected

Decisions worth recording so they are not relitigated without new information:

- **Softening re-suspend-on-param-change (`keepPreviousData`)** — rejected; it reintroduces the
  exact query-identity lie the Exact Query Reads section exists to prevent. Transitions plus the
  no-flash kit are the supported answer.
- **Schema-level optimistic config** — rejected; optimism is surface-level intent, and the same
  service legitimately serves both modes on different screens.
- **Per-invocation mutation state in `useMutation`** — first deferred to a caller-side wrapper
  pattern, then reversed (July 2026): the wrapper every consumer would hand-roll became
  `useAction`, and the split write-side story (`mutations` + `useAction` + `useMutating`) replaced
  the hook — see "The Write-Side Split". Keyed status _inside_ `useMutation` stays rejected:
  stringly identity split across two call sites.
- **`.one()` as a cardinality modifier** — removed (July 2026), resolving the
  `.limit(1)` / `.one()` / `.get()` trio down to two spellings mapped one-to-one onto transport:
  `.get(id)` is the resource-verb fetch (`GET /:service/:id`, with `.where()` chainable after it
  as `params.query`), and `.where(...).limit(1)` is find-one. The earlier framing here —
  "null-on-miss vs error-on-miss is a pair worth two spellings" — was the wrong axis: miss
  behavior is downstream of the verb, and both remain expressible (`get` errors on a cold miss
  and nulls on realtime removal; `limit(1)` yields an empty array). The extraction alternative
  (`.where({ id }).one()` compiling to the get verb) was rejected: the pk key is not statically
  knowable (`idField` may be a function), mixed where-keys are ambiguous, and invalid shapes
  could only fail at runtime — uniform syntax hiding nonuniform semantics. Bonus: `one` now
  means exactly one thing in the library (relationship cardinality).
- **A separately-named non-Suspense hook** — rejected in favor of `{ suspense: false }`; see "Why
  There Is No Second Hook".
- **`priority` on the core `PreparedQuery`** — rejected; router vocabulary the library never reads.
- **Temp-id swap for id-less optimistic creates** — implemented briefly (July 2026), removed the
  same day in favor of the id contract. The mechanism (cache-only temp id, swapped for the real
  item on ack) faked identity for the create-to-ack gap, and the fakery leaked at every identity
  seam: React keys remounted on swap, the realtime echo could duplicate the temp item (no shared
  key — an unfixable race we had to document), and referencing the id before the ack needed a
  documented scope guard. Machinery that ships with warning labels about itself is machinery
  fighting the data model; requiring client ids makes both failure modes unexpressible instead of
  documented.

## Future Ideas

Unimplemented but considered worth keeping on the table. Nothing in the current design depends on
these; each would be additive.

### Typed Relational Filter Paths

Dotted relational filters (`'creator.teamId'`) are admitted but stringly-typed. Template-literal
types over the relation graph could autocomplete and check them to a bounded depth. Real
type-level cost for real delight; parked until the surface below it stops moving.

### Multi-Mutation Transactions

Real workflows often involve coordinated writes across services that should commit atomically:

- "Delete role + remove all roleMembers + revoke API tokens."
- "Approve time-away + create the corresponding `timeAwayPeriods` rows + bump balance."
- "Patch issue + add a comment + mark assignee as notified."

Today these are individual `useMutation` calls that the caller orchestrates serially. The
optimistic state of each step is independent; there is no "all of these succeed or none of them
apply" client contract, and rollback on partial failure is the caller's job.

A transaction primitive bundles multiple mutations into one logical commit:

```ts
await figbird.transaction(async tx => {
  tx.mutate({ serviceName: 'roles', method: 'remove', id: roleId })
  for (const m of members) {
    tx.mutate({ serviceName: 'roleMembers', method: 'remove', id: m.id })
  }
  tx.mutate({ serviceName: 'apiTokens', method: 'remove', id: tokenId })
})
```

Server contract:

The Humaans backend already exposes `api/batch` for atomic multi-service writes — the request
body is a list of operations and the server commits or rolls back the whole batch. The Figbird
adapter for Humaans should map `figbird.transaction()` to a single `api/batch` call. Other
adapters with similar primitives (a GraphQL mutation list against a transactional resolver, a
Postgres transaction endpoint, a custom `$tx` operator) can implement the same shape. Adapters
without a batch primitive can still expose `transaction()` as a sequential best-effort with
client-side rollback, but the all-or-nothing guarantee is weaker; document the difference.

Client semantics:

- **Optimistic together, rollback together.** All staged mutations apply optimistically at the
  same time. If the batch fails, all optimistic states roll back as one. Subscribers see the
  all-or-nothing transition rather than a partial intermediate state.
- **Per-mutation overrides preserved.** Individual mutations can still override `optimistic`
  behavior — a transaction containing one non-optimistic mutation just delays its optimistic
  siblings until the server confirms.
- **Read-your-write within a transaction.** Inside the `async tx => { ... }` callback,
  mutations apply to the local cache as they're staged so a follow-up read sees them. This is
  useful for transactions whose later steps depend on results of earlier ones.

Open questions:

- Does `tx.mutate` return a promise resolved when the batch commits, immediately with the
  optimistic placeholder, or both (a `.optimistic` and a `.committed` accessor)?
- Abort semantics if a step throws inside the callback before the batch fires. Easiest answer:
  any thrown error before commit drops the staged mutations and rolls back optimistic state.
- Concurrent transactions on overlapping services — serialize, allow, or fail loudly? Probably
  allow with last-write-wins on optimistic state, since the server will resolve the actual
  conflict.

### Derived Queries

Some screen-level queries are genuinely compositions of multiple server queries that the
backend cannot easily express as a single endpoint. The cases that survive even after relation
filters and `.all()` preloading:

- **Cross-service combinations with no shared join key.** "People whose Slack online-status is
  active and whose last activity event was within 5 minutes." Slack status, activity events,
  and people each live in different services with no shared FK.
- **Aggregates the server doesn't expose.** "People whose unfinished task count exceeds their
  team's median." No "team-median tasks" predicate exists server-side; it must be computed
  client-side from people-with-tasks and teams.
- **Conditional / branching queries based on user state.** "If I'm an admin, show all issues;
  otherwise show issues I assigned or that mention me." Pushing the auth check into every
  Feathers hook leaks user context into the server's query layer; keeping it client-side is
  cleaner for some products.
- **Stable named views worth caching by composition.** Even when expressible as a single
  query, a named composition can be useful for sharing across components and surfacing in
  devtools as one logical entity.

A speculative API:

```ts
const myTeamCriticalIssues = figbird.deriveQuery(
  'myTeamCriticalIssues',
  z.object({ currentUserId: z.number() }),
  ({ currentUserId }, { read }) => {
    const me = read(q.people.get(currentUserId))
    if (!me) return []
    const teammates = read(q.people.where({ teamId: me.teamId, status: 'active' }))
    const teammateIds = new Set(teammates.map(t => t.id))
    const issues = read(q.issues.where({ severity: 'critical', state: 'open' }))
    return issues.filter(i => teammateIds.has(i.assigneeId))
  },
)

// Component:
const { data } = useQuery(myTeamCriticalIssues, { currentUserId })
```

Properties:

- The derivation function uses `read()` to subscribe to upstream queries. Figbird tracks the
  dependency set and re-runs the derivation when any input's data ref changes.
- Multiple components reading the same `useQuery(myTeamCriticalIssues, args)` share one
  computation. Same cache-entry semantics as `defineQuery`.
- Suspends until all upstream queries have data. Same Suspense contract as plain queries.
- Error from any upstream propagates to the derivation's consumers.

Status: **speculative**. Most of what looks like "needs derivation" turns out to be "needs
better relation filters" once the dotted-path / `havingRelated` form ships. Derived queries
earn their keep specifically for cross-service composition, aggregate combinations, and
conditional branches that don't fit a single server query. Add when the relation-filter and
`.all()` features have shipped and a real, persistent need has surfaced.

### Cross-Service Snapshot Skew

An assembled relational tree joins query results that were fetched at slightly different times.
There is no transactional read across services: the root may reflect the database at T0 and a
relation at T1. This is not a Figbird defect — it is the condition of any client that composes
multiple requests, and only a log-ordered replica (Zero, Replicache) truly eliminates it, at the
cost of the whole replica machine. But it is worth stating precisely what Figbird guarantees,
what it does not, and what a future version could add.

What holds today:

- **Skew is self-healing and bounded.** Both sides of a join converge from the same realtime
  stream within roughly one event-batch interval plus fetch latency. A stale join does not persist
  until a manual refetch.
- **Stale, never corrupted.** Assembly is derivation — every reassembly recomputes from current
  caches. The tree can lag reality; it cannot contain duplicate rows, children under the wrong
  parent, or a half-applied join.
- **Gaps read as missing, never as wrong.** Events carry no cross-service ordering, so a reference
  can momentarily point at an entity the client hasn't seen. Missing leaves render as null/absent
  and trigger fetches; they are never substituted with wrong data. This is the invariant consumer
  code can rely on and tests should enforce.

Where skew is actually visible: server-side transactions spanning services. A backend transaction
creates a parent and its children atomically, but the events arrive as separate socket messages —
if they straddle two client batches, one frame shows the parent without children.

Near-term hardening (cheap, no protocol changes):

- Emit related events in the same tick server-side so they coalesce into one client batch.
- Make the event batch the atomicity unit for observers: apply all services' events from a batch
  before notifying any listener (today notification runs per service within the batch — React's
  render batching hides it, but intermediate snapshots are computed and non-React subscribers see
  them).

#### Candidate direction: version the stream, not the database

Because we control the backend, a future protocol revision could pin results and events to
positions in a log without building a replica. The elegant core: **the realtime feed becomes an
ordered log; responses carry the log position their data reflects; the client aligns the two.**
Incremental ladder, each rung independently valuable:

1. **Per-service monotonic sequence on events.** The client detects gaps (missed events) and
   reconciles only the affected services — replacing blind refetch-everything-on-reconnect and
   closing the "missed events with no replay protocol" limit. Cheapest rung, highest value; no
   read-path changes at all.
2. **Version-stamped read responses.** Reads report the same per-service version they reflect
   (read within the same DB transaction as the data). The client can then repair the
   stale-response race exactly: a refetch result older than already-applied events gets the
   buffered delta replayed on top (today only per-item `updatedAt` guards this; membership —
   e.g. a removed row resurrected by a stale find — is unguarded). Also gives read-your-writes:
   a mutation response's version tells the client when dependent queries have caught up.
3. **Transaction-grouped events.** Events tagged with their originating transaction, applied
   atomically as one client batch. Eliminates the parent-without-children frame — the sharpest
   visible tear.
4. **Alignment at assembly (full "replica-lite").** Buffer per-service deltas and roll
   local-exact results forward to a common version vector before joining. Only worth it if
   measured skew after rungs 1–3 still matters; this is the rung where Figbird starts becoming
   a sync engine. If this rung is ever genuinely needed, that is the moment to honestly evaluate
   adopting a real log-ordered sync engine (Zero) rather than rebuilding one inside Figbird.

Why rung 1 pays for itself regardless of the rest: gap detection closes the "realtime events
were missed and there is no replay/sequence protocol" entry in Fundamental Limits — the weakest
correctness point of the current design — and requires no read-path changes at all. Why rung 2
matters beyond tearing: it fixes a latent race the per-item `updatedAt` guard cannot — a refetch
response that lost a race with a newer realtime event can resurrect _membership_ (e.g. re-insert
a row an event already removed); value staleness is guarded today, membership staleness is not.

Design notes for whoever picks this up:

- **Commit order, not allocation order.** A naive global counter (`nextval` per write) is
  allocated before commit — transaction A can take seq 100, B take 101, and B commit first, so
  "I have everything ≤ 101" is false. The honest orderings are Postgres LSN via logical decoding,
  or a version read/written inside the same transaction as the data. This detail is where naive
  implementations silently break.
- Logical decoding (CDC) gives rungs 1 and 3 nearly for free — commit order, transaction
  boundaries, and replay-from-cursor on reconnect — but moves event emission out of Feathers
  hooks, which raises the two real costs: per-user permission filtering of a shared stream, and
  representation drift (WAL rows vs. hook-serialized API shapes; the entity cache must only ever
  contain the canonical API representation).
- If those CDC costs are too high, there is a no-new-infrastructure fallback: a transaction-scoped
  version counter written inside each mutating transaction and emitted through the existing
  Feathers event path. More plumbing per service, weaker replay (no cursor to resume from), but
  it reaches rungs 1–3 without touching the transport or the permission model.
- Per-service versions (a version vector) contend less than one global counter and match what
  joins actually need; a single global version is simpler to reason about. Decide once, early —
  the stamp format leaks into adapter contracts.

Status: **open**. The recommended first step is rungs 1–2: one sequence number on events, one
version header on responses — protocol additions an adapter can carry without touching the
architecture. Together they close missed-event detection, the stale-response membership race, and
read-your-writes, which is most of the practical distance between a request orchestrator and a
sync engine for a fraction of the machine. Nothing else in this document depends on this section.

### Count Queries

There is no way to ask "how many open issues?" without fetching rows — the only door to
`total` is `.paginate({ returnTotal: true })`, which drags a page of data along. Badges,
tab counters, and dashboard tiles all want a number, not a window.

```ts
const { data: count } = useQuery(q.issues.where({ status: 'open' }).count()) // number
```

Transport: `$limit: 0` plus the find meta's `total` — cheap for any Feathers-compatible
server. Builder-wise it is a new `kind` alongside `paginate`/`all` (the type-state
machinery already forbids nonsense chains like `.count().related(...)`). Realtime: a
count cannot generally be maintained locally (an event says membership changed, not by
how much the total moved), so the honest baseline classifies counts as refetch-on-event
riding the reconcile cooldown. The one refinement worth considering later: a local-exact
filter over a materialized service _can_ maintain its count exactly — same rule the
membership classification already encodes.

Status: **planned** — concrete, additive, no open questions beyond result-shape naming.

### Testing Utilities (`figbird/testing`)

The repository's own test harness contains exactly what every consuming app needs to test
components against figbird: an in-memory Feathers-compatible client with seeded per-service
data, a query-aware `find` (equality, `$in`, `$sort`, `$limit`/`$skip`), CRUD that emits
realtime events, `service.emit()` for simulating server-side changes, and per-method call
counters for asserting fetch behavior. Today it is private to `test/helpers.ts`, so every
consumer either mocks around figbird (testing their mocks) or rebuilds this.

Ship it as a subpath export:

```ts
import { mockFeathers } from 'figbird/testing'

const feathers = mockFeathers({ issues: { data: { 1: { id: 1, title: 'Ship it' } } } })
const figbird = new Figbird({ adapter: new FeathersAdapter(feathers), schema })
// render, then: feathers.service('issues').emit('patched', {...}) and assert
```

Constraints: no Node builtins in the published module (the internal mock leans on Node's
`EventEmitter`; the extracted version carries a ~10-line emitter) so it runs under any
bundler/test runner. The React-specific scaffolding (`createTestApp`, jsdom mounting)
stays in the repo — apps have their own rendering setup; the valuable part is the client.

Status: **planned** — extraction plus a docs recipe; the repo's own suite becomes the
first consumer.

### Devtools

The observability layer was built as three stable projections — `figbird.events` (batched
lifecycle facts with correlation ids), `figbird.inspect()` (live query table), and
`figbird.explain()` (static per-node classification with reasons) — precisely so a
devtools surface could be built without touching internals. The surface itself doesn't
exist yet.

The target experience is screen-centric: _I'm looking at a screen; show me everything it
queries._ One live table, one row per active query on the page:

- **Identity** — service, filters, relation tree (definition name when there is one).
- **Liveness** — classification per node (local-exact / server-window /
  server-authoritative) and what realtime does to it (merge / refetch / manual), i.e.
  "is this row self-maintaining or does it cost a roundtrip per event".
- **Traffic counters** — fetch count and total/last duration, realtime events received,
  events merged vs. refetches triggered, last reconcile time. A query refetching once per
  event when its siblings merge is the "why is this one expensive" answer at a glance.
- **Waterfall view** — fetch spans on a timeline. Relational queries make N+1 and
  chained-dependency shapes visible instantly: parents → fan-in IN(...) at depth 1 →
  nested fan-ins, versus the pathological per-parent windowed staircase the fan-out
  warning exists for. `prepare`/`prefetch` spans render on the same timeline, so "did the
  router actually warm this before the screen read it" is visible rather than inferred.
- **Write lane** — `mutate:*` rows correlated by `mutationId` with rollbacks highlighted,
  `action:*` rows in the app's own vocabulary above them.

Everything above is derivable from the three projections plus timestamps; the events
channel already carries durations, item counts, and correlation ids. Packaging question
(in-app drawer component à la the demo, versus a browser extension) is open — the drawer
is dramatically cheaper and works everywhere, and the demo already prototypes one.

Status: **wanted** — highest fun-to-effort ratio of the ideas here, but deliberately
sequenced after real dogfooding so the panel shows what its users actually reach for.
