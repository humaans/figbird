import { readFile } from 'node:fs/promises'

const accessToken = requiredEnvironmentVariable('CHROME_ACCESS_TOKEN')
const publisherId = requiredEnvironmentVariable('CHROME_PUBLISHER_ID')
const extensionId = requiredEnvironmentVariable('CHROME_EXTENSION_ID')
const archive = requiredEnvironmentVariable('CHROME_EXTENSION_ARCHIVE')
const submit = process.env.CHROME_SUBMIT === 'true'
const item = `publishers/${publisherId}/items/${extensionId}`
const apiRoot = 'https://chromewebstore.googleapis.com'

const upload = await request(`${apiRoot}/upload/v2/${item}:upload`, {
  body: await readFile(archive),
  method: 'POST',
})

console.log(`Uploaded Chrome extension ${upload.crxVersion ?? '(processing)'}`)

if (isInProgressUploadState(upload.uploadState)) {
  await waitForUpload(item)
} else if (!isSuccessfulUploadState(upload.uploadState)) {
  throw new Error(`Chrome upload failed with state ${String(upload.uploadState)}`)
}

if (submit) {
  const publication = await request(`${apiRoot}/v2/${item}:publish`, {
    body: JSON.stringify({ blockOnWarnings: true }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
  console.log(`Submitted Chrome extension with state ${String(publication.state)}`)
} else {
  console.log('Chrome extension is uploaded but has not been submitted for review')
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

function requiredEnvironmentVariable(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}
