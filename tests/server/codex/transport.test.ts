import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_RESPONSES_ENDPOINT,
  CodexResponsesTransportError,
  createCodexResponsesTransport,
} from '@/lib/server/codex/transport';
import {
  CODEX_OAUTH_ERROR_CODES,
  CodexOAuthError,
  ManagedCodexTokenProvider,
  type CodexTokenProvider,
} from '@/lib/server/codex/token-provider';
import type { CodexCredentialVault, CodexOAuthCredentials } from '@/lib/server/codex/vault';

const NOW = 1_700_000_000_000;

class MemoryVault implements CodexCredentialVault {
  constructor(public current: CodexOAuthCredentials | null) {}

  async load(): Promise<CodexOAuthCredentials | null> {
    return this.current;
  }

  async save(credentials: CodexOAuthCredentials): Promise<void> {
    this.current = credentials;
  }

  async clear(): Promise<void> {
    this.current = null;
  }
}

function unsignedJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.responses-transport-test`;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createTokenProvider() {
  return {
    getValidCredentials: vi.fn(async () => ({
      accessToken: 'access-token',
      accountId: 'account-id',
    })),
    refreshIfCurrent: vi.fn(
      async (expected: { accessToken: string; accountId: string }) => expected,
    ),
  } satisfies CodexTokenProvider & {
    refreshIfCurrent(expected: {
      accessToken: string;
      accountId: string;
    }): Promise<{ accessToken: string; accountId: string }>;
  };
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
  it.each([
    [CODEX_OAUTH_ERROR_CODES.NETWORK_ERROR, true],
    [CODEX_OAUTH_ERROR_CODES.UPSTREAM_ERROR, true],
    [CODEX_OAUTH_ERROR_CODES.INVALID_RESPONSE, false],
    [CODEX_OAUTH_ERROR_CODES.STORAGE_ERROR, false],
  ] as const)('preserves a %s credential refresh failure after a 401', async (code, retryable) => {
    const oauthError = new CodexOAuthError(code, retryable);
    const tokenProvider = {
      getValidCredentials: vi.fn(async () => ({
        accessToken: 'old-token',
        accountId: 'account-id',
      })),
      refreshIfCurrent: vi.fn(async () => {
        throw oauthError;
      }),
    };
    const upstreamFetch = vi.fn<typeof fetch>(async () =>
      Promise.resolve(new Response('secret upstream body', { status: 401 })),
    );
    const transport = createCodexResponsesTransport({ tokenProvider, upstreamFetch });

    await expect(transport(CODEX_RESPONSES_ENDPOINT, { method: 'POST', body: '{}' })).rejects.toBe(
      oauthError,
    );
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    CODEX_OAUTH_ERROR_CODES.CREDENTIALS_MISSING,
    CODEX_OAUTH_ERROR_CODES.SIGNED_OUT,
    CODEX_OAUTH_ERROR_CODES.INVALID_GRANT,
    CODEX_OAUTH_ERROR_CODES.REFRESH_REJECTED,
  ])('preserves a %s credential refresh failure after a 401', async (code) => {
    const oauthError = new CodexOAuthError(code, false);
    const tokenProvider = {
      getValidCredentials: vi.fn(async () => ({
        accessToken: 'old-token',
        accountId: 'account-id',
      })),
      refreshIfCurrent: vi.fn(async () => {
        throw oauthError;
      }),
    };
    const upstreamFetch = vi.fn<typeof fetch>(async () =>
      Promise.resolve(new Response('secret upstream body', { status: 401 })),
    );
    const transport = createCodexResponsesTransport({ tokenProvider, upstreamFetch });

    await expect(transport(CODEX_RESPONSES_ENDPOINT, { method: 'POST', body: '{}' })).rejects.toBe(
      oauthError,
    );
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('preserves credentials cleared before the first request for middleware classification', async () => {
    const oauthError = new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.CREDENTIALS_MISSING, false);
    const tokenProvider = {
      getValidCredentials: vi.fn(async () => {
        throw oauthError;
      }),
    } satisfies CodexTokenProvider;
    const upstreamFetch = vi.fn<typeof fetch>();
    const transport = createCodexResponsesTransport({ tokenProvider, upstreamFetch });

    await expect(transport(CODEX_RESPONSES_ENDPOINT, { method: 'POST', body: '{}' })).rejects.toBe(
      oauthError,
    );
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'replacement account', replacementAccountId: 'account-b' },
    { label: 'same-account new login', replacementAccountId: 'account-a' },
  ])('never lets a stale response force-refresh credentials from a $label', async (scenario) => {
    const accountA: CodexOAuthCredentials = {
      version: 1,
      accessToken: 'account-a-access',
      refreshToken: 'account-a-refresh',
      expiresAt: NOW + 3_600_000,
      accountId: 'account-a',
      updatedAt: NOW - 1,
    };
    const vault = new MemoryVault(accountA);
    const tokenExchangeFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: unsignedJwt({ chatgpt_account_id: scenario.replacementAccountId }),
            refresh_token: 'replacement-rotated-by-stale-response',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const tokenProvider = new ManagedCodexTokenProvider({
      vault,
      clock: { now: () => NOW },
      tokenExchangeFetch,
    });
    const staleResponse = deferred<Response>();
    const upstreamFetch = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => staleResponse.promise)
      .mockResolvedValueOnce(successfulResponse());
    const transport = createCodexResponsesTransport({ tokenProvider, upstreamFetch });

    const request = transport(CODEX_RESPONSES_ENDPOINT, { method: 'POST', body: '{}' });
    await vi.waitFor(() => expect(upstreamFetch).toHaveBeenCalledTimes(1));
    const accountB: CodexOAuthCredentials = {
      version: 1,
      accessToken: 'account-b-access',
      refreshToken: 'account-b-refresh',
      expiresAt: NOW + 3_600_000,
      accountId: scenario.replacementAccountId,
      updatedAt: NOW + 1,
    };
    await vault.save(accountB);
    staleResponse.resolve(new Response('stale-account-body', { status: 401 }));

    await expect(request).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(tokenExchangeFetch).not.toHaveBeenCalled();
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    expect(vault.current).toEqual(accountB);
  });

  it('refreshes and replays exactly once after a 401', async () => {
    const getValidCredentials = vi
      .fn<CodexTokenProvider['getValidCredentials']>()
      .mockResolvedValueOnce({ accessToken: 'old-token', accountId: 'account-id' });
    const refreshIfCurrent = vi.fn(async () => ({
      accessToken: 'new-token',
      accountId: 'account-id',
    }));
    const upstreamFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('secret upstream body', { status: 401 }))
      .mockResolvedValueOnce(successfulResponse());
    const tokenProvider = { getValidCredentials, refreshIfCurrent };
    const transport = createCodexResponsesTransport({
      tokenProvider,
      upstreamFetch,
    });

    await expect(
      transport(CODEX_RESPONSES_ENDPOINT, { method: 'POST', body: '{}' }),
    ).resolves.toMatchObject({ status: 200 });

    expect(getValidCredentials).toHaveBeenCalledTimes(1);
    expect(getValidCredentials).toHaveBeenCalledWith();
    expect(refreshIfCurrent).toHaveBeenCalledOnce();
    expect(refreshIfCurrent).toHaveBeenCalledWith({
      accessToken: 'old-token',
      accountId: 'account-id',
    });
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
    expect(tokenProvider.getValidCredentials).toHaveBeenCalledTimes(1);
    expect(tokenProvider.refreshIfCurrent).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
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
