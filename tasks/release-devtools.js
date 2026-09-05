import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const environment = 'extension-release'
const releaseWorkflow = 'devtools-release.yml'

try {
  await prepareRelease()
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}

async function prepareRelease() {
  run('gh', ['auth', 'status', '--hostname', 'github.com'])
  run('git', ['fetch', '--quiet', 'origin', 'master'])

  const repository = capture('gh', [
    'repo',
    'view',
    '--json',
    'nameWithOwner',
    '--jq',
    '.nameWithOwner',
  ])
  const currentVersion = readMasterVersion()
  const version = requestedVersion(currentVersion)
  const tag = `devtools-v${version}`
  const branch = `release/${tag}`
  const variables = listNames('variable', repository)
  const problems = [
    ...missingNames('GitHub environment variable', variables, [
      'CHROME_EXTENSION_ID',
      'CHROME_PUBLISHER_ID',
      'CHROME_SERVICE_ACCOUNT',
      'CHROME_WORKLOAD_IDENTITY_PROVIDER',
    ]),
  ]

  if (
    run('gh', ['release', 'view', tag, '--repo', repository], { allowFailure: true }).status === 0
  ) {
    problems.push(`GitHub release ${tag} already exists`)
  }
  if (
    run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true })
      .status === 0
  ) {
    problems.push(`local branch ${branch} already exists`)
  }
  if (
    run('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch], { allowFailure: true })
      .status === 0
  ) {
    problems.push(`remote branch ${branch} already exists`)
  }

  if (problems.length > 0) {
    throw new Error(
      `Cannot prepare Figbird Devtools ${version}:\n\n${problems
        .map(problem => `- ${problem}`)
        .join('\n')}\n\nSee extensions/RELEASING.md for setup instructions.`,
    )
  }

  run('gh', ['workflow', 'view', releaseWorkflow, '--repo', repository])
  const pullRequest = await createVersionPullRequest({ branch, repository, version })
  console.log(`\nFigbird Devtools ${version}: ${pullRequest}`)
  console.log(
    'Approve and merge this PR to submit Chrome for review, then run make upload-firefox-extension locally.',
  )
}

async function createVersionPullRequest({ branch, repository, version }) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'figbird-devtools-release-'))
  const worktree = path.join(temporaryRoot, 'worktree')
  let addedWorktree = false
  try {
    run('git', ['worktree', 'add', '--quiet', '-b', branch, worktree, 'origin/master'])
    addedWorktree = true
    await writeFile(
      path.join(worktree, 'extensions', 'version.json'),
      `${JSON.stringify({ version }, null, 2)}\n`,
    )
    run('git', ['add', 'extensions/version.json'], { cwd: worktree })
    run('git', ['commit', '-m', `Release Figbird Devtools ${version}`], { cwd: worktree })
    run('git', ['push', '-u', 'origin', branch], { cwd: worktree })

    const output = capture('gh', [
      'pr',
      'create',
      '--repo',
      repository,
      '--base',
      'master',
      '--head',
      branch,
      '--title',
      `Release Figbird Devtools ${version}`,
      '--body',
      `Bump the shared browser extension version to ${version}.\n\nMerging this PR submits the private Chrome extension for review. After merging, run make upload-firefox-extension locally to sign and publish Firefox.`,
    ])
    return output.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0] ?? output
  } finally {
    if (addedWorktree) {
      run('git', ['worktree', 'remove', '--force', worktree], { allowFailure: true })
    }
    await rm(temporaryRoot, { force: true, recursive: true })
  }
}

function readMasterVersion() {
  const contents = capture('git', ['show', 'origin/master:extensions/version.json'])
  const parsed = JSON.parse(contents)
  if (typeof parsed.version !== 'string') {
    throw new Error('origin/master extensions/version.json does not contain a version')
  }
  validateVersion(parsed.version, 'Current')
  return parsed.version
}

function requestedVersion(currentVersion) {
  const version = process.env.VERSION || incrementVersion(currentVersion)
  validateVersion(version, 'Requested')
  if (compareVersions(version, currentVersion) <= 0) {
    throw new Error(`Requested extension version ${version} must be newer than ${currentVersion}`)
  }
  return version
}

function incrementVersion(version) {
  const components = version.split('.').map(Number)
  const last = components.length - 1
  if (components[last] === 65_535) {
    throw new Error(
      `Cannot automatically increase ${version}; run make release-extensions VERSION=x.y.z`,
    )
  }
  components[last]++
  return components.join('.')
}

function validateVersion(version, label) {
  const components = version.split('.')
  const valid =
    components.length >= 1 &&
    components.length <= 4 &&
    components.some(component => component !== '0') &&
    components.every(component => /^(?:0|[1-9]\d*)$/.test(component) && Number(component) <= 65_535)
  if (!valid) throw new Error(`${label} extension version is invalid: ${version}`)
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 4; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function listNames(kind, repository) {
  const output = capture('gh', [
    kind,
    'list',
    '--env',
    environment,
    '--repo',
    repository,
    '--json',
    'name',
  ])
  return new Set(JSON.parse(output).map(item => item.name))
}

function missingNames(label, present, required) {
  return required.filter(name => !present.has(name)).map(name => `missing ${label} ${name}`)
}

function capture(command, args) {
  const result = run(command, args)
  return result.stdout.trim()
}

function run(command, args, { allowFailure = false, cwd = root } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.error) {
    if (result.error.code === 'ENOENT') throw new Error(`Required command not found: ${command}`)
    throw result.error
  }
  if (result.status !== 0 && !allowFailure) {
    const detail = (result.stderr || result.stdout).trim()
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`)
  }
  return result
}
