import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_INPUT_BYTES = 256 * 1024
const MAX_BUCKETS = 256
const BUCKET_ID = /^[a-zA-Z0-9._:-]{1,64}$/

/** Keep only documented quota values; the CLI payload also contains account data. */
export function normalizeStatusline(payload, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!payload || typeof payload !== 'object' || !payload.quota || typeof payload.quota !== 'object') {
    throw new Error('quota data is missing')
  }
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) {
    throw new Error('invalid capture time')
  }

  const quota = {}
  for (const [id, value] of Object.entries(payload.quota)) {
    if (!BUCKET_ID.test(id) || id === '__proto__' || !value || typeof value !== 'object') {
      continue
    }

    const bucket = {}
    if (typeof value.remaining_fraction === 'number' &&
        Number.isFinite(value.remaining_fraction) &&
        value.remaining_fraction >= 0 && value.remaining_fraction <= 1) {
      bucket.remaining_fraction = value.remaining_fraction
    }
    if (typeof value.remaining_amount === 'number' &&
        Number.isFinite(value.remaining_amount) && value.remaining_amount >= 0) {
      bucket.remaining_amount = value.remaining_amount
    }
    if (Object.keys(bucket).length === 0) continue

    if (typeof value.reset_time === 'string' && Number.isFinite(Date.parse(value.reset_time))) {
      bucket.reset_time = new Date(value.reset_time).toISOString()
    } else if (typeof value.reset_in_seconds === 'number' &&
               Number.isFinite(value.reset_in_seconds) && value.reset_in_seconds >= 0) {
      bucket.reset_time = new Date((nowSeconds + value.reset_in_seconds) * 1000).toISOString()
    }
    if (value.disabled === true) bucket.disabled = true
    quota[id] = bucket
    if (Object.keys(quota).length === MAX_BUCKETS) break
  }
  if (Object.keys(quota).length === 0) throw new Error('no usable quota buckets')
  return { updated_at: nowSeconds, quota }
}

async function main() {
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > MAX_INPUT_BYTES) throw new Error('status line payload is too large')
    chunks.push(chunk)
  }
  const snapshot = normalizeStatusline(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  const outputPath = process.env.ANTIGRAVITY_USAGE_FILE
  if (!outputPath) throw new Error('ANTIGRAVITY_USAGE_FILE is required')

  const path = resolve(outputPath)
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 })
  await rename(temporaryPath, path)
  const summary = Object.entries(snapshot.quota)
    .map(([id, bucket]) => bucket.remaining_fraction === undefined
      ? `${id} ${bucket.remaining_amount}`
      : `${id} ${Math.round(bucket.remaining_fraction * 100)}%`)
    .join(' · ')
  process.stdout.write(summary)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`Antigravity quota snapshot: ${error.message}\n`)
    process.stdout.write('Quota unavailable')
  })
}
