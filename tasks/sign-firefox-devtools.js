import { createHmac, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const build = new URL('../extensions/build/', import.meta.url)
const api = 'https://addons.mozilla.org/api/v5/addons/'

try {
  await sign()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

async function sign() {
  requiredEnvironmentVariable('AMO_JWT_ISSUER')
  requiredEnvironmentVariable('AMO_JWT_SECRET')
  const manifest = JSON.parse(await readFile(new URL('firefox/manifest.json', build), 'utf8'))
  const addonId = manifest.browser_specific_settings.gecko.id
  const versionPath = `addon/${encodeURIComponent(addonId)}/versions/`
  const detailPath = `${versionPath}v${encodeURIComponent(manifest.version)}/`
  let version = await request(detailPath, { allowMissing: true })

  if (!version) {
    const upload = new FormData()
    upload.set('channel', 'unlisted')
    upload.set('upload', await archive('figbird-devtools-firefox-unsigned.zip'))
    const source = await archive('figbird-devtools-source.zip')
    console.log(`Uploading Firefox ${manifest.version} to Mozilla`)
    const { uuid } = await request('upload/', { method: 'POST', body: upload })
    await poll(`upload/${encodeURIComponent(uuid)}/`, 'validation', result => {
      if (!result.processed) return false
      if (!result.valid) {
        throw new Error(`Mozilla validation failed:\n${JSON.stringify(result.validation, null, 2)}`)
      }
      return true
    })
    const submission = new FormData()
    submission.set('upload', uuid)
    submission.set('source', source)
    version = await request(versionPath, { method: 'POST', body: submission })
  } else {
    console.log(`Resuming Mozilla version ${manifest.version}; existing uploads are reused`)
  }

  if (version.channel !== 'unlisted' || version.version !== manifest.version) {
    throw new Error('Mozilla returned a different version or channel; check the Developer Hub')
  }
  if (!version.source) {
    throw new Error('This Mozilla version has no source archive; upload it in the Developer Hub')
  }
  const approved = await poll(detailPath, 'approval', result => {
    if (result.file?.status === 'disabled' || result.is_disabled) {
      throw new Error('Mozilla disabled this version; check the Developer Hub')
    }
    return result.file?.status === 'public'
  })
  const downloadUrl = new URL(approved.file.url)
  if (downloadUrl.protocol !== 'https:') throw new Error('Expected an HTTPS download URL')
  const response = await fetch(downloadUrl, {
    headers: downloadUrl.origin === new URL(api).origin ? { Authorization: authorization() } : {},
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`Signed XPI download failed: HTTP ${response.status}`)
  const directory = new URL('firefox-signed/', build)
  await mkdir(directory, { recursive: true })
  const destination = new URL('figbird-devtools-firefox-signed.xpi', directory)
  const temporary = new URL('figbird-devtools-firefox-signed.xpi.tmp', directory)
  await writeFile(temporary, Buffer.from(await response.arrayBuffer()))
  await rename(temporary, destination)
  console.log(`Signed Firefox ${manifest.version}: ${destination.pathname}`)
}

async function archive(name) {
  return new File([await readFile(new URL(name, build))], name, { type: 'application/zip' })
}

async function poll(path, stage, complete) {
  console.log(`Waiting for Mozilla ${stage}`)
  const deadline = Date.now() + 900_000
  while (Date.now() < deadline) {
    const result = await request(path)
    if (complete(result)) return result
    await delay(5_000)
  }
  throw new Error(`Mozilla ${stage} timed out. Check the Developer Hub, then rerun this command.`)
}

async function request(path, { method = 'GET', body, allowMissing = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${api}${path}`, {
      method,
      body,
      headers: { Authorization: authorization(), Accept: 'application/json' },
      signal: AbortSignal.timeout(120_000),
    })
    if (allowMissing && response.status === 404) return null
    if (method === 'GET' && attempt < 3 && (response.status === 429 || response.status >= 500)) {
      await response.body?.cancel()
      await delay(5_000 * attempt)
      continue
    }
    const contentType = response.headers.get('content-type') ?? '(missing)'
    if (!response.ok || !contentType.includes('json')) {
      const requestId = response.headers.get('x-amo-request-id') ?? '(missing)'
      throw new Error(
        `Mozilla ${method} ${path}: HTTP ${response.status}; content-type=${contentType}; ` +
          `request-id=${requestId}. Check the Developer Hub before rerunning after a submission failure.`,
      )
    }
    return response.json()
  }
}

function authorization() {
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      iss: requiredEnvironmentVariable('AMO_JWT_ISSUER'),
      jti: randomUUID(),
      iat: now,
      exp: now + 300,
    }),
  ).toString('base64url')
  const signature = createHmac('sha256', requiredEnvironmentVariable('AMO_JWT_SECRET'))
    .update(`${header}.${payload}`)
    .digest('base64url')
  return `JWT ${header}.${payload}.${signature}`
}

function requiredEnvironmentVariable(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}
