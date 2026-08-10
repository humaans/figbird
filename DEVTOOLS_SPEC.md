# Figbird Devtools

Figbird devtools ship as Chrome and Firefox DevTools extensions. Applications do not
import `figbird/devtools`, render a drawer, or manage a stored enable/disable preference.

## Runtime contract

Constructing a Figbird instance registers a weak reference with a non-enumerable page
bridge at `globalThis.__FIGBIRD_DEVTOOLS__`. Registration does not subscribe to events,
inspect queries, or retain history.

The extension evaluates the bridge in the inspected page and calls `api.connect()`. A
connection:

- selects the newest live Figbird instance;
- subscribes to `figbird.events`;
- exposes current `inspect()`, `inspectRelational()`, and `mutating` snapshots;
- buffers at most 1,000 events between panel polls; and
- expires after five seconds without a poll, removing every subscription and picker
  listener.

The bridge serializes values before they cross the browser DevTools evaluation boundary.
Errors retain their name and message, bigint values become strings, and circular values
are marked instead of breaking the panel.

## Extension architecture

```
lib/core/devtoolsBridge.ts  weak instance registry and inspected-page session
lib/devtools/collector.ts   bounded query, event, timeline, and write history
lib/devtools/Devtools.tsx   shared React panel used only by the extension
extensions/src/remote.ts    polling transport exposed as a collector-compatible source
extensions/src/panel.tsx    panel entry point
extensions/manifests/       Chrome MV3 and Firefox MV2 manifests
tasks/build-devtools.js     shared esbuild packaging
```

The query-area picker also runs through the page bridge. Its overlay and React fiber scan
execute in the inspected page, while only the selected label and query counts cross back
to the extension panel.

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
