import { cp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputRoot = path.join(root, 'extensions', 'build')
await rm(outputRoot, { force: true, recursive: true })

for (const browser of ['chrome', 'firefox']) {
  const output = path.join(outputRoot, browser)
  await mkdir(output, { recursive: true })
  await build({
    bundle: true,
    entryPoints: {
      devtools: path.join(root, 'extensions', 'src', 'devtools.ts'),
      panel: path.join(root, 'extensions', 'src', 'panel.tsx'),
    },
    format: 'iife',
    jsx: 'automatic',
    minify: true,
    outdir: output,
    platform: 'browser',
    sourcemap: false,
    target: browser === 'chrome' ? ['chrome120'] : ['firefox109'],
  })
  await cp(path.join(root, 'extensions', 'devtools.html'), path.join(output, 'devtools.html'))
  await cp(path.join(root, 'extensions', 'panel.html'), path.join(output, 'panel.html'))
  await cp(path.join(root, 'extensions', 'icons'), path.join(output, 'icons'), {
    recursive: true,
  })

  await cp(
    path.join(root, 'extensions', 'manifests', `${browser}.json`),
    path.join(output, 'manifest.json'),
  )
}

console.log(`Built Chrome and Firefox extensions in ${path.relative(root, outputRoot)}`)
