/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { ModelCard } from '../components/model-card'
import { ModelDetailsContent } from '../components/model-details'
import { ModelRemainingUsage } from '../components/model-remaining-usage'
import { PricingTable } from '../components/pricing-table'
import type { PricingModel, PricingUsageSnapshot } from '../types'

vi.mock('@visactor/react-vchart', () => ({ VChart: () => null }))

const model: PricingModel = {
  id: 1,
  model_name: 'gpt-example',
  quota_type: 0,
  model_ratio: 1,
  completion_ratio: 3,
  enable_groups: ['default'],
  show_usage: true,
  usage_source: 'codex',
}

const snapshot: PricingUsageSnapshot = {
  source: 'codex',
  status: 'ok',
  windows: [
    { label: '5h', remaining_percent: 73 },
    { label: 'weekly', remaining_percent: 21 },
  ],
}

describe('remaining quota on the model square', () => {
  it('shows each remaining percentage on its own progress row on an opted-in model card', () => {
    render(<ModelCard model={model} usage={snapshot} onClick={vi.fn()} />)

    const fiveHour = screen.getByRole('group', { name: '5h' })
    const weekly = screen.getByRole('group', { name: 'Weekly' })
    expect(within(fiveHour).getByText('73%')).toBeVisible()
    expect(within(fiveHour).getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '73'
    )
    expect(within(weekly).getByText('21%')).toBeVisible()
    expect(within(weekly).getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '21'
    )
  })

  it('states when enabled usage has no current snapshot', () => {
    render(<ModelRemainingUsage model={model} />)

    expect(screen.getByText('Usage unavailable')).toBeVisible()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('does not show usage for a model with the switch off', () => {
    render(
      <ModelRemainingUsage
        model={{ ...model, show_usage: false }}
        usage={snapshot}
      />
    )

    expect(screen.queryByText('5h')).not.toBeInTheDocument()
    expect(screen.queryByText('Remaining usage')).not.toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('shows the same remaining windows in the pricing table', () => {
    render(
      <PricingTable
        models={[model]}
        usageByModel={{ [model.model_name]: snapshot }}
      />
    )

    expect(
      screen.getByRole('columnheader', { name: 'Remaining usage' })
    ).toBeVisible()
    expect(screen.getByText('73%')).toBeVisible()
  })

  it('shows remaining windows in model details', () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { success: true, data: {} },
    })
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ModelDetailsContent
          model={model}
          usage={snapshot}
          groupRatio={{}}
          usableGroup={{}}
          endpointMap={{}}
          autoGroups={[]}
          priceRate={1}
          usdExchangeRate={1}
          tokenUnit='M'
        />
      </QueryClientProvider>
    )

    expect(screen.getByText('73%')).toBeVisible()
    expect(screen.getByText('21%')).toBeVisible()
  })

  it('keeps Antigravity bucket labels attached to their own remaining amount', () => {
    render(
      <ModelRemainingUsage
        model={{ ...model, usage_source: 'antigravity' }}
        usage={{
          source: 'antigravity',
          status: 'ok',
          windows: [
            {
              bucket: 'gemini-pro-5h',
              label: 'gemini-pro-5h',
              remaining_amount: 2.5,
            },
          ],
        }}
      />
    )

    const bucket = screen.getByRole('group', { name: 'gemini-pro-5h' })
    expect(within(bucket).getByText('2.5')).toBeVisible()
    expect(within(bucket).queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('keeps each bucket reset time available on its own progress row', () => {
    render(
      <ModelRemainingUsage
        model={model}
        usage={{
          ...snapshot,
          windows: [
            { label: '5h', remaining_percent: 73, reset_at: 1792990000 },
            { label: 'weekly', remaining_percent: 21, reset_at: 1793100000 },
          ],
        }}
      />
    )

    const fiveHour = screen.getByRole('group', { name: '5h' })
    const weekly = screen.getByRole('group', { name: 'Weekly' })
    expect(fiveHour).toHaveAttribute(
      'title',
      expect.stringMatching(/Resets at/)
    )
    expect(weekly).toHaveAttribute('title', expect.stringMatching(/Resets at/))
  })
})
