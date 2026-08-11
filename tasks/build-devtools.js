import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputRoot = path.join(root, 'extensions', 'build')
const { version } = JSON.parse(
  await readFile(path.join(root, 'extensions', 'version.json'), 'utf8'),
)

if (!isExtensionVersion(version)) {
  throw new Error(`Invalid extension version: ${String(version)}`)
}

await rm(outputRoot, { force: true, recursive: true })

for (const browser of ['chrome', 'firefox']) {
  const output = path.join(outputRoot, browser)
  await mkdir(output, { recursive: true })
  await build({
    bundle: true,
    entryPoints: {
      devtools: path.join(root, 'extensions', 'src', 'devtools.ts'),
      panel: path.join(root, 'extensions', 'src', 'panel.tsx'),
      picker: path.join(root, 'extensions', 'src', 'picker.ts'),
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
  await writeFile(
    path.join(output, 'manifest.json'),
    `${JSON.stringify({ ...manifest, version }, null, 2)}\n`,
  )
}

console.log(
  `Built Figbird Devtools ${version} for Chrome and Firefox in ${path.relative(root, outputRoot)}`,
)

function isExtensionVersion(value) {
  if (typeof value !== 'string') return false
  const components = value.split('.')
  return (
    components.length >= 1 &&
    components.length <= 4 &&
    components.some(component => component !== '0') &&
    components.every(component => /^(?:0|[1-9]\d*)$/.test(component) && Number(component) <= 65_535)
  )
}
