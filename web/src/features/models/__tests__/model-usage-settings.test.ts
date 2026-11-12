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
import { describe, expect, it } from 'vitest'

import {
  MODEL_FORM_DEFAULT_VALUES,
  modelFormSchema,
  transformFormDataToModelPayload,
  transformModelToFormDefaults,
} from '../lib/model-form'
import type { Model } from '../types'

describe('model usage settings', () => {
  it('defaults usage display off for existing models', () => {
    const values = transformModelToFormDefaults({
      id: 7,
      model_name: 'gpt-example',
      status: 1,
      sync_official: 1,
      created_time: 1,
      updated_time: 1,
      name_rule: 0,
    } as Model)

    expect(values.show_usage).toBe(false)
    expect(values.usage_source).toBe('')
    expect(values.usage_channel_id).toBe(0)
    expect(values.usage_bucket_ids).toBe('')
  })

  it('requires a Codex channel ID when its usage is enabled', () => {
    const result = modelFormSchema.safeParse({
      ...MODEL_FORM_DEFAULT_VALUES,
      model_name: 'gpt-example',
      show_usage: true,
      usage_source: 'codex',
      usage_channel_id: 0,
    })

    expect(result.success).toBe(false)
  })

  it('allows Antigravity usage without a channel ID', () => {
    const result = modelFormSchema.safeParse({
      ...MODEL_FORM_DEFAULT_VALUES,
      model_name: 'gemini-example',
      show_usage: true,
      usage_source: 'antigravity',
      usage_channel_id: 0,
      usage_bucket_ids: 'gemini-weekly',
    })

    expect(result.success).toBe(true)
  })

  it('requires exact Antigravity bucket IDs when its usage is enabled', () => {
    const result = modelFormSchema.safeParse({
      ...MODEL_FORM_DEFAULT_VALUES,
      model_name: 'gemini-example',
      show_usage: true,
      usage_source: 'antigravity',
      usage_bucket_ids: '',
    })

    expect(result.success).toBe(false)
  })

  it('allows OpenDesign usage without a channel ID', () => {
    const result = modelFormSchema.safeParse({
      ...MODEL_FORM_DEFAULT_VALUES,
      model_name: 'od-example',
      show_usage: true,
      usage_source: 'opendesign',
      usage_channel_id: 0,
      usage_bucket_ids: 'od-5h,od-weekly',
    })

    expect(result.success).toBe(true)
  })

  it('requires OpenDesign bucket IDs when its usage is enabled', () => {
    const result = modelFormSchema.safeParse({
      ...MODEL_FORM_DEFAULT_VALUES,
      model_name: 'od-example',
      show_usage: true,
      usage_source: 'opendesign',
      usage_bucket_ids: '   ',
    })

    expect(result.success).toBe(false)
  })

  it('keeps OpenDesign bucket IDs in the save payload and drops them for Codex', () => {
    const openDesign = transformFormDataToModelPayload({
      ...MODEL_FORM_DEFAULT_VALUES,
      show_usage: true,
      usage_source: 'opendesign',
      usage_bucket_ids: ' od-5h , od-weekly ',
    })
    expect(openDesign).toMatchObject({
      show_usage: true,
      usage_source: 'opendesign',
      usage_channel_id: 0,
      usage_bucket_ids: 'od-5h , od-weekly',
    })

    const codex = transformFormDataToModelPayload({
      ...MODEL_FORM_DEFAULT_VALUES,
      show_usage: true,
      usage_source: 'codex',
      usage_channel_id: 42,
      usage_bucket_ids: 'od-5h',
    })
    expect(codex).toMatchObject({ usage_channel_id: 42, usage_bucket_ids: '' })
  })

  it('restores the OpenDesign source from a saved model', () => {
    const values = transformModelToFormDefaults({
      id: 8,
      model_name: 'od-example',
      status: 1,
      sync_official: 1,
      created_time: 1,
      updated_time: 1,
      name_rule: 0,
      show_usage: true,
      usage_source: 'opendesign',
      usage_bucket_ids: 'od-5h',
    } as Model)

    expect(values.usage_source).toBe('opendesign')
    expect(values.usage_bucket_ids).toBe('od-5h')
  })

  it('includes enabled usage settings in the model save payload', () => {
    const payload = transformFormDataToModelPayload({
      ...MODEL_FORM_DEFAULT_VALUES,
      show_usage: true,
      usage_source: 'codex',
      usage_channel_id: 42,
    })

    expect(payload).toMatchObject({
      show_usage: true,
      usage_source: 'codex',
      usage_channel_id: 42,
    })
  })
})
