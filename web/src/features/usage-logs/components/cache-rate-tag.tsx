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
import { useTranslation } from 'react-i18next'

import { formatPercent } from '@/lib/format'
import { cn } from '@/lib/utils'

import type { CacheRate, CacheRateTier } from '../lib/cache-rate'

const TIER_CLASSES: Record<CacheRateTier, string> = {
  low: 'text-destructive',
  medium: 'text-warning',
  high: 'text-success',
}

/**
 * Cache-read share of the request input, shown in place of the raw cache token
 * counts on the log list and the mobile summary. The tier marker is a fixed
 * operator-defined string; only the "Cache Rate" label is translated.
 */
export function CacheRateTag(props: { rate: CacheRate; className?: string }) {
  const { t } = useTranslation()
  return (
    <span
      className={cn(TIER_CLASSES[props.rate.tier], props.className)}
      title={`${t('Cache Rate')} ${formatPercent(props.rate.percent)}`}
    >
      {t('Cache Rate')} {props.rate.label}{' '}
      <span className='tabular-nums'>{formatPercent(props.rate.percent)}</span>
    </span>
  )
}
