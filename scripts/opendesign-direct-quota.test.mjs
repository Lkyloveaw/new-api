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
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'

import {
  collectOpenDesignQuota,
  normalizePreflight,
} from './opendesign-direct-quota.mjs'

const NOW = Date.parse('2026-11-12T08:05:00Z')
const NOW_SECONDS = Math.floor(NOW / 1000)

// Shape copied from a real preflight response; every value here is an example.
const PREFLIGHT = {
  schemaVersion: 1,
  workspaceId: 'ws-example',
  workspaceMemberId: 'member-example',
  generatedAt: '2026-11-12T08:02:49.474Z',
  balanceUsd: '1.1000',
  codingPlan: {
    workspaceId: 'ws-example',
    generatedAt: '2026-11-12T08:02:49.474Z',
    eligible: true,
    tier: 'go',
    windows: [
      {
        policyId: 'policy-weekly',
        durationSeconds: 604800,
        resetMode: 'anchored_recurring',
        usedCredits: '60391',
        limitCredits: '150000',
        remainingCredits: '89609',
        windowStart: '2026-11-11T10:07:44.000Z',
        resetsAt: '2026-11-18T10:07:44.000Z',
      },
      {
        policyId: 'policy-5h',
        durationSeconds: 18000,
        resetMode: 'anchored_recurring',
        usedCredits: '4769',
        limitCredits: '50000',
        remainingCredits: '45231',
        windowStart: '2026-11-12T06:07:44.000Z',
        resetsAt: '2026-11-12T11:07:44.000Z',
      },
    ],
  },
  modelCovered: true,
  funding: 'coding_plan',
  fundingCheck: 'available',
  billingMode: 'shared',
  taskCheck: 'ready',
}

async function withSnapshot(run) {
  const testRoot = tmpdir()
  const directory = mkdtempSync(join(testRoot, 'newapi-opendesign-'))
  try {
    return await run({ snapshotPath: join(directory, 'opendesign-usage.json') })
  } finally {
    const inside = relative(resolve(testRoot), resolve(directory))
    assert.equal(inside.startsWith('..') || inside === '', false)
    rmSync(directory, { recursive: true, force: true })
  }
}

function options(paths, fetchImpl) {
  return {
    controlKey: 'control-key-example',
    workspaceId: 'ws-example',
    userAgent: 'new-api-usage-collector/test',
    fetchImpl,
    nowMs: NOW,
    ...paths,
  }
}

function assertPrivateFile(path) {
  if (process.platform !== 'win32') {
    assert.equal(statSync(path).mode & 0o777, 0o600)
  }
}

test('maps windows by duration and keeps only sanitized fractions', () => {
  const snapshot = normalizePreflight(PREFLIGHT, NOW_SECONDS)

  assert.deepEqual(snapshot, {
    updated_at: NOW_SECONDS,
    quota: {
      'od-5h': {
        remaining_fraction: 45231 / 50000,
        reset_time: '2026-11-12T11:07:44.000Z',
      },
      'od-weekly': {
        remaining_fraction: 89609 / 150000,
        reset_time: '2026-11-18T10:07:44.000Z',
      },
    },
  })
  const encoded = JSON.stringify(snapshot)
  for (const secret of ['ws-example', 'member-example', '1.1000', 'policy-5h', 'go']) {
    assert.equal(encoded.includes(secret), false, secret)
  }
})

test('an ineligible workspace publishes no window instead of a fake zero', () => {
  const snapshot = normalizePreflight(
    { schemaVersion: 1, codingPlan: { eligible: false, windows: [] } },
    NOW_SECONDS
  )

  assert.deepEqual(snapshot, { updated_at: NOW_SECONDS, quota: {} })
})

test('clamps an over-reported remaining balance to full and ignores unknown windows', () => {
  const snapshot = normalizePreflight(
    {
      codingPlan: {
        eligible: true,
        windows: [
          {
            durationSeconds: 18000,
            limitCredits: '100',
            remainingCredits: '250',
          },
          { durationSeconds: 60, limitCredits: '100', remainingCredits: '50' },
        ],
      },
    },
    NOW_SECONDS
  )

  assert.equal(snapshot.quota['od-5h'].remaining_fraction, 1)
  assert.deepEqual(Object.keys(snapshot.quota), ['od-5h'])
})

test('keeps a single readable window when the others are malformed', () => {
  const snapshot = normalizePreflight(
    {
      codingPlan: {
        eligible: true,
        windows: [
          { durationSeconds: 18000, limitCredits: 'oops', remainingCredits: '10' },
          { durationSeconds: 604800, limitCredits: '200', remainingCredits: '50' },
        ],
      },
    },
    NOW_SECONDS
  )

  assert.deepEqual(Object.keys(snapshot.quota), ['od-weekly'])
  assert.equal(snapshot.quota['od-weekly'].remaining_fraction, 0.25)
})

test('treats a zero limit and an exponent-notation credit as unusable', () => {
  const snapshot = normalizePreflight(
    {
      codingPlan: {
        eligible: true,
        windows: [
          { durationSeconds: 18000, limitCredits: '0', remainingCredits: '10' },
          { durationSeconds: 604800, limitCredits: '1e5', remainingCredits: '10' },
          { durationSeconds: 18000, limitCredits: '10', remainingCredits: '4' },
        ],
      },
    },
    NOW_SECONDS
  )

  assert.deepEqual(Object.keys(snapshot.quota), ['od-5h'])
  assert.equal(snapshot.quota['od-5h'].remaining_fraction, 0.4)
})

test('rejects an eligible plan whose windows are entirely unusable', () => {
  assert.throws(
    () =>
      normalizePreflight(
        { codingPlan: { eligible: true, windows: [{ durationSeconds: 60 }] } },
        NOW_SECONDS
      ),
    /no usable quota window/
  )
})

test('writes a private sanitized snapshot and reads quota from the control plane', async () => {
  await withSnapshot(async (paths) => {
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify(PREFLIGHT), { status: 200 })
    }

    const result = await collectOpenDesignQuota(options(paths, fetchImpl))
    const snapshot = JSON.parse(readFileSync(paths.snapshotPath, 'utf8'))

    assert.equal(result.bucketCount, 2)
    assert.equal(calls.length, 1)
    assert.equal(
      calls[0].url,
      'https://amr-api.open-design.ai/api/v1/workspaces/ws-example/billing/preflight'
    )
    assert.equal(calls[0].init.redirect, 'error')
    assert.equal(calls[0].init.headers.Authorization, 'Bearer control-key-example')
    assert.equal(calls[0].init.headers['x-vela-workspace-id'], 'ws-example')
    assert.equal(JSON.stringify(snapshot).includes('control-key-example'), false)
    assertPrivateFile(paths.snapshotPath)
  })
})

test('a failed preflight leaves the previous snapshot untouched', async () => {
  await withSnapshot(async (paths) => {
    const previous = { updated_at: 1234, quota: { 'od-5h': { remaining_fraction: 0.2 } } }
    writeFileSync(paths.snapshotPath, JSON.stringify(previous), { mode: 0o600 })

    const fetchImpl = async () => new Response('unauthorized', { status: 401 })
    await assert.rejects(
      collectOpenDesignQuota(options(paths, fetchImpl)),
      /preflight request failed \(HTTP 401\)/
    )
    assert.deepEqual(JSON.parse(readFileSync(paths.snapshotPath, 'utf8')), previous)
  })
})

test('missing configuration fails before any request is made', async () => {
  await withSnapshot(async (paths) => {
    let called = false
    const fetchImpl = async () => {
      called = true
      return new Response('{}', { status: 200 })
    }
    await assert.rejects(
      collectOpenDesignQuota({ ...options(paths, fetchImpl), controlKey: '' }),
      /configuration is incomplete/
    )
    await assert.rejects(
      collectOpenDesignQuota({ ...options(paths, fetchImpl), workspaceId: '../etc' }),
      /workspace ID is invalid/
    )
    await assert.rejects(
      collectOpenDesignQuota({ ...options(paths, fetchImpl), workspaceId: '..' }),
      /workspace ID is invalid/
    )
    assert.equal(called, false)
  })
})
