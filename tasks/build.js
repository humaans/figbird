const watch = process.argv[2] === '-w'
const w = watch ? ' -w' : ''

;(async function () {
  const { execa } = await import('execa')
  const sh = (...args) => execa(...args, { stdio: 'inherit', shell: true })

  await sh('rm -rf dist')
  await sh('mkdir -p dist')

  const swc = './node_modules/.bin/swc'
  const tsc = './node_modules/.bin/tsc'

  // Build JavaScript files with SWC
  await sh(`${swc}${w} --no-swcrc lib -d dist/esm --strip-leading-paths --config-file=./.swc-esm`)
  await sh(`${swc}${w} --no-swcrc lib -d dist/cjs --strip-leading-paths --config-file=./.swc-cjs`)

  // Generate TypeScript declaration files
  // We emit only declarations, no JS, and put them in ESM folder
  await sh(`${tsc} --project tsconfig.build.json`)

  // Copy declaration files to CJS folder preserving directory structure
  // Using rsync to properly copy all .d.ts and .d.ts.map files
  await sh(
    'rsync -r --include="*/" --include="*.d.ts" --include="*.d.ts.map" --exclude="*" dist/esm/ dist/cjs/',
  )
})()
