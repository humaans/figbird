# figbird demo

A small but real product — a realtime issue tracker — where every panel is a live figbird
query. There are no feature tabs: search, relational filters, pagination, windowed
relations, optimistic mutations, and realtime updates all appear as ordinary product
behavior. The ⓘ buttons explain what figbird is doing behind each piece of UI.

## Run

```bash
cd demo
npm install
npm run dev
```

That starts two processes:

- `server` on `http://localhost:3030` — Feathers + socket.io, in-memory data (~90 issues),
  switchable latency profiles, and a simulated teammate that comments, reacts, nudges
  priorities, and closes issues every few seconds.
- `client` on `http://localhost:5173` — Vite + React 19 + figbird, configured to resolve
  `figbird` to the parent library's `lib/index.ts` (so HMR picks up library edits).

Tip: open the client in **two windows side by side** — every change in one appears in the
other, live.

## The dev-tools drawer

Bottom-right corner:

- **Latency** — fast (default) / realistic / slow, applied server-side. Fast shows off
  warm-cache navigation and optimistic writes; drag to slow and watch keep-previous-data,
  delayed spinners, and SWR revalidation degrade gracefully instead of blocking the UI.
- **Teammate** — toggles the background traffic (on by default).
- **log** — every fetch, realtime event, and mutation flowing through figbird's
  observability events, with durations.
- **queries** — every live query in the store with figbird's own classification of how it
  is maintained: `local-exact` (realtime events merge locally), `server-window` (windowed;
  events refetch the window), `server-authoritative` (server-only semantics; events
  refetch), `get`.

## Where each feature lives

- **Paginated live list** — the issue list is one `.paginate({ pageSize: 25 })` query with
  `returnTotal`, ordered by recency. Comment counts come from `issue.commentIds`, a
  server-maintained id list — no comments are fetched for the list at all (the "embed"
  pattern).
- **Server-authoritative search** — the search box sends `title.$regex`, which the local
  matcher can't evaluate, so the query classifies server-authoritative and reconciles by
  refetch. Typing commits through `startTransition`, keeping previous results visible.
- **Relational filters** — the team chips filter by `'assignee.teamId'`, a field on the
  _related_ user. The server resolves the dotted path with a join; the client matcher
  evaluates it against the entity cache for realtime freshness.
- **Windowed relations** — the Teams panel asks for each team's 3 most recent issues via
  `.related('recentIssues', i => i.orderBy(…).limit(3))` — one small per-parent query per
  team.
- **Cross-service activity** — the Activity panel merges three independent realtime
  queries (comments, reactions, issues) by timestamp in the component.
- **Optimistic mutations** — the console's create/remove and every action in the issue
  detail pass `optimistic: true`: cache updates in the same frame, rollback on failure.
- **Route-prepared Suspense detail** — `/issues/:id` fires `figbird.prepare()` in parallel
  with the lazy screen chunk; the keyed Suspense boundary gives each issue its own cold
  skeleton, and warm revisits render synchronously from cache.

## Data shape

Seven services wired up relationally:

```
issues ── creator      → users ── team → teams
       ├─ assignee     → users
       ├─ team         → teams
       ├─ issueLabels  → issueLabels ── label → labels
       └─ comments     → comments
                           ├─ author    → users
                           └─ reactions → reactions
teams  ── recentIssues → issues
```

Check `src/figbird.ts` for the schema, `src/App.tsx` for the workspace, and
`src/pages/IssueDetail/` for the route-prepared detail screen.
