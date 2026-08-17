import { readFile } from 'node:fs/promises'
import webExt from 'web-ext'

const amoBaseUrl = 'https://addons.mozilla.org/api/v5/'
const apiKey = requiredEnvironmentVariable('AMO_JWT_ISSUER')
const apiSecret = requiredEnvironmentVariable('AMO_JWT_SECRET')
const webExtPackage = JSON.parse(
  await readFile(new URL('../node_modules/web-ext/package.json', import.meta.url), 'utf8'),
)
const maxAttempts = 3
const originalFetch = globalThis.fetch
let attemptState = createAttemptState()

globalThis.fetch = async (input, init) => {
  const url = requestUrl(input)
  const method = requestMethod(input, init)
  try {
    const response = await originalFetch(input, init)
    if (isAmoRequest(url)) inspectAmoResponse(url, method, response)
    return response
  } catch (error) {
    if (isRetrySafeUploadRequest(url, method)) {
      attemptState.retryable = true
      console.error(`AMO ${requestStage(url, method)} request failed: ${errorMessage(error)}`)
    }
    throw error
  }
}

try {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptState = createAttemptState()
    try {
      await webExt.cmd.sign({
        amoBaseUrl,
        apiKey,
        apiSecret,
        approvalTimeout: 900_000,
        artifactsDir: 'extensions/build/firefox-signed',
        channel: 'unlisted',
        sourceDir: 'extensions/build/firefox',
        timeout: 900_000,
        uploadSourceCode: 'extensions/build/figbird-devtools-source.zip',
        webextVersion: webExtPackage.version,
      })
      break
    } catch (error) {
      if (!attemptState.retryable || attempt === maxAttempts) throw error
      const delayMs = 5_000 * 2 ** (attempt - 1)
      console.warn(
        `Firefox signing attempt ${attempt} failed during the retry-safe AMO upload stage; ` +
          `retrying in ${delayMs / 1_000}s`,
      )
      await delay(delayMs)
    }
  }
} finally {
  globalThis.fetch = originalFetch
}

function inspectAmoResponse(url, method, response) {
  const contentType = response.headers.get('content-type') ?? '(missing)'
  const requestId = response.headers.get('x-amo-request-id') ?? '(missing)'
  const isJson = contentType.toLowerCase().includes('json')
  if (!response.ok || !isJson) {
    console.error(
      `AMO ${requestStage(url, method)} returned ${response.status} ${response.statusText || ''}` +
        `; content-type=${contentType}; request-id=${requestId}`,
    )
  }
  if (
    isRetrySafeUploadRequest(url, method) &&
    (response.status === 429 || response.status >= 500 || !isJson)
  ) {
    attemptState.retryable = true
  }
}

function requestUrl(input) {
  if (input instanceof URL) return input
  if (typeof input === 'string') return new URL(input)
  return new URL(input.url)
}

function requestMethod(input, init) {
  if (init?.method) return init.method.toUpperCase()
  if (typeof input !== 'string' && !(input instanceof URL)) return input.method.toUpperCase()
  return 'GET'
}

function isAmoRequest(url) {
  return url.origin === 'https://addons.mozilla.org' && url.pathname.startsWith('/api/v5/addons/')
}

function isRetrySafeUploadRequest(url, method) {
  return (
    isAmoRequest(url) &&
    (method === 'GET' || method === 'POST') &&
    url.pathname.startsWith('/api/v5/addons/upload/')
  )
}

function requestStage(url, method) {
  if (url.pathname.startsWith('/api/v5/addons/upload/')) {
    return method === 'POST' ? 'upload' : 'validation'
  }
  if (url.pathname.includes('/versions/')) return 'approval'
  return 'submission'
}

function createAttemptState() {
  return { retryable: false }
}

function requiredEnvironmentVariable(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
