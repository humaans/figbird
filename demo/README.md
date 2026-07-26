# figbird demo

A small but real product — a realtime issue tracker — where every panel is a live figbird
query. There are no feature tabs: search, relational filters, pagination, windowed
relations, optimistic mutations, preloaded reference data, and realtime updates all appear
as ordinary product behavior. The ⓘ buttons explain what figbird is doing behind each
piece of UI — including the actual query shape being used.

## Run

```bash
cd demo
npm install
npm run dev
```

That starts two processes:

- `server` on `http://localhost:5273` — Feathers + socket.io, in-memory data (~90 issues),
  switchable latency profiles, and a simulated teammate that comments, reacts, nudges
  priorities, and closes issues every few seconds.
- `client` on `http://localhost:5173` — Vite + React 19 + figbird, configured to resolve
  `figbird` to the parent library's `lib/index.ts` (so HMR picks up library edits).

Tip: open the client in **two windows side by side** — every change in one appears in the
other, live.

## Reading the code

If you're here to learn figbird, read in this order — each file teaches one idea:

1. **`src/figbird.ts`** — the whole setup: domain types, the schema with all three
   relationship kinds (`one`, `many` incl. a two-hop junction, `embed`), the adapter and
   instance, the `createHooks` kit every component imports from, and `.all()` preloads
   for the reference services (users, teams, labels).
2. **`src/App.tsx`** — layout and routing: keyed Suspense boundaries per issue,
   `DelayedFallback`, and the route that fires data preparation in parallel with its lazy
   chunk.
3. **`src/components/IssueList.tsx`** — the paginated live list (`.paginate()`), server-authoritative
   search (`$regex`), relational filter chips (`'assignee.teamId'`), transitions via
   `useDebouncedTransition`, and one-line hover prefetch.
4. **`src/pages/IssueDetail/`** — the route-prepared screen, one lesson per file:
   - `queries.ts` — `defineQuery` definitions shared by router, hover, and screen
   - `prepare.ts` — route preparation (and where router `priority` gets attached)
   - `screen.tsx` — the `.get(id)` relational graph + the write-side story: one `useAction`
     per toolbar button, `useMutating` for the entity-wide disable
   - `Editable.tsx` — inline optimistic patch-and-rollback editing via `useAction`
   - `Comments.tsx` — the local-exact realtime thread (unwindowed on purpose)
5. **`src/pages/Teams/screen.tsx`** — windowed relations vs `embed()`, side by side on
   one card.
6. **`src/components/ActivityPanel.tsx`** — three independent realtime queries merged in the
   component.
7. **`src/components/NewIssueModal.tsx`** — optimistic create with a client-generated id.
8. **`src/components/DevTools.tsx`** — built entirely on public observability: `figbird.events` for
   the log, `figbird.inspect()` for the query table.

Structure rule: `src/` root is wiring (`main`, `figbird`, `demoControl`, `App`);
`src/components/` is the shell UI the workspace composes; `src/pages/` is routed screens.
`src/demoControl.ts` and `server.mjs` are demo plumbing, not figbird usage — skip them
unless you're curious how the simulation works.

## The dev-tools drawer

Bottom-right corner:

- **Latency** — fast (default) / realistic / slow, applied server-side. Fast shows off
  warm-cache navigation and optimistic writes; drag to slow and watch delayed spinners
  and SWR revalidation degrade gracefully instead of blocking the UI.
- **Teammate** — toggles the background traffic (on by default).
- **Fail next mutation** — arms a one-shot server failure: your next action (comment,
  boost, title edit…) fails and figbird rolls the optimistic change back everywhere at
  once, with the `mutate → rollback` sequence visible in the log.
- **Drop socket** — kills the transport; socket.io auto-reconnects and figbird refetches
  every active query (and the materialized reference sets) to reconcile anything missed.
- **log** — every fetch, realtime event, and mutation flowing through `figbird.events`,
  with durations.
- **queries** — `figbird.inspect()`: every live query with figbird's classification of
  how it is maintained (`local-exact` merges events, `server-window` refetches the
  window, `server-authoritative` always refetches, `get`), plus subscriber counts.

## Where each feature lives

- **Preloaded reference data** — users, teams, and labels are `.all()`-preloaded at the
  shell (`src/figbird.ts`), so team chips, assignee lookups, and label relations are
  answered locally from the materialized cache with zero roundtrips — check the queries
  tab: they're all `local-exact`.
- **Paginated live list** — one `.paginate({ pageSize: 25, returnTotal: true })` query
  ordered by recency. Comment counts come from `issue.commentIds`, a server-maintained id
  list — no comments are fetched for the list at all (the `embed` pattern).
- **Server-authoritative search** — the search box sends `title.$regex`, which the local
  matcher can't evaluate, so the query classifies server-authoritative automatically (no
  `.server()` needed) and reconciles by refetch. Typing commits through a transition,
  keeping previous results visible.
- **Relational filters** — the team chips filter by `'assignee.teamId'`, a field on the
  _related_ user. The server resolves the dotted path with a join; the client matcher
  evaluates it against the entity cache for realtime freshness.
- **Windowed relations vs embed** — each team card shows both strategies for "top N per
  parent". "Recent" is `.related('recentIssues', i => i.orderBy(…).limit(5))` — one small
  per-team query. "Spotlight" is `embed()`: the server maintains
  `team.spotlightIssueIds`, re-emits the team when it changes, and figbird resolves every
  team's spotlight in one batched IN(...) fetch, preserving the server-chosen order.
- **Cross-service activity** — the Activity panel merges three independent realtime
  queries (comments, reactions, issues) by timestamp in the component.
- **Optimistic mutations, by default** — writes go through the `m` proxy
  (`m.issues.patch(id, data)`), the write-side counterpart of `q`: no hooks, no flags,
  no handle setup. The cache updates in the same frame, rollback on failure (arm chaos in
  dev tools to see it); surfaces that must wait for the server ack use
  `m.<service>.confirmed`.
- **The id contract** — optimistic creates carry a client-generated id (the demo mints
  numeric ones; real apps use `crypto.randomUUID()`): identity is real from the first
  frame, so React keys are stable, the realtime echo dedupes by id, and the New Issue
  modal can navigate to `/issues/<id>` before the ack. Servers that assign ids pair with
  `confirmed` creates — await the create for the server's identity.
- **Per-action state, per-entity busy** — every issue-detail toolbar button is its own
  named `useAction` (own pending label, own error — no shared status slot, no hand-rolled
  state machine; the names label `action:*` events so the dev-tools log reads "boost ok ·
  340ms"), while the toolbar-wide disable is `useMutating({ service: 'issues', id })`,
  backed by figbird's synchronous mutation tracker: it sees writes to that issue from any
  surface, even components that mounted mid-mutation.
- **Transparent junction relations** — labels resolve through
  `many(issues → issueLabels, issueLabels → labels)`, so consumers just say
  `.related('labels')` and get `Label[]`; creating a junction row updates the assembled
  result via realtime.
- **Route queries + hover prefetch** — `/issues/:id` declares its data once with `queries`.
  The router runs those definitions through Figbird's `prepare` during navigation and
  `prefetch` on issue-row hover, while loading the lazy screen chunk in parallel (navigation
  latency = `max(chunk, data)`). The keyed Suspense boundary gives each issue its own cold
  skeleton, and warm revisits render synchronously from cache.

## Data shape

Seven services wired up relationally:

```
issues ── creator      → users ── team → teams
       ├─ assignee     → users
       ├─ team         → teams
       ├─ labels       → issueLabels ── label → labels   (two-hop junction)
       └─ comments     → comments
                           ├─ author    → users
                           └─ reactions → reactions
teams  ── members      → users
       ├─ spotlight    → issues   (embed: server-maintained id list)
       └─ recentIssues → issues   (windowed, per-team)
```
