import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const keychainAccount = 'humaans'

const issuer = readKeychainPassword('figbird-amo-jwt-issuer')
const secret = readKeychainPassword('figbird-amo-jwt-secret')
if (process.argv.includes('--check')) {
  console.log('Firefox signing credentials are available in macOS Keychain')
  process.exit(0)
}
const result = spawnSync(process.execPath, ['tasks/sign-firefox-devtools.js'], {
  cwd: root,
  env: {
    ...process.env,
    AMO_JWT_ISSUER: issuer,
    AMO_JWT_SECRET: secret,
  },
  stdio: 'inherit',
})

if (result.error) throw result.error
if (result.signal) throw new Error(`Firefox signing stopped after receiving ${result.signal}`)
process.exitCode = result.status ?? 1

function readKeychainPassword(service) {
  const result = spawnSync(
    'security',
    ['find-generic-password', '-w', '-a', keychainAccount, '-s', service],
    { encoding: 'utf8' },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Could not read ${service} from macOS Keychain`)
  }
  return result.stdout.trim()
}
