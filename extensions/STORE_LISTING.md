# Figbird Devtools store listing

## Shared listing copy

Name: **Figbird Devtools**

Short description: Inspect Figbird queries, realtime events, fetches, writes, and page ownership from browser developer tools.

Full description:

> Figbird Devtools adds a Figbird panel to your browser developer tools. Use it to inspect active and relational queries, follow realtime events, understand fetch timing, review writes, and locate the page area responsible for a query.
>
> Open developer tools on an application that uses a compatible Figbird version and select the Figbird panel. Diagnostics remain in your browser and are available only while the panel is connected.

- Category: Developer Tools
- Language: English
- Homepage: https://humaans.github.io/figbird/
- Support: https://github.com/humaans/figbird/issues
- Privacy policy: https://github.com/humaans/figbird/blob/main/extensions/PRIVACY.md

## Chrome Web Store

- Extension ID: `kaechbnbhjilkpjfpljbifpmbcppkpff`
- Visibility: Private
- Access: `Team - team@humaans.io` trusted tester group
- Purpose: Provide an interactive developer-tools panel for debugging Figbird applications.
- Website content handling: Yes. The panel reads Figbird diagnostic state from the inspected page and processes it only in browser memory for the visible debugging interface.
- Data transmission or sharing: None
- Remote code: None
- Permissions justification: The extension declares no optional or host permissions. Its `devtools_page` is required to add the Figbird panel and inspect the page selected by the developer.
- Store icon: `extensions/icons/icon128.png`
- Store screenshot: `extensions/store-assets/figbird-devtools-chrome.png`

The screenshot is rendered from the production panel bundle with representative local diagnostic
data. Its reproducible preview page is `extensions/store-assets/panel-preview.html`; run
`npm run devtools:build`, serve the repository root, and capture that page at 1280 × 800.

Use the private Humaans Workspace distribution for the first manual submission. The Chrome Web Store API preserves the dashboard's visibility setting on later releases.

## Firefox Add-ons

- Distribution: Unlisted / self-distributed
- Add-on ID: `devtools@figbird.dev`
- Data collection: None; declared as `required: ["none"]` in the Firefox manifest
- Reviewer note: The add-on reads Figbird diagnostic state only from the developer-selected inspected page, displays it locally, and makes no external requests. The only `fetch` call loads the packaged `picker.js` extension resource. Mozilla's linter reports two `innerHTML` warnings inside the bundled React DOM runtime; extension source does not assign to `innerHTML`.
- Source code: Upload `extensions/build/figbird-devtools-source.zip` with every submission.

The signed XPI can be shared directly with the team. It is not searchable or publicly listed on addons.mozilla.org.
