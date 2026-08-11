import { rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildRoot = path.join(root, 'extensions', 'build')
const archives = {
  chrome: path.join(buildRoot, 'figbird-devtools-chrome.zip'),
  firefox: path.join(buildRoot, 'figbird-devtools-firefox-unsigned.zip'),
  source: path.join(buildRoot, 'figbird-devtools-source.zip'),
}

await Promise.all(Object.values(archives).map(archive => rm(archive, { force: true })))

await zip(archives.chrome, ['.'], path.join(buildRoot, 'chrome'))
await zip(archives.firefox, ['.'], path.join(buildRoot, 'firefox'))
await zip(
  archives.source,
  [
    'LICENSE.md',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'extensions/SOURCE_REVIEW.md',
    'extensions/devtools.html',
    'extensions/panel.html',
    'extensions/icons',
    'extensions/manifests',
    'extensions/src',
    'extensions/version.json',
    'lib',
    'tasks/build-devtools.js',
  ],
  root,
)

console.log('Packaged Chrome, unsigned Firefox, and Mozilla source archives in extensions/build')

async function zip(output, entries, cwd) {
  await execa('zip', ['-qr', output, ...entries], { cwd })
}
