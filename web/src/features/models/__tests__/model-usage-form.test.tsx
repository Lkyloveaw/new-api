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
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { ModelMutateDrawer } from '../components/drawers/model-mutate-drawer'

afterEach(() => vi.restoreAllMocks())

describe('model usage settings in the metadata drawer', () => {
  it('reveals provider-specific configuration only after enabling display', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { success: true, data: { items: [] } },
    })
    const user = userEvent.setup()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ModelMutateDrawer open onOpenChange={vi.fn()} />
      </QueryClientProvider>
    )

    const toggle = screen.getByRole('switch', { name: 'Show remaining usage' })
    expect(toggle).not.toBeChecked()
    expect(
      screen.queryByRole('combobox', { name: 'Usage source' })
    ).not.toBeInTheDocument()

    await user.click(toggle)
    expect(screen.getByRole('combobox', { name: 'Usage source' })).toBeVisible()

    await user.click(screen.getByRole('combobox', { name: 'Usage source' }))
    await user.click(screen.getByRole('option', { name: 'Codex OAuth' }))
    expect(screen.getByLabelText('Codex channel ID')).toBeVisible()
    expect(
      screen.queryByLabelText('Antigravity quota bucket IDs')
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole('combobox', { name: 'Usage source' }))
    await user.click(screen.getByRole('option', { name: 'Antigravity' }))
    expect(screen.getByLabelText('Antigravity quota bucket IDs')).toBeVisible()
    expect(screen.queryByLabelText('Codex channel ID')).not.toBeInTheDocument()
  })
})
