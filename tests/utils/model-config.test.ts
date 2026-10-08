import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ fast: false, view: undefined as unknown }));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: () => ({ codexFastMode: state.fast }) },
}));
vi.mock('@/lib/model-settings/client', () => ({
  modelSettingsClient: { getState: () => ({ view: state.view }) },
}));
import {
  buildModelRequestHeaders,
  getCurrentModelConfig,
  getStageRoutesHeaderValue,
} from '@/lib/utils/model-config';

describe('client-safe model compatibility', () => {
  beforeEach(() => {
    state.fast = false;
    state.view = {
      slots: [
        {
          slot: 'llm',
          assignment: { model: 'subscription:gpt-live', thinking: { enabled: false } },
          effective: {
            status: 'assigned',
            registryId: 'openai-codex',
            modelId: 'gpt-live',
            resolvedAt: 'llm',
          },
        },
      ],
    };
  });

  it('reads metadata from the effective server slot without exposing credentials', () => {
    expect(getCurrentModelConfig()).toMatchObject({
      providerId: 'openai-codex',
      modelId: 'gpt-live',
      modelString: 'openai-codex:gpt-live',
      apiKey: '',
      baseUrl: '',
      providerType: undefined,
      thinkingConfig: { enabled: false },
      isServerConfigured: true,
    });
  });

  it('sends only the Fast preference, leaving route selection and tier support to the server', () => {
    state.fast = true;
    expect(buildModelRequestHeaders(getCurrentModelConfig())).toEqual({
      'x-service-tier': 'priority',
    });
    expect(
      buildModelRequestHeaders({
        modelString: 'injected:model',
        apiKey: 'secret',
        baseUrl: 'https://injected.test',
        providerType: 'openai',
      }),
    ).toEqual({});
    expect(getStageRoutesHeaderValue()).toBeUndefined();
  });

  it('does not treat an unavailable slot as a configured model', () => {
    state.view = {
      slots: [{ slot: 'llm', effective: { status: 'invalid', message: 'Reconnect' } }],
    };
    expect(getCurrentModelConfig().isServerConfigured).toBe(false);
    expect(getCurrentModelConfig().modelString).toBe('');
    state.view = undefined;
    expect(buildModelRequestHeaders()).toEqual({});
  });
});
