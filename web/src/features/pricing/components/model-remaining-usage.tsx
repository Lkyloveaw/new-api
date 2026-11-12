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
*/
import { useTranslation } from 'react-i18next'

import { Progress } from '@/components/ui/progress'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber, formatTimestampToDate } from '@/lib/format'
import { cn } from '@/lib/utils'

import type { PricingModel, PricingUsageSnapshot } from '../types'

export function ModelRemainingUsage(props: {
  model: PricingModel
  usage?: PricingUsageSnapshot
  isLoading?: boolean
  compact?: boolean
}) {
  const { t, i18n } = useTranslation()
  if (!props.model.show_usage) return null

  const windows = props.usage?.status === 'ok' ? props.usage.windows : []
  const locale = toIntlLocale(i18n.language)
  let content: React.ReactNode

  if (props.isLoading) {
    content = <p className='text-muted-foreground'>{t('Loading usage...')}</p>
  } else if (windows.length === 0) {
    content = <p className='text-muted-foreground'>{t('Usage unavailable')}</p>
  } else {
    content = (
      <div className={props.compact ? 'space-y-2' : 'space-y-3'}>
        {windows.map((window) => {
          const label =
            window.label.toLowerCase() === 'weekly' ? t('Weekly') : window.label
          const remainingPercent =
            window.remaining_percent != null &&
            Number.isFinite(window.remaining_percent)
              ? Math.min(100, Math.max(0, window.remaining_percent))
              : null
          let amount = t('Unavailable')
          if (remainingPercent != null) {
            amount = `${formatNumber(remainingPercent, locale)}%`
          } else if (window.remaining_amount != null) {
            amount = formatNumber(window.remaining_amount, locale)
          }
          let progressColor = 'text-emerald-500'
          if (remainingPercent != null && remainingPercent <= 10) {
            progressColor = 'text-rose-500'
          } else if (remainingPercent != null && remainingPercent <= 30) {
            progressColor = 'text-amber-500'
          }
          return (
            <div
              key={`${window.bucket ?? window.label}-${window.reset_at ?? ''}`}
              role='group'
              aria-label={label}
              className='min-w-0 space-y-1'
              title={
                window.reset_at
                  ? t('Resets at {{time}}', {
                      time: formatTimestampToDate(window.reset_at),
                    })
                  : undefined
              }
            >
              <div className='flex min-w-0 items-start justify-between gap-2'>
                <span className='text-muted-foreground min-w-0 flex-1 break-all'>
                  {label}
                </span>
                <span className='shrink-0 font-mono font-semibold whitespace-nowrap tabular-nums'>
                  {amount}
                </span>
              </div>
              {remainingPercent != null && (
                <Progress
                  value={remainingPercent}
                  aria-label={`${label} ${t('Remaining usage')}`}
                  className={cn(
                    'w-full [&_[data-slot=progress-track]]:h-1.5 [&_[data-slot=progress-indicator]]:bg-current',
                    progressColor
                  )}
                />
              )}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div
      role='group'
      aria-label={t('Remaining usage')}
      className='min-w-0 space-y-1.5 text-xs'
    >
      <p className='text-muted-foreground font-medium'>
        {t('Remaining usage')}
      </p>
      {content}
    </div>
  )
}
