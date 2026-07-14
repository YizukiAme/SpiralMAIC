import { describe, expect, it, vi } from 'vitest';

import { wrapCodexLanguageModel } from '@/lib/ai/codex-model';
import { getModel } from '@/lib/ai/providers';
import {
  CODEX_RESPONSES_ENDPOINT,
  createCodexResponsesTransport,
} from '@/lib/server/codex/transport';
import type { CodexTokenProvider } from '@/lib/server/codex/token-provider';

type LanguageModelV3 = Parameters<typeof wrapCodexLanguageModel>[0];

describe('Codex provider and OpenAI SDK integration', () => {
  it('reaches the exact allowlisted endpoint through the real Responses client', async () => {
    const tokenProvider = {
      getValidCredentials: vi.fn(async () => ({
        accessToken: 'access-token',
        accountId: 'account-id',
      })),
    } satisfies CodexTokenProvider;
    const upstreamFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 403 }));
    const customFetch = createCodexResponsesTransport({ tokenProvider, upstreamFetch });
    const { model } = getModel({
      providerId: 'openai-codex',
      modelId: 'gpt-5.4',
      apiKey: '',
      customFetch,
    });

    await expect(
      Promise.resolve(
        (model as LanguageModelV3).doStream({
          prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        }),
      ),
    ).rejects.toBeDefined();

    expect(tokenProvider.getValidCredentials).toHaveBeenCalledTimes(1);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    const [url, init] = upstreamFetch.mock.calls[0]!;
    expect(url).toBe(CODEX_RESPONSES_ENDPOINT);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toMatchObject({
      model: 'gpt-5.4',
      store: false,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
      include: ['reasoning.encrypted_content'],
    });
  });
});
