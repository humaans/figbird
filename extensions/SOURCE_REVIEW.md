# Figbird Devtools source review

The submitted Firefox extension is bundled and minified with esbuild. This source archive contains the human-readable source and the exact dependency lockfile needed to reproduce it.

## Requirements

- Node.js 20 or newer
- npm
- macOS or Linux if you also want to create the ZIP archives

## Reproduce the Firefox build

From the extracted source archive:

```sh
npm ci
npm run devtools:build
```

The reconstructed Firefox extension is in `extensions/build/firefox`. Its files correspond to the root of the submitted XPI. No environment variables, network services, or generated source files are needed for the build after `npm ci` finishes.

The build entry point is `tasks/build-devtools.js`. It bundles the files in `extensions/src` and their imports from `lib`, copies the HTML and icon assets, and injects the version from `extensions/version.json` into the Firefox manifest.
