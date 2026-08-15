# Figbird Devtools

Figbird devtools ship as Chrome and Firefox DevTools extensions. Applications do not
import `figbird/devtools`, render a drawer, or manage a stored enable/disable preference.

## Runtime contract

Constructing a Figbird instance registers a weak reference with a non-enumerable page
bridge at `globalThis.__FIGBIRD_DEVTOOLS__`. Registration does not subscribe to events,
inspect queries, or retain history.

The extension evaluates the bridge in the inspected page and calls `connect()`. A
connection:

- selects the newest live Figbird instance;
- subscribes to `figbird.events`;
- exposes current `inspect()`, `inspectRelational()`, and `mutating` snapshots;
- buffers at most 1,000 events between panel polls; and
- expires after five seconds without a poll, removing every event subscription.

The bridge serializes values before they cross the browser DevTools evaluation boundary.
Errors retain their name and message, bigint values become strings, and circular values
are marked instead of breaking the panel.

## Connection diagnostics

Adapters may expose transport lifecycle events through Figbird's adapter-neutral
connection observer. The Feathers adapter maps Socket.IO `connect`, `disconnect`,
connection failure, and Manager reconnection state into this observer. A successful
reconnection remains the single trigger for Figbird's active-query sweep.

The panel retains these lifecycle events in the bounded event log and renders a
**Connection** timeline lane. Red spans show detected offline intervals; the reconnect
marker carries the final attempt count and transport so the refetch activity immediately
after it can be correlated visually. Individual retry attempts are deliberately
coalesced instead of filling the event buffer. Authentication payloads and tokens are
never collected.

## Causal traces

Runtime events carry stable, session-local identifiers where one operation causes
another. Realtime items and reconnections are trace roots. Cache updates retain the
root identifier, reconciliation decisions record whether work started, coalesced,
deferred while hidden, or became pending while inactive, and fetch attempts carry
their reason, retry attempt, and causes. Fetch end/error events share a fetch ID with
their start event.

The event details pane assembles those events into one causal chain. Timeline fetch,
realtime, and connection marks link into the same chain. This metadata is emitted only
while something subscribes to `figbird.events`, and the extension continues to bound
all retained history.

## Cache inspection and editing

The page bridge exposes a serialized projection of each service's normalized entities,
their current query memberships, and complete-set materialization marker. The collector
adds session-local provenance from cache-update events (fetch, realtime, mutation,
optimistic projection, or devtools edit).

An attached extension session may replace one existing entity in memory. The edited
JSON must retain the same entity ID. Figbird reapplies locally decidable query results
and replaces the value in query results that already contain the entity; it never sends
a service mutation or server request. The panel labels this behavior explicitly and
offers a one-step undo. Later fetches or realtime events may overwrite the edit.

## Extension architecture

```
lib/core/devtoolsBridge.ts  weak instance registry and inspected-page session
lib/devtools/collector.ts   bounded query, event, timeline, and write history
lib/devtools/Devtools.tsx   shared React panel used only by the extension
extensions/src/remote.ts    polling transport exposed as a collector-compatible source
extensions/src/protocol.ts  versioned snapshot envelope and wire-to-panel decoding
extensions/src/inspection.ts  extension-side picker lifecycle and state
extensions/src/inspectionPage.ts  injected element picker and React query-area scanner
extensions/src/picker.ts    injected picker entry point and five-second cleanup
extensions/src/pickerProtocol.ts  shared picker key, version, and state contract
extensions/src/panel.tsx    panel entry point
extensions/manifests/       Chrome MV3 and Firefox MV2 manifests
tasks/build-devtools.js     shared esbuild packaging
```

The extension injects the query-area picker into the inspected page only when the user
selects **Inspect**. The overlay and React fiber scan stay in the extension package. An
active picker removes its page listeners after five seconds without an extension poll.

## Build and QA

```sh
npm run devtools:build
npm run devtools:package
```

The first command creates unpacked extensions in `extensions/build/chrome` and
`extensions/build/firefox`. The second also creates one manifest-at-root zip archive per
browser for store upload.

Run the library checks with `npm run test`. Manual browser QA should cover connection and
reconnection, query and relation grouping, the timeline, event and write clearing, theme
changes, the area picker, page reloads, and closing the panel long enough for its session
to expire.

## Scope

The panel is read-only apart from clearing its local history and starting or stopping the
element picker. It does not persist history across reloads, edit application state, or
provide time travel.
