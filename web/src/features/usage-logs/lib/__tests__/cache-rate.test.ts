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
import { describe, expect, test } from 'vitest'

import {
  calculateCacheRate,
  CACHE_RATE_TIER_LABELS,
  getCacheRateTier,
  getLogCacheRate,
} from '../cache-rate'

describe('getCacheRateTier', () => {
  test('marks the region below 50% as the lowest tier', () => {
    expect(getCacheRateTier(0)).toBe('low')
    expect(getCacheRateTier(49.9)).toBe('low')
    expect(CACHE_RATE_TIER_LABELS.low).toBe('区区！！')
  })

  test('includes both 50% and 90% in the middle tier', () => {
    expect(getCacheRateTier(50)).toBe('medium')
    expect(getCacheRateTier(90)).toBe('medium')
    expect(CACHE_RATE_TIER_LABELS.medium).toBe('区')
  })

  test('only exceeds 90% for the top tier', () => {
    expect(getCacheRateTier(90.1)).toBe('high')
    expect(getCacheRateTier(100)).toBe('high')
    expect(CACHE_RATE_TIER_LABELS.high).toBe('👑')
  })
})

describe('calculateCacheRate', () => {
  test('treats OpenAI prompt_tokens as already containing cache reads and writes', () => {
    const rate = calculateCacheRate(1000, 900, 50, false)
    expect(rate).not.toBeNull()
    expect(rate?.percent).toBeCloseTo(90, 5)
    expect(rate?.tier).toBe('medium')
  })

  test('adds Claude cache reads and writes because input_tokens excludes them', () => {
    const rate = calculateCacheRate(100, 800, 100, true)
    expect(rate?.percent).toBeCloseTo(80, 5)
    expect(rate?.tier).toBe('medium')
  })

  test('uses the cache token sum when an OpenAI upstream reports unadjusted prefixes', () => {
    // Backend fixture: cached 2921 + write 3616 both counted against prompt 3619.
    const rate = calculateCacheRate(3619, 2921, 3616, false)
    expect(rate?.percent).toBeCloseTo(44.68, 2)
    expect(rate?.tier).toBe('low')
  })

  test('trusts the normalized billing input total when it is larger', () => {
    const rate = calculateCacheRate(1200, 1000, 0, false, 2200)
    expect(rate?.percent).toBeCloseTo(45.45, 2)
    expect(rate?.tier).toBe('low')
  })

  test('does not re-add the cache split when the normalized total is present', () => {
    // A new-api relaying another new-api: OpenAI format, prompt already totals
    // the input, and the Claude 5m/1h split is still in the body.
    const rate = calculateCacheRate(1000, 800, 100, true, 1000)
    expect(rate?.percent).toBe(80)
    expect(rate?.tier).toBe('medium')
  })

  test('keeps the normalized total even when it is smaller than the cache sum', () => {
    const rate = calculateCacheRate(1000, 800, 100, true, 900)
    expect(rate?.percent).toBeCloseTo(88.89, 2)
    expect(rate?.tier).toBe('medium')
  })

  test('rounds the percentage before choosing the tier so both agree', () => {
    const rate = calculateCacheRate(100000, 90001, 0, false)
    expect(rate?.percent).toBe(90)
    expect(rate?.tier).toBe('medium')
    const justUnderHalf = calculateCacheRate(100000, 49999, 0, false)
    expect(justUnderHalf?.percent).toBe(50)
    expect(justUnderHalf?.tier).toBe('medium')
  })

  test('reports a rate above 90% as the top tier', () => {
    const rate = calculateCacheRate(1000, 950, 0, false)
    expect(rate?.percent).toBeCloseTo(95, 5)
    expect(rate?.tier).toBe('high')
    expect(rate?.label).toBe('👑')
  })

  test('reports a write-only request as a 0% hit rate in the lowest tier', () => {
    const rate = calculateCacheRate(1000, 0, 200, false)
    expect(rate?.percent).toBe(0)
    expect(rate?.tier).toBe('low')
    expect(rate?.label).toBe('区区！！')
  })

  test('returns null when the log used no cache at all', () => {
    expect(calculateCacheRate(1000, 0, 0, false)).toBeNull()
    expect(calculateCacheRate(0, 0, 0, true)).toBeNull()
  })

  test('keeps the hit rate at or below 100% when an upstream reports unadjusted prefixes', () => {
    const rate = calculateCacheRate(100, 500, 500, false)
    // read 500 of read+write 1,000; the prompt count is a floor, not the total.
    expect(rate?.percent).toBe(50)
    const backendShape = calculateCacheRate(3619, 2921, 3616, false)
    expect(backendShape?.percent).toBeCloseTo(44.68, 2)
    expect(backendShape?.tier).toBe('low')
    const allCached = calculateCacheRate(0, 500, 0, false)
    expect(allCached?.percent).toBe(100)
    expect(allCached?.tier).toBe('high')
  })
})

describe('getLogCacheRate', () => {
  test('uses the split 5m/1h cache writes for the Claude denominator', () => {
    const rate = getLogCacheRate(
      { prompt_tokens: 100 },
      {
        claude: true,
        cache_tokens: 700,
        cache_creation_tokens: 200,
        cache_creation_tokens_5m: 150,
        cache_creation_tokens_1h: 50,
      }
    )
    // 700 / (100 + 700 + 200)
    expect(rate?.percent).toBeCloseTo(70, 5)
  })

  test('takes the larger of the split and aggregate cache write totals', () => {
    const rate = getLogCacheRate(
      { prompt_tokens: 100 },
      {
        claude: true,
        cache_tokens: 700,
        cache_creation_tokens: 900,
        cache_creation_tokens_5m: 150,
        cache_creation_tokens_1h: 50,
      }
    )
    // 700 / (100 + 700 + 900), the same max() the billing path settles on.
    expect(rate?.percent).toBeCloseTo(41.18, 2)
    expect(rate?.tier).toBe('low')
  })

  test('prefers the normalized cache write total over the split fields', () => {
    const rate = getLogCacheRate(
      { prompt_tokens: 100 },
      {
        claude: true,
        cache_tokens: 700,
        cache_creation_tokens: 300,
        cache_creation_tokens_5m: 100,
        cache_creation_tokens_1h: 0,
        cache_write_tokens: 300,
      }
    )
    // 700 / (100 + 700 + 300)
    expect(rate?.percent).toBeCloseTo(63.64, 2)
  })

  test('treats a legacy Claude-derived OpenAI row as excluding cache from prompt', () => {
    const rate = getLogCacheRate(
      { prompt_tokens: 1200 },
      { cache_tokens: 1000, cache_creation_tokens_5m: 200 }
    )
    // 1000 / (1200 + 1000 + 200), not the 83.33% an OpenAI denominator gives.
    expect(rate?.percent).toBeCloseTo(41.67, 2)
    expect(rate?.tier).toBe('low')
  })
})
