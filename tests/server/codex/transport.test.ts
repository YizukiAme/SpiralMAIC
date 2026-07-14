import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_RESPONSES_ENDPOINT,
  CodexResponsesTransportError,
  createCodexResponsesTransport,
} from '@/lib/server/codex/transport';
import type { CodexTokenProvider } from '@/lib/server/codex/token-provider';

function createTokenProvider() {
  return {
    getValidCredentials: vi.fn(async () => ({
      accessToken: 'access-token',
      accountId: 'account-id',
    })),
  } satisfies CodexTokenProvider;
}

function successfulResponse(): Response {
  return new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Codex Responses transport boundary', () => {
  it.each([
    'http://chatgpt.com/backend-api/codex/responses',
    'https://chatgpt.com:443/backend-api/codex/responses',
    'https://CHATGPT.com/backend-api/codex/responses',
    'https://chatgpt.com/backend-api/codex/responses/',
    'https://chatgpt.com/backend-api/codex/responses?next=true',
    'https://chatgpt.com/backend-api/codex/responses#fragment',
    'https://chatgpt.com/backend-api/codex/models',
  ])('rejects non-literal endpoint %s before loading credentials', async (endpoint) => {
    const tokenProvider = createTokenProvider();
    const upstreamFetch = vi.fn(async () => successfulResponse());
    const transport = createCodexResponsesTransport({ tokenProvider, upstreamFetch });

    await expect(transport(endpoint, { method: 'POST', body: '{}' })).rejects.toMatchObject({
      code: 'INVALID_ENDPOINT',
    });
    expect(tokenProvider.getValidCredentials).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    new URL(CODEX_RESPONSES_ENDPOINT),
    new Request(CODEX_RESPONSES_ENDPOINT, { method: 'POST', body: '{}' }),
  ])('rejects URL and Request inputs before loading credentials', async (input) => {
    const tokenProvider = createTokenProvider();
    const upstreamFetch = vi.fn(async () => successfulResponse());
    const transport = createCodexResponsesTransport({ tokenProvider, upstreamFetch });

    await expect(transport(input, { method: 'POST', body: '{}' })).rejects.toMatchObject({
      code: 'INVALID_ENDPOINT',
    });
    expect(tokenProvider.getValidCredentials).not.toHaveBeenCalled();
  });

  it('normalizes body and replaces caller-controlled identity headers', async () => {
    const tokenProvider = createTokenProvider();
    const upstreamFetch = vi.fn(async () => successfulResponse());
    const transport = createCodexResponsesTransport({ tokenProvider, upstreamFetch });

    const response = await transport(CODEX_RESPONSES_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: 'Bearer attacker-token',
        'chatgpt-account-id': 'attacker-account',
        'content-type': 'application/json',
        originator: 'attacker',
        'session-id': 'account-id',
        'user-agent': 'attacker-agent',
      },
      body: JSON.stringify({
        store: true,
        input: [
          { role: 'system', content: [{ type: 'input_text', text: 'OpenMAIC prompt' }] },
          { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
        ],
        include: ['message.output_text.logprobs'],
        max_output_tokens: 100,
        max_tokens: 101,
        max_completion_tokens: 102,
        temperature: 0.2,
        top_p: 0.8,
        top_k: 20,
        presence_penalty: 1,
        frequency_penalty: 1,
        logprobs: true,
        top_logprobs: 5,
        logit_bias: { '1': 2 },
        seed: 7,
      }),
    });

    expect(response.status).toBe(200);
    expect(tokenProvider.getValidCredentials).toHaveBeenCalledWith();
    expect(upstreamFetch).toHaveBeenCalledTimes(1);

    const [url, init] = upstreamFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CODEX_RESPONSES_ENDPOINT);
    expect(init.redirect).toBe('manual');

    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer access-token');
    expect(headers.get('chatgpt-account-id')).toBe('account-id');
    expect(headers.get('originator')).toBe('openmaic');
    expect(headers.get('user-agent')).toMatch(/^OpenMAIC\/0\.3\.0/);
    expect(headers.get('session-id')).toBeTruthy();
    expect(headers.get('session-id')).not.toBe('account-id');
    expect(headers.get('content-type')).toBe('application/json');

    const body = JSON.parse(init.body as string) as Record<string, unknown> & {
      input: Array<Record<string, unknown>>;
      include: string[];
    };
    expect(body.store).toBe(false);
    expect(body.input[0]).toMatchObject({ role: 'developer' });
    expect(body.input[0].content).toEqual([{ type: 'input_text', text: 'OpenMAIC prompt' }]);
    expect(body.include).toEqual(
      expect.arrayContaining(['message.output_text.logprobs', 'reasoning.encrypted_content']),
    );
    for (const key of [
      'max_output_tokens',
      'max_tokens',
      'max_completion_tokens',
      'temperature',
      'top_p',
      'top_k',
      'presence_penalty',
      'frequency_penalty',
      'logprobs',
      'top_logprobs',
      'logit_bias',
      'seed',
    ]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it('uses one process-stable session id across transport instances', async () => {
    const upstreamFetch = vi.fn<typeof fetch>(async () => successfulResponse());
    const first = createCodexResponsesTransport({
      tokenProvider: createTokenProvider(),
      upstreamFetch,
    });
    const second = createCodexResponsesTransport({
      tokenProvider: createTokenProvider(),
      upstreamFetch,
    });

    await first(CODEX_RESPONSES_ENDPOINT, { method: 'POST', body: '{}' });
    await second(CODEX_RESPONSES_ENDPOINT, { method: 'POST', body: '{}' });

    const firstHeaders = new Headers(upstreamFetch.mock.calls[0]?.[1]?.headers);
    const secondHeaders = new Headers(upstreamFetch.mock.calls[1]?.[1]?.headers);
    expect(firstHeaders.get('session-id')).toBeTruthy();
    expect(secondHeaders.get('session-id')).toBe(firstHeaders.get('session-id'));
  });
});

describe('Codex Responses transport failures', () => {
  it('refreshes and replays exactly once after a 401', async () => {
    const getValidCredentials = vi
      .fn<CodexTokenProvider['getValidCredentials']>()
      .mockResolvedValueOnce({ accessToken: 'old-token', accountId: 'account-id' })
      .mockResolvedValueOnce({ accessToken: 'new-token', accountId: 'account-id' });
    const upstreamFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('secret upstream body', { status: 401 }))
      .mockResolvedValueOnce(successfulResponse());
    const transport = createCodexResponsesTransport({
      tokenProvider: { getValidCredentials },
      upstreamFetch,
    });

    await expect(
      transport(CODEX_RESPONSES_ENDPOINT, { method: 'POST', body: '{}' }),
    ).resolves.toMatchObject({ status: 200 });

    expect(getValidCredentials).toHaveBeenNthCalledWith(1);
    expect(getValidCredentials).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
    expect(new Headers(upstreamFetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer old-token',
    );
    expect(new Headers(upstreamFetch.mock.calls[1]?.[1]?.headers).get('authorization')).toBe(
      'Bearer new-token',
    );
  });

  it.each([
    [401, 'AUTH_REQUIRED'],
    [403, 'WORKSPACE_FORBIDDEN'],
    [429, 'RATE_LIMITED'],
    [302, 'UPSTREAM_ERROR'],
    [500, 'UPSTREAM_ERROR'],
  ] as const)('maps final status %s to safe %s without leaking the body', async (status, code) => {
    const tokenProvider = createTokenProvider();
    const upstreamFetch = vi.fn(async () =>
      Promise.resolve(new Response('upstream-secret-token account-id', { status })),
    );
    const transport = createCodexResponsesTransport({ tokenProvider, upstreamFetch });

    const error = await transport(CODEX_RESPONSES_ENDPOINT, {
      method: 'POST',
      body: '{}',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CodexResponsesTransportError);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain('upstream-secret-token');
    expect(String(error)).not.toContain('account-id');
    expect(upstreamFetch).toHaveBeenCalledTimes(status === 401 ? 2 : 1);
    expect(tokenProvider.getValidCredentials).toHaveBeenCalledTimes(status === 401 ? 2 : 1);
  });

  it('maps network failures without logging credentials', async () => {
    const consoleSpies = [
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
    ];
    const tokenProvider = createTokenProvider();
    const upstreamFetch = vi.fn(async () => {
      throw new Error('network failed access-token account-id');
    });
    const transport = createCodexResponsesTransport({ tokenProvider, upstreamFetch });

    const error = await transport(CODEX_RESPONSES_ENDPOINT, {
      method: 'POST',
      body: '{}',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CodexResponsesTransportError);
    expect(error).toMatchObject({ code: 'NETWORK_ERROR' });
    expect(String(error)).not.toContain('access-token');
    expect(String(error)).not.toContain('account-id');
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    for (const spy of consoleSpies) spy.mockRestore();
  });
});
