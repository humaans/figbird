# Figbird browser extensions

## Build

From the repository root:

```sh
npm install
npm run devtools:build
```

This creates unpacked builds in `extensions/build/chrome` and
`extensions/build/firefox`.

## Install for local QA

### Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select `extensions/build/chrome`.
4. Open a page using Figbird, then open developer tools and select **Figbird**.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on**.
3. Select `extensions/build/firefox/manifest.json`.
4. Open a page using Figbird, then open developer tools and select **Figbird**.

Firefox removes temporary add-ons when the browser restarts.

## Package for the stores

```sh
npm run devtools:package
```

The command creates:

- `extensions/build/figbird-devtools-chrome.zip`
- `extensions/build/figbird-devtools-firefox.zip`

Each archive has `manifest.json` at its root and can be uploaded to its browser store.
The Chrome and Firefox source manifests share an extension version. Bump both manifests
before publishing a new store release.

## QA checklist

- The Figbird panel reports **Connected** after the page creates a Figbird instance.
- Queries, relational details, events, the fetch timeline, and writes update live.
- **Inspect** highlights the page and filters to queries owned by the selected area.
- Reloading or navigating the inspected tab reconnects the panel.
- Closing the panel for five seconds ends the page-side debug session.
- Light and dark browser themes remain readable in both browsers.
