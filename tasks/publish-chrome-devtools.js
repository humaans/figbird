import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'

const config = JSON.parse(await readFile(new URL('../extensions/publishers.json', import.meta.url)))
const accessToken = process.env.CHROME_ACCESS_TOKEN || (await chromeAccessToken())
const item = `publishers/${config.chromePublisherId}/items/${config.chromeExtensionId}`
const apiRoot = 'https://chromewebstore.googleapis.com'
const status = await request(`${apiRoot}/v2/${item}:fetchStatus`)

if (!process.argv.includes('--check')) await publish()
else console.log('Chrome publishing credentials are available')

async function publish() {
  const { version } = JSON.parse(
    await readFile(new URL('../extensions/version.json', import.meta.url)),
  )
  for (const revision of [status.publishedItemRevisionStatus, status.submittedItemRevisionStatus]) {
    if (!revision?.distributionChannels?.some(channel => channel.crxVersion === version)) continue
    if (['PENDING_REVIEW', 'PUBLISHED', 'PUBLISHED_TO_TESTERS'].includes(revision.state)) {
      console.log(`Chrome ${version} is already ${revision.state}`)
      return
    }
    throw new Error(`Chrome ${version} is ${revision.state}; resolve it in the Web Store dashboard`)
  }
  if (status.submittedItemRevisionStatus?.state === 'PENDING_REVIEW') {
    throw new Error('Another Chrome version is awaiting review; resolve it before releasing')
  }
  const upload = await request(`${apiRoot}/upload/v2/${item}:upload`, {
    body: await readFile(
      new URL('../extensions/build/figbird-devtools-chrome.zip', import.meta.url),
    ),
    method: 'POST',
  })
  console.log(`Uploaded Chrome extension ${upload.crxVersion ?? '(processing)'}`)
  if (isInProgressUploadState(upload.uploadState)) await waitForUpload(item)
  else if (!isSuccessfulUploadState(upload.uploadState)) {
    throw new Error(`Chrome upload failed with state ${String(upload.uploadState)}`)
  }
  const publication = await request(`${apiRoot}/v2/${item}:publish`, {
    body: JSON.stringify({ blockOnWarnings: true }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
  if (!['PENDING_REVIEW', 'PUBLISHED', 'PUBLISHED_TO_TESTERS'].includes(publication.state)) {
    throw new Error(`Chrome submission returned ${String(publication.state)}; check the dashboard`)
  }
  console.log(`Submitted Chrome extension with state ${publication.state}`)
}

async function chromeAccessToken() {
  const result = spawnSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('Google login unavailable; run gcloud auth login')
  const response = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${config.chromeServiceAccount}:generateAccessToken`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${result.stdout.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ scope: ['https://www.googleapis.com/auth/chromewebstore'] }),
      signal: AbortSignal.timeout(30_000),
    },
  )
  if (!response.ok) {
    throw new Error(
      `Cannot impersonate Chrome service account: HTTP ${response.status}. Your Google account needs Service Account Token Creator on ${config.chromeServiceAccount}`,
    )
  }
  return (await response.json()).accessToken
}

async function waitForUpload(itemName) {
  for (let attempt = 0; attempt < 24; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5_000))
    const status = await request(`${apiRoot}/v2/${itemName}:fetchStatus`)
    if (isSuccessfulUploadState(status.lastAsyncUploadState)) return
    if (status.lastAsyncUploadState && !isInProgressUploadState(status.lastAsyncUploadState)) {
      throw new Error(`Chrome upload failed with state ${status.lastAsyncUploadState}`)
    }
  }
  throw new Error('Chrome upload was still processing after two minutes')
}

function isSuccessfulUploadState(state) {
  return state === 'UPLOAD_SUCCESS' || state === 'SUCCEEDED'
}

function isInProgressUploadState(state) {
  return state === 'UPLOAD_IN_PROGRESS' || state === 'IN_PROGRESS'
}

async function request(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(120_000),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
  })
  const body = await response.json()
  if (!response.ok) {
    throw new Error(`Chrome Web Store API returned ${response.status}: ${JSON.stringify(body)}`)
  }
  return body
}
