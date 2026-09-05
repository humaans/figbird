import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const cache = join(root, 'node_modules/.cache/figbird')
await mkdir(cache, { recursive: true })
const consumer = await mkdtemp(join(cache, 'package-check-'))
const run = (command, args, cwd = consumer) =>
  execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })

try {
  const [packed] = JSON.parse(
    run(
      'npm',
      [
        'pack',
        '--ignore-scripts',
        '--json',
        '--cache',
        join(consumer, 'npm-cache'),
        '--pack-destination',
        consumer,
      ],
      root,
    ),
  )
  const installed = join(consumer, 'node_modules/figbird')
  await mkdir(installed, { recursive: true })
  run('tar', ['-xzf', join(consumer, packed.filename), '-C', installed, '--strip-components=1'])
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  assert.deepEqual(Object.keys(manifest.exports).sort(), [
    '.',
    './package.json',
    './testing',
    './tsconfig.json',
  ])

  for (const mode of ['module', 'commonjs']) {
    run(process.execPath, [
      `--input-type=${mode}`,
      '-e',
      `
        const assert = ${mode === 'module' ? "(await import('node:assert/strict')).default" : "require('node:assert/strict')"};
        const load = ${mode === 'module' ? 'specifier => import(specifier)' : 'specifier => Promise.resolve().then(() => require(specifier))'};
        (async () => {
          const library = await load('figbird');
          for (const name of ['Figbird', 'createSchema', 'createHooks', 'useQuery', 'useGet', 'useFind', 'useMutation']) {
            assert.equal(typeof library[name], 'function', name);
          }
          assert.equal(typeof (await load('figbird/testing')).mockFeathers, 'function');
          for (const path of ['core/queryStore', 'react/useQuery', 'adapters/feathers', 'devtools/Devtools', 'dist/esm/index.js']) {
            await assert.rejects(load('figbird/' + path), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
          }
        })().catch(error => { console.error(error); process.exitCode = 1; });
      `,
    ])
  }

  const source = `
    import { Figbird, FeathersAdapter, createSchema, createHooks, service } from 'figbird'
    import { mockFeathers } from 'figbird/testing'
    const schema = createSchema({ services: { notes: service<{ item: { id: number; title: string } }>() } })
    const client = mockFeathers({ notes: { data: { 1: { id: 1, title: 'one' } } } })
    const figbird = new Figbird({ schema, adapter: new FeathersAdapter(client) })
    const { useGet, useFind, useMutation } = createHooks(schema)
    const query = figbird.query(figbird.q.notes.get(1))
    const title: string | undefined = query.getSnapshot().data?.title
    void [title, useGet, useFind, useMutation]
    figbird.dispose()
  `
  for (const extension of ['mts', 'cts']) {
    await writeFile(join(consumer, `consumer.${extension}`), source)
  }
  run(join(root, 'node_modules/.bin/tsc'), [
    '--ignoreConfig',
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    '--module',
    'nodenext',
    '--target',
    'es2022',
    'consumer.mts',
    'consumer.cts',
  ])
  console.log('Packed ESM, CommonJS, declarations, legacy hooks, and private exports verified.')
} finally {
  await rm(consumer, { recursive: true, force: true })
}
