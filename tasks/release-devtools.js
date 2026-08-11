import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const environment = 'extension-release'
const workflow = 'devtools-release.yml'

try {
  await release()
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}

async function release() {
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
  const masterSha = capture('git', ['rev-parse', 'origin/master'])
  const version = readMasterVersion()
  const tag = `devtools-v${version}`
  const secrets = listNames('secret', repository)
  const variables = listVariables(repository)
  const problems = [
    ...missingNames('GitHub environment secret', secrets, ['AMO_JWT_ISSUER', 'AMO_JWT_SECRET']),
    ...missingNames('GitHub environment variable', variables.keys(), [
      'CHROME_EXTENSION_ID',
      'CHROME_PUBLISHER_ID',
      'CHROME_SERVICE_ACCOUNT',
      'CHROME_WORKLOAD_IDENTITY_PROVIDER',
    ]),
  ]

  const existingRelease = run('gh', ['release', 'view', tag, '--repo', repository], {
    allowFailure: true,
  })
  if (existingRelease.status === 0) {
    problems.push(
      `GitHub release ${tag} already exists; increase extensions/version.json and merge it first`,
    )
  }

  if (problems.length > 0) {
    throw new Error(
      `Cannot release Figbird Devtools ${version}:\n\n${problems
        .map(problem => `- ${problem}`)
        .join('\n')}\n\nSee extensions/RELEASING.md for setup instructions.`,
    )
  }

  run('gh', ['workflow', 'view', workflow, '--repo', repository])
  console.log(`Releasing Figbird Devtools ${version} from origin/master (${masterSha.slice(0, 7)})`)

  const dispatchedAt = Date.now()
  const dispatch = run('gh', [
    'workflow',
    'run',
    workflow,
    '--repo',
    repository,
    '--ref',
    'master',
    '-f',
    'sign_firefox=true',
    '-f',
    'upload_chrome=false',
    '-f',
    'submit_chrome=true',
  ])
  const runDetails =
    parseRunUrl(dispatch.stdout) ?? (await findDispatchedRun(repository, masterSha, dispatchedAt))

  console.log(`Release workflow: ${runDetails.url}`)
  const watched = run(
    'gh',
    ['run', 'watch', String(runDetails.id), '--repo', repository, '--compact', '--exit-status'],
    { inherit: true },
  )
  if (watched.status !== 0) throw new Error(`Extension release failed: ${runDetails.url}`)

  const publisherId = variables.get('CHROME_PUBLISHER_ID')
  const extensionId = variables.get('CHROME_EXTENSION_ID')
  console.log(`\nFirefox: https://github.com/${repository}/releases/tag/${tag}`)
  console.log(
    `Chrome: https://chrome.google.com/webstore/devconsole/${publisherId}/${extensionId}/edit/package`,
  )
  console.log('Chrome may remain under review after this command finishes.')
}

function readMasterVersion() {
  const contents = capture('git', ['show', 'origin/master:extensions/version.json'])
  const parsed = JSON.parse(contents)
  if (typeof parsed.version !== 'string') {
    throw new Error('origin/master extensions/version.json does not contain a version')
  }
  return parsed.version
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

function listVariables(repository) {
  const output = capture('gh', [
    'variable',
    'list',
    '--env',
    environment,
    '--repo',
    repository,
    '--json',
    'name,value',
  ])
  return new Map(JSON.parse(output).map(item => [item.name, item.value]))
}

function missingNames(label, present, required) {
  const available = new Set(present)
  return required.filter(name => !available.has(name)).map(name => `missing ${label} ${name}`)
}

function parseRunUrl(output) {
  const match = output.match(/https:\/\/github\.com\/[^\s]+\/actions\/runs\/(\d+)/)
  return match ? { id: Number(match[1]), url: match[0] } : null
}

async function findDispatchedRun(repository, masterSha, dispatchedAt) {
  const login = capture('gh', ['api', 'user', '--jq', '.login'])
  for (let attempt = 0; attempt < 20; attempt++) {
    const output = capture('gh', [
      'run',
      'list',
      '--repo',
      repository,
      '--workflow',
      workflow,
      '--commit',
      masterSha,
      '--event',
      'workflow_dispatch',
      '--user',
      login,
      '--limit',
      '10',
      '--json',
      'createdAt,databaseId,url',
    ])
    const runs = JSON.parse(output)
    const run = runs.find(item => Date.parse(item.createdAt) >= dispatchedAt - 5_000)
    if (run) return { id: run.databaseId, url: run.url }
    await wait(1_000)
  }
  throw new Error('Release was dispatched, but its workflow run could not be found')
}

function capture(command, args) {
  const result = run(command, args)
  return result.stdout.trim()
}

function run(command, args, { allowFailure = false, inherit = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
  })
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error(`Required command not found: ${command}`)
    }
    throw result.error
  }
  if (result.status !== 0 && !allowFailure && !inherit) {
    const detail = (result.stderr || result.stdout).trim()
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`)
  }
  return result
}
