import { copyFile, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const assetName = 'figbird-devtools-firefox-signed.xpi'

try {
  await uploadFirefoxExtension()
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}

async function uploadFirefoxExtension() {
  const { version } = JSON.parse(
    await readFile(path.join(root, 'extensions', 'version.json'), 'utf8'),
  )
  if (!isExtensionVersion(version)) {
    throw new Error(`Invalid extension version: ${String(version)}`)
  }

  const tag = `devtools-v${version}`
  run('gh', ['auth', 'status', '--hostname', 'github.com'])
  const existingAssets = new Set(
    capture('gh', ['release', 'view', tag, '--json', 'assets', '--jq', '.assets[].name'])
      .split('\n')
      .filter(Boolean),
  )
  if (existingAssets.has(assetName)) {
    console.log(`Firefox extension ${version} is already published in GitHub release ${tag}`)
    return
  }

  run(process.execPath, ['tasks/sign-firefox-devtools-local.js', '--check'])
  run('npm', ['run', 'devtools:package'])
  run('npm', ['run', 'devtools:sign:firefox:local'])

  const signedDirectory = path.join(root, 'extensions', 'build', 'firefox-signed')
  const signedPackages = (await readdir(signedDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.xpi'))
    .map(entry => path.join(signedDirectory, entry.name))
  if (signedPackages.length !== 1) {
    throw new Error(
      `Expected one signed Firefox package in ${path.relative(root, signedDirectory)}, found ${signedPackages.length}`,
    )
  }

  const asset = path.join(root, 'extensions', 'build', assetName)
  await copyFile(signedPackages[0], asset)
  run('gh', ['release', 'upload', tag, asset, '--clobber'])

  const releaseUrl = capture('gh', ['release', 'view', tag, '--json', 'url', '--jq', '.url'])
  console.log(`Published Firefox extension ${version}: ${releaseUrl}`)
}

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

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' })
  checkResult(command, args, result)
  return result.stdout.trim()
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  checkResult(command, args, result)
}

function checkResult(command, args, result) {
  if (result.error) {
    if (result.error.code === 'ENOENT') throw new Error(`Required command not found: ${command}`)
    throw result.error
  }
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim()
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`)
  }
}
