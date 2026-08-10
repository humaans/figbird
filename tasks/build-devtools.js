import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputRoot = path.join(root, 'extensions', 'build')
const packageVersion = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version

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

  const manifest = JSON.parse(
    await readFile(path.join(root, 'extensions', 'manifests', `${browser}.json`), 'utf8'),
  )
  manifest.version = packageVersion.replace(/-.+$/, '')
  await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

console.log(`Built Chrome and Firefox extensions in ${path.relative(root, outputRoot)}`)
