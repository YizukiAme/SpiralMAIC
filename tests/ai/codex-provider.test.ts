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
        { id: 'gpt-5.4', name: 'GPT-5.4' },
        { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
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

  it('clones the OpenAI catalog metadata for every Codex fallback model', () => {
    for (const modelId of ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']) {
      const openai = PROVIDERS.openai.models.find((model) => model.id === modelId);
      const codex = PROVIDERS['openai-codex'].models.find((model) => model.id === modelId);

      expect(openai).toBeDefined();
      expect(codex).toMatchObject({
        id: modelId,
        contextWindow: openai?.contextWindow,
        outputWindow: openai?.outputWindow,
        capabilities: openai?.capabilities,
        source: 'probed',
      });
      expect(codex).not.toBe(openai);
      expect(codex?.capabilities).not.toBe(openai?.capabilities);

      const openaiThinking = openai?.capabilities?.thinking;
      const codexThinking = codex?.capabilities?.thinking;
      expect(codexThinking).toEqual(openaiThinking);
      expect(codexThinking).not.toBe(openaiThinking);
      if (openaiThinking?.effortValues) {
        expect(codexThinking?.effortValues).toEqual(openaiThinking.effortValues);
        expect(codexThinking?.effortValues).not.toBe(openaiThinking.effortValues);
      }
      if (openaiThinking?.levelValues) {
        expect(codexThinking?.levelValues).toEqual(openaiThinking.levelValues);
        expect(codexThinking?.levelValues).not.toBe(openaiThinking.levelValues);
      }
      if (openaiThinking?.budgetRange) {
        expect(codexThinking?.budgetRange).toEqual(openaiThinking.budgetRange);
        expect(codexThinking?.budgetRange).not.toBe(openaiThinking.budgetRange);
      }
      if (openaiThinking?.anthropicThinking) {
        expect(codexThinking?.anthropicThinking).toEqual(openaiThinking.anthropicThinking);
        expect(codexThinking?.anthropicThinking).not.toBe(openaiThinking.anthropicThinking);
        if (openaiThinking.anthropicThinking.budgetByEffort) {
          expect(codexThinking?.anthropicThinking?.budgetByEffort).not.toBe(
            openaiThinking.anthropicThinking.budgetByEffort,
          );
        }
      }
    }
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
        contextWindow: 272_000,
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
