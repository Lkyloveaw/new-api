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
import type { UsageLog } from '../data/schema'
import type { LogOtherData } from '../types'

/**
 * The cache-rate tiers are fixed markers requested by the operator, not
 * translatable copy: the same short label appears in every interface language
 * so a row stays comparable at a glance.
 */
export type CacheRateTier = 'low' | 'medium' | 'high'

export const CACHE_RATE_TIER_LABELS: Record<CacheRateTier, string> = {
  low: '区区！！',
  medium: '区',
  high: '👑',
}

export interface CacheRate {
  /** Cache-read share of the request's prompt input, in percent. */
  percent: number
  tier: CacheRateTier
  label: string
}

/**
 * Cache writes: the backend-normalized total wins, because it already merges
 * the 5m/1h split, the 12h writes and the aggregate field with max() semantics.
 * Older rows without it fall back to the same max() of split and aggregate.
 */
export function getCacheWriteTokens(other: LogOtherData | null): number {
  if (!other) return 0
  const normalized = other.cache_write_tokens || 0
  if (normalized > 0) return normalized
  const split =
    (other.cache_creation_tokens_5m || 0) +
    (other.cache_creation_tokens_1h || 0)
  return Math.max(split, other.cache_creation_tokens || 0)
}

/**
 * Map a cache-read percentage onto its display tier. The boundaries follow the
 * operator's rule: below 50% is low, 50~90% inclusive is medium, above 90% is
 * high.
 */
export function getCacheRateTier(percent: number): CacheRateTier {
  if (percent > 90) return 'high'
  if (percent >= 50) return 'medium'
  return 'low'
}

/** Rounds to the two decimals the tag prints, so the tier and the number agree. */
function roundPercent(percent: number): number {
  return Math.round(percent * 100) / 100
}

/**
 * Cache-read tokens over total prompt input tokens.
 *
 * OpenAI-compatible upstreams normally report `prompt_tokens` already containing
 * cached reads and writes, so it is the denominator. Two upstream shapes break
 * that assumption and are handled here:
 * - Claude reports `input_tokens` without either cache count, so reads and
 *   writes are added.
 * - OpenAI-compatible upstreams may report unadjusted prefix counts, where
 *   `cached_tokens + cache_write_tokens > prompt_tokens` (the backend clamps the
 *   billable remainder to zero for the same reason). The denominator then has to
 *   be at least the sum of both cache counts, otherwise the hit rate is inflated
 *   towards 100%.
 *
 * `inputTokensTotal` is the backend-normalized billing input total when the log
 * carries one. It wins over any derivation from prompt and cache fields, because
 * it counts the cache exactly once even when a relayed body still carries the
 * Claude 5m/1h split. Without it, the cache-token sum is a floor for the derived
 * total so an unadjusted prefix report cannot inflate the rate.
 *
 * A log that only wrote cache and read none is a 0% hit rate, which is shown as
 * the lowest tier. A log with no cache tokens at all has no rate.
 */
export function calculateCacheRate(
  promptTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  promptExcludesCache: boolean,
  inputTokensTotal = 0
): CacheRate | null {
  const prompt = Number.isFinite(promptTokens) ? Math.max(promptTokens, 0) : 0
  const read = Number.isFinite(cacheReadTokens)
    ? Math.max(cacheReadTokens, 0)
    : 0
  const write = Number.isFinite(cacheWriteTokens)
    ? Math.max(cacheWriteTokens, 0)
    : 0
  if (read === 0 && write === 0) return null

  // A backend-normalized input total is authoritative: it already counts cache
  // reads and writes exactly once, so a stale split field (an OpenAI body relayed
  // by another new-api carries claude_cache_creation_* tokens) must not add them
  // again. Only guard against a read count above the reported total.
  const normalized = Number.isFinite(inputTokensTotal)
    ? Math.max(inputTokensTotal, 0)
    : 0
  const derived = prompt + (promptExcludesCache ? read + write : 0)
  const total =
    normalized > 0
      ? Math.max(normalized, read)
      : // An unadjusted prefix report counts reads and writes on top of the
        // prompt, so their sum is a floor for any denominator derived here.
        Math.max(derived, read + write)
  if (total <= 0) return null

  const percent = roundPercent(Math.min((read / total) * 100, 100))
  const tier = getCacheRateTier(percent)
  return { percent, tier, label: CACHE_RATE_TIER_LABELS[tier] }
}

/** Cache rate for one usage log, or null when the log used no cache at all. */
export function getLogCacheRate(
  log: Pick<UsageLog, 'prompt_tokens'>,
  other: LogOtherData | null
): CacheRate | null {
  const promptTokens = log.prompt_tokens || 0
  const cacheReadTokens = other?.cache_tokens || 0
  const hasClaudeMarker = other?.claude === true
  // A Claude request relayed in OpenAI format keeps `prompt_tokens` excluding
  // the cache and carries no `claude` marker. The backend recognizes it by the
  // 5m/1h cache-write split (isLegacyClaudeDerivedOpenAIUsage), so mirror it.
  const looksClaudeDerived =
    !hasClaudeMarker &&
    ((other?.cache_creation_tokens_5m || 0) > 0 ||
      (other?.cache_creation_tokens_1h || 0) > 0)
  // Cache is a subset of the prompt otherwise, so a read count above the whole
  // prompt also means the upstream reported unadjusted prefixes.
  const promptExcludesCache =
    hasClaudeMarker || looksClaudeDerived || cacheReadTokens > promptTokens
  return calculateCacheRate(
    promptTokens,
    cacheReadTokens,
    getCacheWriteTokens(other),
    promptExcludesCache,
    other?.input_tokens_total || 0
  )
}
