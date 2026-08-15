# Figbird browser extensions

## Build

From the repository root:

```sh
npm ci
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
- `extensions/build/figbird-devtools-firefox-unsigned.zip`
- `extensions/build/figbird-devtools-source.zip`

The Chrome and unsigned Firefox archives have `manifest.json` at their root. The source
archive lets Mozilla reproduce the minified Firefox build. Firefox users need the signed
XPI produced by Mozilla, not the unsigned ZIP. A local build cannot create that signed XPI,
and `npm run devtools:build` recreates `extensions/build`, so do not keep signed artifacts
there permanently.

The release workflow uploads both installable builds to the matching
`devtools-v<version>` GitHub prerelease:

- `figbird-devtools-chrome.zip`, which team members unzip and load using Chrome's
  **Load unpacked** action.
- `figbird-devtools-firefox-signed.xpi`, which Firefox installs directly after an
  installation prompt.

These release assets are the stable team downloads; the workflow artifacts are retained as
build records.

The shared browser extension version lives in `extensions/version.json`. See
`extensions/RELEASING.md` for publisher setup and release instructions.

## QA checklist

- The Figbird panel reports **Connected** after the page creates a Figbird instance.
- Queries, relational details, events, the fetch timeline, and writes update live.
- **Inspect** highlights the page and filters to queries owned by the selected area.
- Reloading or navigating the inspected tab reconnects the panel.
- Closing the panel for five seconds ends the page-side debug session.
- Light and dark browser themes remain readable in both browsers.
