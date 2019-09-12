const execa = require('execa')

const sh = (...args) => execa(...args, { stdio: 'inherit', shell: true })

;(async function() {
  await sh('rm -rf dist')
  await sh(`cp -R lib dist`)

  const pkg = require('../package.json')
  const babel = './node_modules/.bin/babel'
  await sh(`${babel} --no-babelrc lib/index.js -o dist/${pkg.main} --config-file=./.babelrc-cjs`)
  await sh(`${babel} --no-babelrc lib/index.js -o dist/${pkg.module} --config-file=./.babelrc-esm`)
})()
