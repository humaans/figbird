# Figbird Devtools — Implementation Spec

A self-contained spec for building `figbird/devtools`: an in-app devtools drawer for
figbird, the realtime relational data layer in this repository. Written for an
implementer with no prior context on this codebase.

## What figbird is (60 seconds)

Figbird fetches **entity graphs** (records + their relations) and keeps them live via
realtime events. Reads go through `useQuery(q.issues.where(...).related('comments'))`;
writes through the `m` proxy (`m.issues.patch(id, data)`, optimistic by default) and
`useAction`. Every query node is **classified** — `local-exact` (realtime events merge
locally), `server-window` (windowed; events trigger a refetch), `server-authoritative`
(server-only semantics; events trigger a refetch) — and event-driven refetches pass
through a reconcile gate (cooldown + hidden-tab deferral). A relational query fans out
into multiple store-level descriptor queries: one root plus one per relation node
(`IN (...)` batches), interned and shared across components.

The library was built with devtools in mind: three stable projections exist precisely
so this tool can be built without touching internals. Read `DESIGN.md` → "Devtools"
for the product vision; this spec turns it into work.

## Product vision

**Screen-centric: "I'm looking at a screen — show me everything it queries."** One
live table, one row per active query, answering at a glance:

- what is queried (service, filters, relation tree, definition name where known)
- how each query is maintained (classification; merge vs refetch vs frozen)
- what it costs (fetch count, last/total duration, realtime events received, merges
  vs refetches triggered, last reconcile)
- how the screen loaded (fetch waterfall — parents → fan-in → nested; N+1 staircases
  visible instantly; did `prepare`/`prefetch` warm things before the screen read them)
- what's writing (mutations correlated by id, rollbacks highlighted, `action:*` rows
  in the app's vocabulary)

## Foundations — the contracts you build on (already shipped)

All in `lib/`. These are stable projections; do not read internal store shapes.

### 1. `figbird.events` — lifecycle event stream

`lib/core/events.ts`. `figbird.events.subscribe(listener): unsubscribe`. Delivery is
**batched on a microtask** and never happens mid-render, so subscribing from React is
safe. The emitter early-returns when it has zero listeners — an unopened devtools
costs nothing, and an attached one costs one array push per event.

The `FigbirdEvent` union (see the file for the authoritative shape):

| kind                          | fields                                                                  |
| ----------------------------- | ----------------------------------------------------------------------- |
| `fetch:start`                 | `serviceName, method('find'\|'get'), queryId, resourceId?, params?`     |
| `fetch:end`                   | `serviceName, method, queryId, durationMs, itemCount`                   |
| `fetch:error`                 | `serviceName, method, queryId, durationMs, error`                       |
| `realtime`                    | `serviceName, type('created'\|'updated'\|'patched'\|'removed'), itemId` |
| `mutate:start`                | `mutationId, serviceName, method(CRUD or custom name), id?, optimistic` |
| `mutate:end`                  | `mutate:start` fields + `durationMs`                                    |
| `mutate:error`                | `mutate:end` fields + `error`                                           |
| `mutate:rollback`             | `mutationId, serviceName, method, id?`                                  |
| `action:start`                | `actionId, name?` (from `useAction(name, fn)`)                          |
| `action:end` / `action:error` | + `durationMs` (+ `error`)                                              |

Notes:

- Events carry **no timestamps**. Stamp them in the collector at delivery time
  (`performance.now()`); microtask deferral makes this accurate to ~a tick, which is
  fine for a waterfall. Durations are measured in core and exact.
- `mutationId` correlates one mutation's start/end/error/rollback; `actionId`
  likewise for actions. There is **no** built-in correlation from an action to the
  mutations it performed — time-window nesting (mutations started between an
  action's start/end) is an acceptable heuristic for the Writes lane.

### 2. `figbird.inspect()` — live query table

`lib/core/figbird.ts` → `InspectedQuery[]`:

```ts
{
  queryId: string
  serviceName: string
  method: 'find' | 'get'
  query: Record<string, unknown> | undefined
  classification: 'local-exact' | 'server-window' | 'server-authoritative' | 'get'
  status: 'loading' | 'success' | 'error'
  isFetching: boolean
  itemCount: number
  fetchedAt: number | undefined // epoch ms of last successful fetch
  subscriberCount: number // > 0 ⇒ actively on screen
}
```

This is the **current state** snapshot; the events stream is the history. The Queries
tab is a join of both, keyed by `queryId`. "On this screen" = `subscriberCount > 0`
(store-level queries backing relational refs hold subscriptions while any component
is mounted on them).

### 3. `figbird.explain(builderOrDefinition, args?)` — why a query behaves as it does

Static per-node classification report: `{ nodes: [{ path ('(root)' or dotted
relation path), service, kind, class, reasons: [{ code, detail }], realtime
('merge'|'refetch'|'manual'), via? }] }`. Use it for the row-expansion "why" panel
when the devtools has access to the original builder/definition (see Gap G2 —
`inspect()` rows alone don't carry the builder).

### 4. `figbird.mutating` — synchronous in-flight mutation tracker

`subscribe`/`getSnapshot` shaped for `useSyncExternalStore`; snapshot lists in-flight
mutations `{ mutationId, serviceName, method, id? }`. Use for the "N writes in
flight" live badge.

## Gaps — small core instrumentation to add (each is a contained PR)

The Phase-1 panel works on the foundations alone. These unlock the rest; add them in
core with tests, following the existing event patterns in `lib/core/events.ts` and
emit sites in `lib/core/queryStore.ts` / `lib/core/figbird.ts`.

**G1. Reconcile visibility.** Emit an event when the reconcile gate actually starts
a refetch:

```ts
{
  kind: 'reconcile:started'
  queryId: string
  serviceName: string
}
```

This powers the "events received vs refetches triggered" counters without exposing
the reconcile gate's internal scheduling.

**G2. Relational grouping.** `inspect()` lists flat store-level queries; the devtools
wants them grouped under the relational query that owns them ("issues + creator +
comments.author" as one expandable row). Add a registry on the Figbird instance:
`figbird.inspectRelational(): Array<{ key: string /* rq/hash */, name?: string,
service: string, ast: QueryAST, nodes: Array<{ path: string, queryId: string }> }>`.
The relational ref already knows its AST (`RelationalQueryRef.details()` in
`lib/core/relationalQuery.ts`) and creates each node's store query — record the
`path → queryId` mapping when relation subs are created (`#syncRelations` family),
expose it, and drop entries on ref eviction. This also gives the "why" panel the AST
to feed `figbird.explain()` without needing the original builder. Definition names:
`defineQuery(name, ...)` names are carried on definitions but not on refs today —
thread `name` through `figbird.query(definition, args)` onto the ref as display
metadata (nullable; never identity).

**G4. (Optional, later) event→query attribution.** The `realtime` event doesn't say
which queries it touched. Approximation for Phase 1: attribute realtime events to
queries by `serviceName` and infer merge/refetch from each query's classification
(merges for `local-exact`, reconciles otherwise — G1 gives the actual refetches).
Exact per-query merge counts need a core event; defer until the approximation proves
insufficient.

## Package and architecture

**Packaging:** `figbird/devtools` subpath export, same pattern as `figbird/testing`
(`lib/devtools.ts`, resolved by the package's `./*` wildcard export). React is
already a peer dependency of the repo; the drawer imports from `'react'` only. No
other dependencies, no CSS files — inline styles (the drawer must not require a
bundler CSS pipeline). Everything ships tree-shakeable: apps that never import
`figbird/devtools` carry zero bytes of it.

**Two layers:**

```
lib/devtools/collector.ts   — framework-agnostic; subscribes to figbird.events,
                              snapshots inspect(), accumulates per-query records
lib/devtools/Devtools.tsx   — <FigbirdDevtools figbird={figbird} /> drawer, renders
                              collector state via useSyncExternalStore
lib/devtools.ts             — public entrypoint for the React devtools component
```

### Collector

```ts
interface Collector {
  start(): void // subscribe to events (idempotent)
  stop(): void // unsubscribe, keep accumulated state
  subscribe(fn: () => void): () => void // change notification (throttled, see below)
  getSnapshot(): DevtoolsSnapshot // stable reference until data changes
}
```

- **History starts when the devtools are enabled.** Opening and closing the drawer
  does not interrupt collection.
- **Ring buffers:** raw event log capped at 500 entries, per-query span history at
  50; per-query counters are plain numbers and never truncate.
- **Change notification throttling:** coalesce notifications to at most one per
  animation frame (fall back to 50ms timeout outside browsers). Never notify
  synchronously from the event listener.
- **Snapshot immutability:** `getSnapshot()` returns the same object until data
  changed (required by `useSyncExternalStore`).

### Accumulated data model

```ts
interface QueryRecord {
  queryId: string
  // live fields refreshed from inspect() on each change batch:
  serviceName: string
  method: 'find' | 'get'
  query: Record<string, unknown> | undefined
  classification: string
  status: string
  isFetching: boolean
  itemCount: number
  fetchedAt?: number
  subscriberCount: number
  // accumulated from events:
  fetchCount: number
  errorCount: number
  lastDurationMs?: number
  totalDurationMs: number
  spans: Array<{ startAt: number; endAt?: number; ok?: boolean }> // ring buffer
  realtimeSeen: number // service-level events while this query was live
  reconciles: number // from G1 (0 until G1 lands)
  lastError?: { message: string; at: number }
}

interface DevtoolsSnapshot {
  queries: QueryRecord[] // active first (subscriberCount desc), then by service
  relational: RelationalGroup[] // from G2 ([] until it lands)
  events: FigbirdEventWithTimestamp[] // ring buffer, newest last
  writes: WriteRecord[] // mutations grouped by mutationId, actions by actionId
  inFlightWrites: number // from figbird.mutating
}
```

Refresh `inspect()` lazily: once per notification batch (it's a cheap projection but
don't call it per event).

## UI spec — the drawer

A fixed-position bottom drawer (toggle button bottom-right; opens to 40vh, draggable
height, remembers height in `localStorage` under `figbird:devtools`). Dark theme,
system font stack, 12px base. Keyboard: `Esc` closes. The drawer renders nothing but
the toggle button until opened (and only starts its own collector on first open).

Four tabs:

### Tab 1 — Queries (the screen-centric default)

Table, one row per query (or per relational group once G2 lands, expandable to its
node rows). Columns:

| column   | content                                                                                    |
| -------- | ------------------------------------------------------------------------------------------ |
| service  | `serviceName` + method badge (`find`/`get`)                                                |
| query    | compact one-line JSON of filters, ellipsized, full on hover/expand                         |
| class    | badge: `local-exact` green, `server-window` amber, `server-authoritative` red, `get` grey  |
| live     | ● when `subscriberCount > 0`, with the count; frozen (snapshot) queries show ❄             |
| status   | `status` + spinner when `isFetching`                                                       |
| rows     | `itemCount`                                                                                |
| fetches  | `fetchCount`, red suffix `(+N err)` when `errorCount > 0`                                  |
| last     | `lastDurationMs` ms; tooltip: total + average                                              |
| realtime | `realtimeSeen` events; after G1 also `reconciles` ("events → refetches" is the cost story) |
| age      | `now - fetchedAt`, live-updating coarse ("3s", "2m")                                       |

Row expansion: full query JSON, per-node classification with `reasons` (via
`explain()` on the AST once G2 lands), span history sparkline, last error.

Filters above the table: text filter on service/query; toggle "active only"
(default **on** — that's the screen-centric view); toggle "include cached".

### Tab 2 — Timeline (waterfall)

Horizontal time axis, one lane per query (grouped under relational parents once G2
lands; until then grouped by service). Each fetch span is a bar (`startAt→endAt`),
green ok / red error. Realtime events draw as ticks on their service's lane.

Behaviors:

- window: last 30s by default; pause button freezes the view; zoom via wheel.
- clicking a span selects the query in Tab 1.

### Tab 3 — Events

The raw ring buffer, newest at bottom, auto-scroll with pause-on-hover. One line per
event: relative timestamp, kind badge, compact fields. Text filter + kind checkboxes.
This tab is the escape hatch when the aggregations hide something.

### Tab 4 — Writes

Two correlated lists:

- **Actions** (from `action:*`): name (or `(anonymous)`), status, duration; expanding
  shows the mutations whose `mutate:start` fell inside the action's window.
- **Mutations** (grouped by `mutationId`): service.method, id, optimistic badge,
  duration, outcome — **rollbacks highlighted red** with the correlated error.
  Live badge in the tab header: `inFlightWrites` from `figbird.mutating`.

### Visual constraints

No component library, no icons packages (unicode glyphs fine), no CSS-in-JS dep —
plain `style` objects with a small shared palette. The whole drawer should be one
self-contained tree that cannot leak styles into the host app (no global CSS, no
element selectors). Bundle target: under ~15kB min+gzip excluding React.

## Correctness and performance rules

- Never call `figbird.getState()` — it's the debug-grade raw map; `inspect()` is the
  stable projection. Never poll on an interval; react to events, refresh `inspect()`
  per notification batch, plus one refresh on drawer open.
- The collector must be resilient to unknown event kinds (future core additions):
  log them into the Events tab generically, never throw.
- All listener work is O(1) appends; aggregation happens in `getSnapshot()`
  recomputation, memoized per notification batch.
- The drawer must not change app behavior: no store subscriptions to queries, no
  `refetch()` calls except an explicit per-row "refetch" button (which calls
  `figbird.refetch` / the row's ref — fine, it's user intent).
- StrictMode-safe: collector `start()` idempotent; drawer effects tolerate
  double-mount.

## Testing

Use `figbird/testing` (`mockFeathers`) — the collector is framework-agnostic, so most
coverage needs no React:

1. fetch lifecycle: query → collector records span, counts, durations; error path
   increments `errorCount` and stores `lastError`.
2. realtime attribution: emit service events; `realtimeSeen` increments for that
   service's queries only.
3. writes: optimistic mutation failure produces a rollback-marked WriteRecord;
   action window nests its mutations.
4. ring buffer caps hold; snapshot identity is stable across no-op notifications.
5. one React smoke test: drawer renders, tab switch works, no console errors.

Core instrumentation PRs (G1–G2) each carry their own event-emission tests following
the existing patterns in `test/` (see `test/reconcile.test.tsx` for reconcile-gate
test infrastructure and `test/helpers.ts` for the app factory).

## Milestones

1. **Collector + Queries tab** on existing foundations (no core changes). Ship
   behind `figbird/devtools`.
2. **Events + Writes tabs** (still no core changes).
3. **G1 core events**, then the **Timeline tab** with fetch spans and realtime ticks.
4. **G2 relational grouping**, expandable relational rows, explain-powered "why"
   panel.
5. Polish: height persistence, filters, keyboard, docs page (`docs/content/_index.md`
   gets a Devtools section under Observability), CHANGELOG entry.

Each milestone lands green through the full gate (`npm run test` = tsc + oxlint +
prettier + ava) and updates `DESIGN.md`'s Devtools status line.

## Out of scope (explicitly)

- Browser extension packaging (the drawer works everywhere including the demo app —
  wire it into `demo/` as the dogfood).
- Persisting history across reloads.
- Editing state from the panel (read-only except the explicit refetch button).
- Time-travel.
