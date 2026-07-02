# figbird demo

Self-contained app that exercises the new `useQuery` + Suspense API against a local Feathers server with simulated latency, relational data, and realtime event traffic.

## Run

```bash
cd demo
npm install
npm run dev
```

That starts two processes:

- `server` on `http://localhost:3030` — Feathers + socket.io, in-memory data, per-service random latency, and background tickers that create comments, create reactions, and patch issue priorities. This gives you real realtime events to observe without needing a second browser tab.
- `client` on `http://localhost:5173` — Vite + React 19 + figbird, configured to resolve `figbird` to the parent library's `lib/index.ts` (so HMR picks up library edits).

## What the demo shows

- **Suspense on first mount.** The issue list, hot queue, and detail graph mount inside `<Suspense>` boundaries. Refresh to watch delayed fallbacks, then the data.
- **Delayed spinners (`useDelayedFlag` / `DelayedFallback`).** No spinner flashes for fast loads. If a fallback or fetching indicator lasts long enough, it becomes visible.
- **Keep previous data on param change.** Clicking a different issue goes through `useDeferredQuery`; the previous detail pane stays visible while the new graph loads.
- **No re-suspend on refetch.** Hit the "Refetch" button — data stays rendered, the dot appears only if the refetch is slow.
- **Warm-cache revisit is instant.** Navigate from issue 1 → issue 2 → back to 1. The detail pane renders synchronously from cache, no fallback.
- **Realtime propagation through relational views.** Every 6 s a new comment arrives from the server. It appears automatically in the exact issue list and the detail pane. Reactions appear nested under comments the same way.
- **Multi-tab realtime fanout.** The demo server publishes all service events to an anonymous Socket.IO channel, so creates/patches/removes in one browser tab propagate to other connected tabs/windows.
- **Server-window reconciliation.** The "Server window" panel runs `where({ status: 'open' }).orderBy('priorityScore', 'desc').limit(3)`. Click "Promote hidden row" and Figbird refetches the window instead of doing an approximate append.
- **Foreign-key relation leaf changes.** "Reassign FK" and "Move team" patch relation keys. The detail graph fetches the new assignee/team leaf and updates the assembled object.
- **Many-to-many via join services.** "Add label join" creates an `issueLabels` row. Figbird expands through `issueLabels -> label` and updates the issue labels in-place.
- **Mutations.** The console and detail controls create, patch, and remove entities through `useMutation(...)`; active queries reconcile from the realtime events.

## Data shape

Seven services wired up relationally:

```
issues ── creator      → users
       ├─ assignee     → users
       ├─ team         → teams
       ├─ issueLabels  → issueLabels ── label → labels
       └─ comments     → comments
                           ├─ author    → users
                           └─ reactions → reactions
```

Check `src/figbird.ts` for the schema and `src/App.tsx` for the hook usage.
