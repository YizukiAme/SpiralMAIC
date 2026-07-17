import { describe, expect, it, vi } from 'vitest';

import { wrapCodexLanguageModel } from '@/lib/ai/codex-model';
import { getModel } from '@/lib/ai/providers';
import {
  CODEX_RESPONSES_ENDPOINT,
  createCodexResponsesTransport,
} from '@/lib/server/codex/transport';
import {
  CODEX_OAUTH_ERROR_CODES,
  CodexOAuthError,
  type CodexTokenProvider,
} from '@/lib/server/codex/token-provider';

type LanguageModelV3 = Parameters<typeof wrapCodexLanguageModel>[0];
const SAFE_STREAM_ERROR_MESSAGE = 'Codex response stream could not be processed';

function createEventStreamResponse(events: Array<Record<string, unknown>>): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function collectStream(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const parts: unknown[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return parts;
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function createModelForResponse(response: () => Response) {
  const tokenProvider = {
    getValidCredentials: vi.fn(async () => ({
      accessToken: 'access-token',
      accountId: 'account-id',
    })),
  } satisfies CodexTokenProvider;
  const upstreamFetch = vi.fn<typeof fetch>(async () => response());
  const customFetch = createCodexResponsesTransport({ tokenProvider, upstreamFetch });
  const { model } = getModel({
    providerId: 'openai-codex',
    modelId: 'gpt-5.4',
    apiKey: '',
    customFetch,
  });
  return { model: model as LanguageModelV3, tokenProvider, upstreamFetch };
}

describe('Codex provider and OpenAI SDK integration', () => {
  it('keeps credentials cleared before the request as a safe 401 through SDK middleware', async () => {
    const tokenProvider = {
      getValidCredentials: vi.fn(async () => {
        throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.CREDENTIALS_MISSING, false);
      }),
    } satisfies CodexTokenProvider;
    const upstreamFetch = vi.fn<typeof fetch>();
    const customFetch = createCodexResponsesTransport({ tokenProvider, upstreamFetch });
    const { model } = getModel({
      providerId: 'openai-codex',
      modelId: 'gpt-5.4',
      apiKey: '',
      customFetch,
    });

    const error = await Promise.resolve(
      (model as LanguageModelV3).doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: 'CodexStreamError',
      message: SAFE_STREAM_ERROR_MESSAGE,
      statusCode: 401,
    });
    expect(error).not.toHaveProperty('cause');
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    [CODEX_OAUTH_ERROR_CODES.CREDENTIALS_MISSING, undefined],
    [CODEX_OAUTH_ERROR_CODES.SIGNED_OUT, undefined],
    [CODEX_OAUTH_ERROR_CODES.INVALID_GRANT, undefined],
    [CODEX_OAUTH_ERROR_CODES.REFRESH_REJECTED, undefined],
    [CODEX_OAUTH_ERROR_CODES.REFRESH_REJECTED, 403],
    [CODEX_OAUTH_ERROR_CODES.REFRESH_REJECTED, 429],
  ] as const)(
    'classifies a %s refresh failure with upstream status %s as safe 401 through SDK middleware',
    async (code, upstreamStatus) => {
      const tokenProvider = {
        getValidCredentials: vi.fn(async () => ({
          accessToken: 'old-token',
          accountId: 'account-id',
        })),
        refreshIfCurrent: vi.fn(async () => {
          throw new CodexOAuthError(code, false, upstreamStatus);
        }),
      };
      const upstreamFetch = vi.fn<typeof fetch>(async () =>
        Promise.resolve(new Response('private-upstream-body', { status: 401 })),
      );
      const customFetch = createCodexResponsesTransport({ tokenProvider, upstreamFetch });
      const { model } = getModel({
        providerId: 'openai-codex',
        modelId: 'gpt-5.4',
        apiKey: '',
        customFetch,
      });

      const error = await Promise.resolve(
        (model as LanguageModelV3).doStream({
          prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        }),
      ).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        name: 'CodexStreamError',
        message: SAFE_STREAM_ERROR_MESSAGE,
        statusCode: 401,
      });
      expect(error).not.toHaveProperty('cause');
      expect(String(error)).not.toContain('private-upstream-body');
      expect(upstreamFetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [CODEX_OAUTH_ERROR_CODES.NETWORK_ERROR, true],
    [CODEX_OAUTH_ERROR_CODES.UPSTREAM_ERROR, true],
    [CODEX_OAUTH_ERROR_CODES.INVALID_RESPONSE, false],
    [CODEX_OAUTH_ERROR_CODES.STORAGE_ERROR, false],
  ] as const)(
    'does not misclassify a %s refresh failure as 401 through SDK middleware',
    async (code, retryable) => {
      const tokenProvider = {
        getValidCredentials: vi.fn(async () => ({
          accessToken: 'old-token',
          accountId: 'account-id',
        })),
        refreshIfCurrent: vi.fn(async () => {
          throw new CodexOAuthError(code, retryable);
        }),
      };
      const upstreamFetch = vi.fn<typeof fetch>(async () =>
        Promise.resolve(new Response('private-upstream-body', { status: 401 })),
      );
      const customFetch = createCodexResponsesTransport({ tokenProvider, upstreamFetch });
      const { model } = getModel({
        providerId: 'openai-codex',
        modelId: 'gpt-5.4',
        apiKey: '',
        customFetch,
      });

      const error = await Promise.resolve(
        (model as LanguageModelV3).doStream({
          prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        }),
      ).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        name: 'CodexStreamError',
        message: SAFE_STREAM_ERROR_MESSAGE,
      });
      expect(error).not.toHaveProperty('statusCode');
      expect(error).not.toHaveProperty('cause');
      expect(String(error)).not.toContain('private-upstream-body');
      expect(upstreamFetch).toHaveBeenCalledTimes(1);
    },
  );

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

    const error = await Promise.resolve(
      (model as LanguageModelV3).doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: 'CodexStreamError',
      message: SAFE_STREAM_ERROR_MESSAGE,
      statusCode: 403,
    });
    expect(error).not.toHaveProperty('cause');
    expect(Object.keys(error as object)).toEqual([]);

    // Unmanaged providers are checked at acquire, immediately before send, and after headers.
    expect(tokenProvider.getValidCredentials).toHaveBeenCalledTimes(3);
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
    expect(JSON.parse(init?.body as string)).not.toHaveProperty('service_tier');
  });

  it('maps the Codex priority option to the real Responses service_tier field', async () => {
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
      serviceTier: 'priority',
    });

    await Promise.resolve(
      (model as LanguageModelV3).doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      }),
    ).catch(() => undefined);

    const [, init] = upstreamFetch.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toMatchObject({ service_tier: 'priority' });
  });

  it.each(['stream', 'generate'] as const)(
    'sanitizes a status-200 early SSE error on the real SDK %s path',
    async (path) => {
      const upstreamSecret = 'status-200-early-error-secret';
      const { model } = createModelForResponse(() =>
        createEventStreamResponse([
          {
            type: 'error',
            sequence_number: 0,
            code: '500',
            message: upstreamSecret,
            param: null,
          },
        ]),
      );
      const options = {
        prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }],
      };

      const error = await Promise.resolve(
        path === 'stream' ? model.doStream(options) : model.doGenerate(options),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        name: 'CodexStreamError',
        message: SAFE_STREAM_ERROR_MESSAGE,
      });
      expect(error).not.toHaveProperty('cause');
      expect(error).not.toHaveProperty('responseBody');
      expect(String(error)).not.toContain(upstreamSecret);
    },
  );

  it('sanitizes a status-200 SSE error part after real SDK output has begun', async () => {
    const upstreamSecret = 'status-200-late-error-secret';
    const { model } = createModelForResponse(() =>
      createEventStreamResponse([
        {
          type: 'response.output_text.delta',
          item_id: 'message-1',
          delta: 'hello',
          logprobs: null,
        },
        {
          type: 'error',
          sequence_number: 1,
          code: '500',
          message: upstreamSecret,
          param: null,
        },
      ]),
    );

    const result = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    });
    const parts = await collectStream(result.stream);
    const errorPart = parts.find(
      (part): part is { type: 'error'; error: unknown } =>
        (part as { type?: string }).type === 'error',
    );

    expect(parts).toContainEqual({ type: 'text-delta', id: 'message-1', delta: 'hello' });
    expect(errorPart?.error).toBeInstanceOf(Error);
    expect(errorPart?.error).toMatchObject({
      name: 'CodexStreamError',
      message: SAFE_STREAM_ERROR_MESSAGE,
    });
    expect(String(errorPart?.error)).not.toContain(upstreamSecret);
  });

  it.each([
    {
      name: 'a malformed item id',
      secret: 'streaming-secret-id',
      frame: {
        type: 'response.output_text.delta',
        item_id: { value: 'streaming-secret-id' },
        delta: 'ignored',
        logprobs: null,
      },
    },
    {
      name: 'an unknown event type',
      secret: 'streaming-secret-type',
      frame: { type: 'streaming-secret-type', sequence_number: 1 },
    },
  ])(
    'does not expose $name dropped by the real SDK parser during streaming',
    async ({ frame, secret }) => {
      const { model } = createModelForResponse(() =>
        createEventStreamResponse([
          {
            type: 'response.output_text.delta',
            item_id: 'message-1',
            delta: 'hello',
            logprobs: null,
          },
          frame,
        ]),
      );

      const result = await model.doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      });
      const parts = await collectStream(result.stream);
      expect(parts).toContainEqual({ type: 'text-delta', id: 'message-1', delta: 'hello' });
      expect(
        parts.some((part) => {
          const value = part as { error?: unknown };
          return (
            (JSON.stringify(part) ?? '').includes(secret) ||
            String(value.error ?? '').includes(secret)
          );
        }),
      ).toBe(false);
    },
  );
});
