import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: {
    getState: () => settings.state,
  },
}));

import { buildModelRequestHeaders, getCurrentModelConfig } from '@/lib/utils/model-config';

function setCurrentModel(args: { providerId: string; fast: boolean; serviceTiers?: string[] }) {
  settings.state = {
    providerId: args.providerId,
    modelId: 'gpt-test',
    codexFastMode: args.fast,
    thinkingConfigs: {},
    providersConfig: {
      [args.providerId]: {
        apiKey: 'key',
        baseUrl: 'https://example.test/v1',
        type: 'openai',
        models: [
          {
            id: 'gpt-test',
            name: 'GPT Test',
            capabilities: {
              ...(args.serviceTiers ? { serviceTiers: args.serviceTiers } : {}),
            },
          },
        ],
      },
    },
  };
}

describe('current model request configuration', () => {
  beforeEach(() => {
    setCurrentModel({
      providerId: 'openai-codex',
      fast: false,
      serviceTiers: ['priority'],
    });
  });

  it('selects priority only for an opted-in Codex model that advertises it', () => {
    setCurrentModel({
      providerId: 'openai-codex',
      fast: true,
      serviceTiers: ['priority'],
    });

    expect(getCurrentModelConfig().serviceTier).toBe('priority');

    setCurrentModel({ providerId: 'openai-codex', fast: false, serviceTiers: ['priority'] });
    expect(getCurrentModelConfig().serviceTier).toBeUndefined();

    setCurrentModel({ providerId: 'openai-codex', fast: true });
    expect(getCurrentModelConfig().serviceTier).toBeUndefined();

    setCurrentModel({ providerId: 'openai', fast: true, serviceTiers: ['priority'] });
    expect(getCurrentModelConfig().serviceTier).toBeUndefined();
  });

  it('builds the shared model headers and omits the tier in standard mode', () => {
    setCurrentModel({
      providerId: 'openai-codex',
      fast: true,
      serviceTiers: ['priority'],
    });
    expect(buildModelRequestHeaders(getCurrentModelConfig())).toEqual({
      'x-model': 'openai-codex:gpt-test',
      'x-api-key': 'key',
      'x-base-url': 'https://example.test/v1',
      'x-provider-type': 'openai',
      'x-service-tier': 'priority',
    });

    setCurrentModel({
      providerId: 'openai-codex',
      fast: false,
      serviceTiers: ['priority'],
    });
    expect(buildModelRequestHeaders(getCurrentModelConfig())).not.toHaveProperty('x-service-tier');
  });
});
