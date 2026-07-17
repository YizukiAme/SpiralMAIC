import { describe, expect, it, vi } from 'vitest';

const openAiMocks = vi.hoisted(() => {
  const model = {
    specificationVersion: 'v3' as const,
    provider: 'openai.responses',
    modelId: 'gpt-5.4',
    supportedUrls: {},
    doGenerate: vi.fn(async () => ({
      content: [],
      finishReason: { unified: 'stop' as const, raw: 'completed' },
      usage: {
        inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 0, text: 0, reasoning: 0 },
      },
      warnings: [],
    })),
    doStream: vi.fn(),
  };
  const responses = vi.fn(() => model);
  const chat = vi.fn(() => model);
  const createOpenAI = vi.fn(() => ({ responses, chat }));
  return { model, responses, chat, createOpenAI };
});

vi.mock('@ai-sdk/openai', () => ({ createOpenAI: openAiMocks.createOpenAI }));

import { getModel, PROVIDERS } from '@/lib/ai/providers';

describe('native Codex provider seam', () => {
  it('registers OAuth credentials and rejects disconnected model construction', () => {
    expect(PROVIDERS['openai-codex']).toMatchObject({
      id: 'openai-codex',
      name: 'Codex',
      type: 'openai',
      credentialMode: 'oauth',
      requiresApiKey: false,
      models: [
        { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
        { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
        { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
        { id: 'gpt-5.5', name: 'GPT-5.5' },
        { id: 'gpt-5.2', name: 'GPT-5.2' },
      ],
    });

    expect(() =>
      getModel({
        providerId: 'openai-codex',
        modelId: 'gpt-5.4',
        apiKey: '',
      }),
    ).toThrow(/server transport/i);
  });

  it('uses only the audited Codex snapshot without overlaying public OpenAI metadata', () => {
    expect(
      PROVIDERS['openai-codex'].models.map((model) => [
        model.id,
        model.contextWindow,
        model.outputWindow,
      ]),
    ).toEqual([
      ['gpt-5.6-sol', 372_000, undefined],
      ['gpt-5.6-terra', 372_000, undefined],
      ['gpt-5.6-luna', 372_000, undefined],
      ['gpt-5.5', 272_000, undefined],
      ['gpt-5.2', 272_000, undefined],
    ]);
    expect(PROVIDERS.openai.models.find((model) => model.id === 'gpt-5.5')?.contextWindow).not.toBe(
      PROVIDERS['openai-codex'].models.find((model) => model.id === 'gpt-5.5')?.contextWindow,
    );
  });

  it('exposes the account-verified reasoning controls for GPT-5.6 Codex models', () => {
    const expectations = {
      'gpt-5.6-sol': 'low',
      'gpt-5.6-terra': 'medium',
      'gpt-5.6-luna': 'medium',
    } as const;

    for (const [modelId, defaultEffort] of Object.entries(expectations)) {
      expect(PROVIDERS['openai-codex'].models.find((model) => model.id === modelId)).toMatchObject({
        id: modelId,
        contextWindow: 372_000,
        capabilities: {
          streaming: true,
          tools: true,
          vision: true,
          thinking: {
            control: 'effort',
            requestAdapter: 'openai',
            effortValues: ['low', 'medium', 'high', 'xhigh', 'max'],
            defaultEffort,
          },
        },
        source: 'probed',
      });
    }
  });

  it('always uses Responses with the injected transport and fixed non-secret SDK settings', () => {
    const transport = vi.fn<typeof fetch>();

    const { model } = getModel({
      providerId: 'openai-codex',
      modelId: 'gpt-5.4',
      apiKey: 'client-must-be-ignored',
      baseUrl: 'https://attacker.example/v1',
      proxy: 'http://attacker-proxy.example',
      customFetch: transport,
    });

    expect(openAiMocks.createOpenAI).toHaveBeenLastCalledWith({
      apiKey: 'openmaic-codex-oauth',
      baseURL: 'https://chatgpt.com/backend-api/codex',
      fetch: transport,
    });
    expect(openAiMocks.responses).toHaveBeenCalledWith('gpt-5.4');
    expect(openAiMocks.chat).not.toHaveBeenCalled();
    expect(model).not.toBe(openAiMocks.model);
  });
});
