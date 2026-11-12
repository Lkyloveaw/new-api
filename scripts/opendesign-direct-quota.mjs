/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { normalizeStatusline } from './antigravity-statusline.mjs'

/**
 * OpenDesign splits credentials by plane: the inference key (sk-amr-…) can only
 * reach the model plane and is rejected by every billing endpoint, so quota is
 * read from the control plane with a control key (vela_ctrl_…). This collector
 * therefore runs on the host, keeps the control key in its own environment, and
 * publishes only the sanitized window fractions to the read-only snapshot file.
 */
const CONTROL_API_ORIGIN = 'https://amr-api.open-design.ai'
const PREFLIGHT_PATH = '/api/v1/workspaces/{workspaceId}/billing/preflight'
const MAX_RESPONSE_BYTES = 256 * 1024
const REQUEST_TIMEOUT_MS = 15 * 1000
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const CREDIT_AMOUNT = /^\d{1,20}(\.\d{1,12})?$/

/** durationSeconds is the only stable window identity; array order is not. */
const WINDOW_BUCKETS = [
  { durationSeconds: 5 * 60 * 60, bucket: 'od-5h' },
  { durationSeconds: 7 * 24 * 60 * 60, bucket: 'od-weekly' },
]

/** Credits arrive as decimal strings; a malformed one invalidates the window. */
function parseCredits(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value
  }
  if (typeof value !== 'string' || !CREDIT_AMOUNT.test(value.trim())) return null
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/**
 * Keep only the quota windows a model square can display. Wallet balance,
 * workspace and member identifiers, tier names and the plan flag never leave
 * this function.
 */
export function normalizePreflight(payload, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('preflight payload is invalid')
  }
  const plan = payload.codingPlan
  // No subscription is a real state, not a zero balance: publish no windows so
  // the catalog shows "usage unavailable" instead of a fabricated 0%.
  if (!plan || typeof plan !== 'object' || plan.eligible !== true) {
    return { updated_at: nowSeconds, quota: {} }
  }
  if (!Array.isArray(plan.windows)) {
    throw new Error('preflight windows are missing')
  }

  const quota = Object.create(null)
  for (const entry of plan.windows) {
    if (!entry || typeof entry !== 'object') continue
    const target = WINDOW_BUCKETS.find(
      (candidate) => entry.durationSeconds === candidate.durationSeconds
    )
    if (!target) continue
    if (Object.hasOwn(quota, target.bucket)) {
      throw new Error('duplicate quota window')
    }
    const limit = parseCredits(entry.limitCredits)
    const remaining = parseCredits(entry.remainingCredits)
    if (limit === null || remaining === null || limit <= 0) continue
    const fraction = Math.min(Math.max(remaining / limit, 0), 1)
    const bucket = { remaining_fraction: fraction }
    if (
      typeof entry.resetsAt === 'string' &&
      Number.isFinite(Date.parse(entry.resetsAt))
    ) {
      bucket.reset_time = entry.resetsAt
    }
    quota[target.bucket] = bucket
  }

  if (Object.keys(quota).length === 0) {
    throw new Error('preflight has no usable quota window')
  }
  // Reuse the shared sanitizer so both collectors emit the same snapshot shape
  // and the same bucket-ID / fraction validation.
  return normalizeStatusline({ quota }, nowSeconds)
}

async function writePrivateJson(path, value) {
  const target = resolve(path)
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const temporary = target + '.' + process.pid + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, JSON.stringify(value) + '\n', {
      mode: 0o600,
      flag: 'wx',
    })
    await chmod(temporary, 0o600)
    await rename(temporary, target)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw new Error(
      'private snapshot write failed (' + (error.code || 'unknown') + ')'
    )
  }
}

async function readBoundedJson(response) {
  if (!response.body) throw new Error('upstream response has no body')
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new Error('upstream response is too large')
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('upstream response is invalid JSON')
  }
}

async function fetchPreflight(options) {
  const url =
    CONTROL_API_ORIGIN +
    PREFLIGHT_PATH.replace('{workspaceId}', encodeURIComponent(options.workspaceId))
  let response
  try {
    response = await options.fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Authorization: 'Bearer ' + options.controlKey,
        'x-vela-workspace-id': options.workspaceId,
        Accept: 'application/json',
        'User-Agent': options.userAgent,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new Error('preflight request failed (network or timeout)')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error('preflight request failed (HTTP ' + response.status + ')')
  }
  return readBoundedJson(response)
}

/** Read OpenDesign quota on the host and publish only sanitized windows. */
export async function collectOpenDesignQuota(options) {
  const required = ['controlKey', 'workspaceId', 'snapshotPath', 'userAgent']
  if (required.some((key) => typeof options?.[key] !== 'string' || !options[key])) {
    throw new Error('collector configuration is incomplete')
  }
  if (!WORKSPACE_ID.test(options.workspaceId)) {
    throw new Error('workspace ID is invalid')
  }
  const nowMs = options.nowMs ?? Date.now()
  const context = {
    ...options,
    nowMs,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
  }
  const payload = await fetchPreflight(context)
  const snapshot = normalizePreflight(payload, Math.floor(nowMs / 1000))
  await writePrivateJson(context.snapshotPath, snapshot)
  return {
    bucketCount: Object.keys(snapshot.quota).length,
    updatedAt: snapshot.updated_at,
  }
}

async function main() {
  if (process.argv.length > 2) {
    throw new Error('usage: opendesign-direct-quota.mjs')
  }
  const result = await collectOpenDesignQuota({
    controlKey: process.env.OPENDESIGN_CONTROL_KEY,
    workspaceId: process.env.OPENDESIGN_WORKSPACE_ID,
    snapshotPath: process.env.OPENDESIGN_USAGE_FILE,
    userAgent: process.env.OPENDESIGN_QUOTA_USER_AGENT || 'new-api-usage-collector/1.0',
  })
  process.stdout.write(
    'OpenDesign quota: ' + result.bucketCount + ' buckets updated\n'
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write('OpenDesign quota collector: ' + error.message + '\n')
    process.exitCode = 1
  })
}
