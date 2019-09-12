const execa = require('execa')

const babel = './node_modules/.bin/babel'
const sh = (...args) => execa(...args, { stdio: 'inherit', shell: true })

const watch = process.argv[2] === '-w'
const w = watch ? ' -w' : ''

;(async function() {
  await sh('rm -rf dist')
  await sh('mkdir -p dist')
  await sh(`${babel}${w} --verbose --no-babelrc lib -d dist/esm --config-file=./.babelrc-esm`)
  await sh(`${babel}${w} --verbose --no-babelrc lib -d dist/cjs --config-file=./.babelrc-cjs`)
})()
