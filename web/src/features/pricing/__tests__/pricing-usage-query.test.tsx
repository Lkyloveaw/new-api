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
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getPricingUsage } from '../api'
import { usePricingUsage } from '../hooks/use-pricing-usage'
import type { PricingModel } from '../types'

vi.mock('../api', () => ({ getPricingUsage: vi.fn() }))

const disabledModel = {
  id: 1,
  model_name: 'gpt-example',
  quota_type: 0,
  model_ratio: 1,
  completion_ratio: 1,
  enable_groups: ['default'],
  show_usage: false,
} satisfies PricingModel

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  )
}

describe('pricing usage query', () => {
  beforeEach(() => {
    vi.mocked(getPricingUsage).mockReset()
    vi.mocked(getPricingUsage).mockResolvedValue({
      success: true,
      data: {
        'gpt-example': {
          source: 'codex',
          status: 'ok',
          windows: [{ label: '5h', remaining_percent: 70 }],
        },
      },
    })
  })

  it('skips the request while every model has usage display disabled', async () => {
    renderHook(() => usePricingUsage([disabledModel]), { wrapper })
    await Promise.resolve()
    expect(getPricingUsage).not.toHaveBeenCalled()
  })

  it('loads one shared snapshot when at least one model opts in', async () => {
    const { result } = renderHook(
      () =>
        usePricingUsage([
          { ...disabledModel, show_usage: true },
          { ...disabledModel, id: 2, model_name: 'other', show_usage: true },
        ]),
      { wrapper }
    )

    await waitFor(() => {
      expect(
        result.current.usageByModel['gpt-example']?.windows[0].remaining_percent
      ).toBe(70)
    })
    expect(getPricingUsage).toHaveBeenCalledTimes(1)
  })
})
