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
      name: 'ChatGPT Codex',
      type: 'openai',
      credentialMode: 'oauth',
      requiresApiKey: false,
    });

    expect(() =>
      getModel({
        providerId: 'openai-codex',
        modelId: 'gpt-5.4',
        apiKey: '',
      }),
    ).toThrow(/server transport/i);
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
