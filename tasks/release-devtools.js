import { spawnSync } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const directory = path.join(root, '.devtools-release')
const stateFile = path.join(directory, 'state.json')
const lock = path.join(directory, 'lock')
let locked = false

try {
  await mkdir(directory, { recursive: true })
  try {
    await mkdir(lock)
    locked = true
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    throw new Error(
      'A release is already running. If it was interrupted, remove .devtools-release/lock and rerun.',
    )
  }
  await release()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  console.error('Fix the problem and rerun make release-devtools to resume.')
  process.exitCode = 1
} finally {
  if (locked) await rm(lock, { recursive: true })
}

async function release() {
  let state = await readState()
  const source = capture('git', ['rev-parse', 'HEAD'])
  if (state?.complete && state.source === source && !process.env.VERSION) {
    console.log(`${state.tag} has already been released from this commit`)
    return
  }
  run('gh', ['auth', 'status', '--hostname', 'github.com'])
  if (!state || state.complete) {
    if (capture('git', ['status', '--porcelain']))
      throw new Error('Commit or stash your changes before releasing')
    run('git', ['fetch', 'origin', 'master', '--tags'])
    if (capture('git', ['rev-parse', 'origin/master']) !== source) {
      throw new Error('Release from the latest origin/master commit; update your checkout first')
    }
    run(process.execPath, ['tasks/sign-firefox-devtools-local.js', '--check'])
    run(process.execPath, ['tasks/publish-chrome-devtools.js', '--check'])
    const current = JSON.parse(await readFile(path.join(root, 'extensions/version.json'))).version
    const versions = [
      current,
      ...capture('git', ['tag', '--list', 'devtools-v*'])
        .split('\n')
        .filter(Boolean)
        .map(tag => tag.slice('devtools-v'.length)),
    ]
      .filter(validVersion)
      .sort(compareVersions)
    const latest = versions.at(-1)
    const components = latest.split('.').map(Number)
    components[components.length - 1]++
    const version = process.env.VERSION || components.join('.')
    if (!validVersion(version) || compareVersions(version, latest) <= 0) {
      throw new Error(`Choose a version newer than ${latest}: make release-devtools VERSION=x.y.z`)
    }
    state = { source, version, tag: `devtools-v${version}` }
    await save(state)
  }
  if (process.env.VERSION && process.env.VERSION !== state.version) {
    throw new Error(`Finish the pending release ${state.version} before choosing another version`)
  }
  const worktree = path.join(directory, state.tag)
  const build = path.join(worktree, 'extensions/build')
  const inRelease = { cwd: worktree }
  console.log(`Releasing ${state.tag} from ${state.source}`)

  if (!state.commit) {
    try {
      await readFile(path.join(worktree, '.git'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      run('git', ['worktree', 'add', '--detach', worktree, state.source])
    }
    await writeFile(
      path.join(worktree, 'extensions/version.json'),
      `${JSON.stringify({ version: state.version }, null, 2)}\n`,
    )
    run('git', ['add', 'extensions/version.json'], inRelease)
    if (capture('git', ['diff', '--cached', '--name-only'], inRelease)) {
      run('git', ['commit', '-m', `Release Figbird Devtools ${state.version}`], inRelease)
    }
    state.commit = capture('git', ['rev-parse', 'HEAD'], inRelease)
    await save(state)
  }
  if (!state.built) {
    run('npm', ['ci'], inRelease)
    run('npm', ['test'], inRelease)
    run('npm', ['run', 'devtools:check'], inRelease)
    state.built = true
    await save(state)
  }
  if (!state.github) {
    const tags = capture('git', ['tag', '--list', state.tag])
    if (tags && capture('git', ['rev-parse', `${state.tag}^{commit}`]) !== state.commit) {
      throw new Error(`${state.tag} already points at another commit`)
    }
    if (!tags) run('git', ['tag', state.tag, state.commit])
    run('git', ['push', 'origin', `refs/tags/${state.tag}`])
    const releases = JSON.parse(
      capture('gh', ['release', 'list', '--limit', '1000', '--json', 'tagName']),
    )
    if (!releases.some(release => release.tagName === state.tag)) {
      run('gh', [
        'release',
        'create',
        state.tag,
        '--verify-tag',
        '--draft',
        '--prerelease',
        '--title',
        `Figbird Devtools ${state.version}`,
        '--notes',
        'Chrome extension archive and Mozilla-signed Firefox extension for team distribution. Chrome has been submitted for private-store review.',
      ])
    }
    run('gh', [
      'release',
      'upload',
      state.tag,
      path.join(build, 'figbird-devtools-chrome.zip'),
      '--clobber',
    ])
    state.github = true
    await save(state)
  }

  const failures = []
  for (const browser of ['chrome', 'firefox']) {
    if (state[browser]) continue
    try {
      if (browser === 'chrome') {
        run(process.execPath, ['tasks/publish-chrome-devtools.js'], inRelease)
      } else {
        run(process.execPath, ['tasks/sign-firefox-devtools-local.js'], inRelease)
        run('gh', [
          'release',
          'upload',
          state.tag,
          path.join(build, 'firefox-signed/figbird-devtools-firefox-signed.xpi'),
          '--clobber',
        ])
      }
      state[browser] = true
      await save(state)
    } catch (error) {
      failures.push(`${browser}: ${error.message}`)
    }
  }
  if (failures.length) throw new Error(failures.join('\n'))
  run('gh', ['release', 'edit', state.tag, '--draft=false'])
  state.complete = true
  await save(state)
  console.log(capture('gh', ['release', 'view', state.tag, '--json', 'url', '--jq', '.url']))
}

async function readState() {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function save(state) {
  await writeFile(`${stateFile}.tmp`, `${JSON.stringify(state, null, 2)}\n`)
  await rename(`${stateFile}.tmp`, stateFile)
}

function validVersion(value) {
  return (
    typeof value === 'string' &&
    /^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(value) &&
    value.split('.').every(part => Number(part) <= 65_535)
  )
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 4; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference) return difference
  }
  return 0
}

function capture(command, args, options) {
  return run(command, args, { ...options, capture: true }).stdout.trim()
}

function run(command, args, { cwd = root, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`,
    )
  return result
}
