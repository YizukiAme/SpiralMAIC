import { afterEach, describe, expect, it, vi } from 'vitest';

import { CODEX_RESPONSE_LIMITS } from '@/lib/server/codex/response-guard';
import {
  CODEX_RESPONSES_ENDPOINT,
  CodexResponsesTransportError,
  createCodexResponsesTransport,
} from '@/lib/server/codex/transport';
import { deriveCodexUpstreamSessionId } from '@/lib/server/codex/logical-session';
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

function controllableByteStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const cancel = vi.fn(() => {
    cancelled = true;
  });
  const stream = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
    },
    cancel,
  });

  return {
    cancel,
    close() {
      if (!cancelled) controller.close();
    },
    enqueue(chunk: Uint8Array) {
      if (!cancelled) controller.enqueue(chunk);
    },
    error(error: unknown) {
      if (!cancelled) controller.error(error);
    },
    stream,
  };
}

function neverSettlingCancelByteStream() {
  const cancel = vi.fn(() => new Promise<void>(() => undefined));
  const stream = new ReadableStream<Uint8Array>({
    cancel,
  });
  return { cancel, stream };
}

function managedCredentials(
  accessToken = 'managed-access-token',
  accountId = 'managed-account-id',
): CodexOAuthCredentials {
  return {
    version: 1,
    accessToken,
    refreshToken: 'managed-refresh-token',
    expiresAt: NOW + 3_600_000,
    accountId,
    updatedAt: NOW,
  };
}

function createManagedProvider(
  tokenExchangeFetch: NonNullable<
    ConstructorParameters<typeof ManagedCodexTokenProvider>[0]['tokenExchangeFetch']
  > = vi.fn(async () => new Response(null, { status: 200 })),
) {
  const vault = new MemoryVault(managedCredentials());
  const provider = new ManagedCodexTokenProvider({
    vault,
    clock: { now: () => NOW },
    tokenExchangeFetch,
  });
  return { provider, tokenExchangeFetch, vault };
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

function successfulManagedRefresh(
  accountId = 'managed-account-id',
  refreshToken = 'managed-rotated-refresh-token',
): Response {
  return new Response(
    JSON.stringify({
      access_token: unsignedJwt({ chatgpt_account_id: accountId }),
      refresh_token: refreshToken,
      expires_in: 3600,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
    const logicalSession = { kind: 'chat', id: 'classroom-session-1' } as const;
    const expectedSessionId = deriveCodexUpstreamSessionId(logicalSession);
    const transport = createCodexResponsesTransport({
      tokenProvider,
      upstreamFetch,
      sessionId: expectedSessionId,
    });

    const response = await transport(CODEX_RESPONSES_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: 'Bearer attacker-token',
        'chatgpt-account-id': 'attacker-account',
        'content-type': 'application/json',
        originator: 'attacker',
        'session-id': 'attacker-session',
        'thread-id': 'attacker-thread',
        'user-agent': 'attacker-agent',
      },
      body: JSON.stringify({
        store: true,
        prompt_cache_key: 'attacker-cache-key',
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
    expect(headers.get('session-id')).toBe(expectedSessionId);
    expect(headers.get('thread-id')).toBeNull();
    expect(headers.get('content-type')).toBe('application/json');

    const body = JSON.parse(init.body as string) as Record<string, unknown> & {
      input: Array<Record<string, unknown>>;
      include: string[];
    };
    expect(body.store).toBe(false);
    expect(body.prompt_cache_key).toBe(expectedSessionId);
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

  it('uses one deterministic session id across transport instances for the same logical context', async () => {
    const upstreamFetch = vi.fn<typeof fetch>(async () => successfulResponse());
    const logicalSession = { kind: 'chat', id: 'chat-1' } as const;
    const first = createCodexResponsesTransport({
      tokenProvider: createTokenProvider(),
      upstreamFetch,
      sessionId: deriveCodexUpstreamSessionId(logicalSession),
    });
    const second = createCodexResponsesTransport({
      tokenProvider: createTokenProvider(),
      upstreamFetch,
      sessionId: deriveCodexUpstreamSessionId({ ...logicalSession }),
    });

    await first(CODEX_RESPONSES_ENDPOINT, { method: 'POST', body: '{}' });
    await second(CODEX_RESPONSES_ENDPOINT, { method: 'POST', body: '{}' });

    const firstHeaders = new Headers(upstreamFetch.mock.calls[0]?.[1]?.headers);
    const secondHeaders = new Headers(upstreamFetch.mock.calls[1]?.[1]?.headers);
    expect(firstHeaders.get('session-id')).toBeTruthy();
    expect(secondHeaders.get('session-id')).toBe(firstHeaders.get('session-id'));
  });

  it('uses a fresh ephemeral session id for independent transports without logical context', async () => {
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
    await first(CODEX_RESPONSES_ENDPOINT, { method: 'POST', body: '{}' });
    await second(CODEX_RESPONSES_ENDPOINT, { method: 'POST', body: '{}' });

    const firstRequest = new Headers(upstreamFetch.mock.calls[0]?.[1]?.headers).get('session-id');
    const repeatedRequest = new Headers(upstreamFetch.mock.calls[1]?.[1]?.headers).get(
      'session-id',
    );
    const secondResolution = new Headers(upstreamFetch.mock.calls[2]?.[1]?.headers).get(
      'session-id',
    );
    expect(repeatedRequest).toBe(firstRequest);
    expect(secondResolution).not.toBe(firstRequest);
  });

  it('strips only replay item ids without mutating encrypted reasoning or tool call pairing', async () => {
    const tokenProvider = createTokenProvider();
    const upstreamFetch = vi.fn<typeof fetch>(async () => successfulResponse());
    const transport = createCodexResponsesTransport({
      tokenProvider,
      upstreamFetch,
      sessionId: deriveCodexUpstreamSessionId({ kind: 'agent-edit', id: 'editor-session-1' }),
    });
    const original = {
      input: [
        {
          id: 'reasoning-item-1',
          type: 'reasoning',
          encrypted_content: 'ciphertext-1',
          summary: [{ type: 'summary_text', text: 'safe summary' }],
        },
        {
          id: 'function-item-1',
          type: 'function_call',
          call_id: 'call-1',
          name: 'lookup',
          arguments: '{"city":"Paris"}',
        },
        {
          id: 'result-item-1',
          type: 'function_call_output',
          call_id: 'call-1',
          output: 'sunny',
        },
      ],
    };

    await transport(CODEX_RESPONSES_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify(original),
    });

    const normalized = JSON.parse(upstreamFetch.mock.calls[0]?.[1]?.body as string) as {
      input: Array<Record<string, unknown>>;
    };
    expect(normalized.input).toEqual([
      {
        type: 'reasoning',
        encrypted_content: 'ciphertext-1',
        summary: [{ type: 'summary_text', text: 'safe summary' }],
      },
      {
        type: 'function_call',
        call_id: 'call-1',
        name: 'lookup',
        arguments: '{"city":"Paris"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'sunny',
      },
    ]);
    expect(original.input.map((item) => item.id)).toEqual([
      'reasoning-item-1',
      'function-item-1',
      'result-item-1',
    ]);
  });

  it('drops caller-supplied thread identity fields', async () => {
    const upstreamFetch = vi.fn<typeof fetch>(async () => successfulResponse());
    const transport = createCodexResponsesTransport({
      tokenProvider: createTokenProvider(),
      upstreamFetch,
      sessionId: deriveCodexUpstreamSessionId({ kind: 'chat', id: 'chat-1' }),
    });

    await transport(CODEX_RESPONSES_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({ thread_id: 'thread-snake', 'thread-id': 'thread-hyphen' }),
    });

    const normalized = JSON.parse(upstreamFetch.mock.calls[0]?.[1]?.body as string);
    expect(normalized).not.toHaveProperty('thread_id');
    expect(normalized).not.toHaveProperty('thread-id');
  });
});

describe('Codex Responses transport failures', () => {
  it('does not start credential acquisition for an already-cancelled caller', async () => {
    const caller = new AbortController();
    caller.abort('already-cancelled-secret');
    const tokenProvider = createTokenProvider();
    const upstreamFetch = vi.fn<typeof fetch>();
    const transport = createCodexResponsesTransport({ tokenProvider, upstreamFetch });

    await expect(
      transport(CODEX_RESPONSES_ENDPOINT, {
        body: '{}',
        method: 'POST',
        signal: caller.signal,
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });

    expect(tokenProvider.getValidCredentials).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('does not fetch when request-header construction synchronously cancels the caller', async () => {
    const caller = new AbortController();
    const headers: Record<string, string> = {};
    Object.defineProperty(headers, 'authorization', {
      enumerable: true,
      get() {
        caller.abort('header-getter-secret');
        return 'Bearer caller-value';
      },
    });
    const upstreamFetch = vi.fn<typeof fetch>();
    const transport = createCodexResponsesTransport({
      tokenProvider: createTokenProvider(),
      upstreamFetch,
    });

    await expect(
      transport(CODEX_RESPONSES_ENDPOINT, {
        body: '{}',
        headers,
        method: 'POST',
        signal: caller.signal,
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });

    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('honors caller cancellation while initial credentials are still pending', async () => {
    const caller = new AbortController();
    const tokenProvider: CodexTokenProvider = {
      getValidCredentials: vi.fn(
        () => new Promise<{ accessToken: string; accountId: string }>(() => undefined),
      ),
    };
    const upstreamFetch = vi.fn<typeof fetch>();
    const transport = createCodexResponsesTransport({ tokenProvider, upstreamFetch });
    const request = transport(CODEX_RESPONSES_ENDPOINT, {
      body: '{}',
      method: 'POST',
      signal: caller.signal,
    });

    caller.abort('caller-secret');
    const outcome = await Promise.race([
      request.catch((error: unknown) => error),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
    ]);

    expect(outcome).not.toBe('timed-out');
    expect(outcome).toMatchObject({ code: 'NETWORK_ERROR' });
    expect(String(outcome)).not.toContain('caller-secret');
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('keeps the absolute deadline active while initial credentials are pending', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let caught: unknown;
    const tokenProvider: CodexTokenProvider = {
      getValidCredentials: vi.fn(
        () => new Promise<{ accessToken: string; accountId: string }>(() => undefined),
      ),
    };
    const transport = createCodexResponsesTransport({
      tokenProvider,
      upstreamFetch: vi.fn<typeof fetch>(),
    });
    const request = transport(CODEX_RESPONSES_ENDPOINT, { body: '{}', method: 'POST' });
    void request.catch((error: unknown) => {
      caught = error;
    });

    await vi.advanceTimersByTimeAsync(CODEX_RESPONSE_LIMITS.totalTimeoutMs);
    await Promise.resolve();

    expect(caught).toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  it('honors caller cancellation while pre-send credential currentness is pending', async () => {
    const caller = new AbortController();
    const currentnessStarted = deferred<void>();
    const credentials = { accessToken: 'access-token', accountId: 'account-id' };
    const tokenProvider: CodexTokenProvider = {
      getValidCredentials: vi
        .fn()
        .mockResolvedValueOnce(credentials)
        .mockImplementationOnce(() => {
          currentnessStarted.resolve();
          return new Promise<{ accessToken: string; accountId: string }>(() => undefined);
        }),
    };
    const upstreamFetch = vi.fn<typeof fetch>();
    const transport = createCodexResponsesTransport({ tokenProvider, upstreamFetch });
    const request = transport(CODEX_RESPONSES_ENDPOINT, {
      body: '{}',
      method: 'POST',
      signal: caller.signal,
    });

    await currentnessStarted.promise;
    caller.abort('pre-send-secret');

    await expect(request).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('does not start fetch when pre-send currentness crosses the absolute deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const credentials = { accessToken: 'access-token', accountId: 'account-id' };
    let credentialRead = 0;
    const tokenProvider: CodexTokenProvider = {
      getValidCredentials: vi.fn(() => {
        credentialRead += 1;
        if (credentialRead === 2) {
          vi.setSystemTime(NOW + CODEX_RESPONSE_LIMITS.totalTimeoutMs);
        }
        return Promise.resolve(credentials);
      }),
    };
    const upstreamFetch = vi.fn<typeof fetch>(async () => new Response('{}'));
    const transport = createCodexResponsesTransport({ tokenProvider, upstreamFetch });

    await expect(
      transport(CODEX_RESPONSES_ENDPOINT, { body: '{}', method: 'POST' }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });

    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('does not send an account-A capability after credentials switch to account B', async () => {
    const accountA = { accessToken: 'account-a-token', accountId: 'account-a' };
    const tokenProvider = {
      getValidCredentials: vi.fn(async () => ({
        accessToken: 'account-b-token',
        accountId: 'account-b',
      })),
      refreshIfCurrent: vi.fn(async () => accountA),
    };
    const upstreamFetch = vi.fn<typeof fetch>(async () => successfulResponse());
    const capabilityLease = {
      credentialLease: {
        tokenProvider,
        credentials: accountA,
        lifecycleGeneration: 1,
        lifecycleSignal: null,
      },
      isCatalogCurrent: () => true,
    };
    const transport = createCodexResponsesTransport({
      tokenProvider,
      upstreamFetch,
      capabilityLease,
    } as Parameters<typeof createCodexResponsesTransport>[0]);

    await expect(
      transport(CODEX_RESPONSES_ENDPOINT, { method: 'POST', body: '{}' }),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

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
    let current = { accessToken: 'old-token', accountId: 'account-id' };
    const getValidCredentials = vi.fn<CodexTokenProvider['getValidCredentials']>(async () => ({
      ...current,
    }));
    const refreshIfCurrent = vi.fn(async () => {
      current = { accessToken: 'new-token', accountId: 'account-id' };
      return { ...current };
    });
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

    expect(getValidCredentials).toHaveBeenCalledTimes(7);
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
    const firstHeaders = new Headers(upstreamFetch.mock.calls[0]?.[1]?.headers);
    const secondHeaders = new Headers(upstreamFetch.mock.calls[1]?.[1]?.headers);
    expect(secondHeaders.get('session-id')).toBe(firstHeaders.get('session-id'));
    expect(upstreamFetch.mock.calls[1]?.[1]?.body).toBe(upstreamFetch.mock.calls[0]?.[1]?.body);
    const replayBody = JSON.parse(upstreamFetch.mock.calls[1]?.[1]?.body as string);
    expect(replayBody.prompt_cache_key).toBe(secondHeaders.get('session-id'));
    expect(replayBody.store).toBe(false);
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
    expect(tokenProvider.getValidCredentials).toHaveBeenCalledTimes(status === 401 ? 7 : 3);
    expect(tokenProvider.refreshIfCurrent).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  });

  it('classifies a non-success response without waiting for a hung body cancellation', async () => {
    const source = neverSettlingCancelByteStream();
    const transport = createCodexResponsesTransport({
      tokenProvider: createTokenProvider(),
      upstreamFetch: vi.fn(async () => new Response(source.stream, { status: 403 })),
    });

    const outcome = await Promise.race([
      transport(CODEX_RESPONSES_ENDPOINT, { body: '{}', method: 'POST' }).catch(
        (error: unknown) => error,
      ),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
    ]);

    expect(outcome).not.toBe('timed-out');
    expect(outcome).toMatchObject({ code: 'WORKSPACE_FORBIDDEN', upstreamStatus: 403 });
    expect(source.cancel).toHaveBeenCalledTimes(1);
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

describe('Codex Responses guarded lifecycle', () => {
  it('does not start a 401 refresh after first-body cleanup synchronously cancels the caller', async () => {
    const caller = new AbortController();
    const tokenProvider = createTokenProvider();
    const first = new ReadableStream<Uint8Array>({
      cancel() {
        caller.abort('first-body-cancel-secret');
      },
    });
    const upstreamFetch = vi.fn<typeof fetch>(async () => new Response(first, { status: 401 }));
    const transport = createCodexResponsesTransport({ tokenProvider, upstreamFetch });

    await expect(
      transport(CODEX_RESPONSES_ENDPOINT, {
        body: '{}',
        method: 'POST',
        signal: caller.signal,
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });

    expect(tokenProvider.refreshIfCurrent).not.toHaveBeenCalled();
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('replays a 401 without waiting for the first body cancellation to settle', async () => {
    let current = { accessToken: 'old-token', accountId: 'account-id' };
    const tokenProvider = {
      getValidCredentials: vi.fn(async () => ({ ...current })),
      refreshIfCurrent: vi.fn(async () => {
        current = { accessToken: 'new-token', accountId: 'account-id' };
        return { ...current };
      }),
    };
    const first = neverSettlingCancelByteStream();
    const upstreamFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(first.stream, { status: 401 }))
      .mockResolvedValueOnce(new Response('{}'));
    const transport = createCodexResponsesTransport({ tokenProvider, upstreamFetch });

    const outcome = await Promise.race([
      transport(CODEX_RESPONSES_ENDPOINT, { body: '{"input":[]}', method: 'POST' }),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
    ]);

    expect(outcome).not.toBe('timed-out');
    expect(outcome).toBeInstanceOf(Response);
    expect((outcome as Response).status).toBe(200);
    expect(first.cancel).toHaveBeenCalledTimes(1);
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
    expect(upstreamFetch.mock.calls[1]?.[1]?.body).toBe(upstreamFetch.mock.calls[0]?.[1]?.body);
    expect(new Headers(upstreamFetch.mock.calls[1]?.[1]?.headers).get('session-id')).toBe(
      new Headers(upstreamFetch.mock.calls[0]?.[1]?.headers).get('session-id'),
    );
  });

  it('honors caller cancellation while a 401 credential refresh is pending', async () => {
    const caller = new AbortController();
    const refreshStarted = deferred<void>();
    const tokenProvider = {
      getValidCredentials: vi.fn(async () => ({
        accessToken: 'old-token',
        accountId: 'account-id',
      })),
      refreshIfCurrent: vi.fn(() => {
        refreshStarted.resolve();
        return new Promise<{ accessToken: string; accountId: string }>(() => undefined);
      }),
    };
    const upstreamFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 401 }));
    const transport = createCodexResponsesTransport({ tokenProvider, upstreamFetch });
    const request = transport(CODEX_RESPONSES_ENDPOINT, {
      body: '{}',
      method: 'POST',
      signal: caller.signal,
    });

    await refreshStarted.promise;
    caller.abort('refresh-caller-secret');
    const outcome = await Promise.race([
      request.catch((error: unknown) => error),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
    ]);

    expect(outcome).not.toBe('timed-out');
    expect(outcome).toMatchObject({ code: 'NETWORK_ERROR' });
    expect(String(outcome)).not.toContain('refresh-caller-secret');
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('honors caller cancellation while post-header currentness is pending', async () => {
    const caller = new AbortController();
    const headerCurrentnessStarted = deferred<void>();
    const credentials = { accessToken: 'access-token', accountId: 'account-id' };
    let credentialRead = 0;
    const tokenProvider: CodexTokenProvider = {
      getValidCredentials: vi.fn(() => {
        credentialRead += 1;
        if (credentialRead === 3) {
          headerCurrentnessStarted.resolve();
          return new Promise<{ accessToken: string; accountId: string }>(() => undefined);
        }
        return Promise.resolve(credentials);
      }),
    };
    const source = controllableByteStream();
    const transport = createCodexResponsesTransport({
      tokenProvider,
      upstreamFetch: vi.fn(async () => new Response(source.stream)),
    });
    const request = transport(CODEX_RESPONSES_ENDPOINT, {
      body: '{}',
      method: 'POST',
      signal: caller.signal,
    });

    await headerCurrentnessStarted.promise;
    caller.abort('post-header-secret');

    await expect(request).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(source.cancel).toHaveBeenCalledTimes(1);
  });

  it('does not publish response headers when post-header currentness crosses the deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const credentials = { accessToken: 'access-token', accountId: 'account-id' };
    let credentialRead = 0;
    const tokenProvider: CodexTokenProvider = {
      getValidCredentials: vi.fn(() => {
        credentialRead += 1;
        if (credentialRead === 3) {
          vi.setSystemTime(NOW + CODEX_RESPONSE_LIMITS.totalTimeoutMs);
        }
        return Promise.resolve(credentials);
      }),
    };
    const source = controllableByteStream();
    const transport = createCodexResponsesTransport({
      tokenProvider,
      upstreamFetch: vi.fn(async () => new Response(source.stream)),
    });

    await expect(
      transport(CODEX_RESPONSES_ENDPOINT, { body: '{}', method: 'POST' }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });

    expect(source.cancel).toHaveBeenCalledTimes(1);
  });

  it('keeps the absolute deadline active while a 401 credential refresh is pending', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let caught: unknown;
    const tokenProvider = {
      getValidCredentials: vi.fn(async () => ({
        accessToken: 'old-token',
        accountId: 'account-id',
      })),
      refreshIfCurrent: vi.fn(
        () => new Promise<{ accessToken: string; accountId: string }>(() => undefined),
      ),
    };
    const transport = createCodexResponsesTransport({
      tokenProvider,
      upstreamFetch: vi.fn(async () => new Response(null, { status: 401 })),
    });
    const request = transport(CODEX_RESPONSES_ENDPOINT, { body: '{}', method: 'POST' });
    void request.catch((error: unknown) => {
      caught = error;
    });

    await vi.advanceTimersByTimeAsync(CODEX_RESPONSE_LIMITS.totalTimeoutMs);
    await Promise.resolve();

    expect(caught).toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  it('treats a successful null body as immediate EOF without synthesizing a 204 body', async () => {
    const transport = createCodexResponsesTransport({
      tokenProvider: createTokenProvider(),
      upstreamFetch: vi.fn(async () => new Response(null, { status: 204 })),
    });

    const response = await transport(CODEX_RESPONSES_ENDPOINT, {
      body: '{}',
      method: 'POST',
    });

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it('does not publish a null-body success after cancellation wins the final EOF microtask race', async () => {
    const caller = new AbortController();
    const credentials = { accessToken: 'access-token', accountId: 'account-id' };
    let credentialRead = 0;
    const tokenProvider: CodexTokenProvider = {
      getValidCredentials: vi.fn(() => {
        credentialRead += 1;
        if (credentialRead === 4) {
          queueMicrotask(() =>
            queueMicrotask(() =>
              queueMicrotask(() => queueMicrotask(() => caller.abort('null-body-race-secret'))),
            ),
          );
        }
        return Promise.resolve(credentials);
      }),
    };
    const transport = createCodexResponsesTransport({
      tokenProvider,
      upstreamFetch: vi.fn(async () => new Response(null, { status: 204 })),
    });

    const outcome = await transport(CODEX_RESPONSES_ENDPOINT, {
      body: '{}',
      method: 'POST',
      signal: caller.signal,
    }).catch((error: unknown) => error);

    expect(caller.signal.aborted).toBe(true);
    expect(outcome).toMatchObject({ code: 'NETWORK_ERROR' });
    expect(String(outcome)).not.toContain('null-body-race-secret');
  });

  it('cancels a successful response when logout happens after headers', async () => {
    const { provider } = createManagedProvider();
    const source = controllableByteStream();
    const transport = createCodexResponsesTransport({
      tokenProvider: provider,
      upstreamFetch: vi.fn(async () => new Response(source.stream)),
    });

    const response = await transport(CODEX_RESPONSES_ENDPOINT, {
      method: 'POST',
      body: '{}',
    });
    const reader = response.body!.getReader();
    const read = reader.read();
    const logout = provider.logout();
    source.enqueue(Uint8Array.of(1));

    await expect(read).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await logout;
    expect(source.cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels a late response when fetch ignores lifecycle abort', async () => {
    const { provider } = createManagedProvider();
    const late = deferred<Response>();
    const source = controllableByteStream();
    const upstreamFetch = vi.fn<typeof fetch>(() => late.promise);
    const transport = createCodexResponsesTransport({ tokenProvider: provider, upstreamFetch });

    const request = transport(CODEX_RESPONSES_ENDPOINT, { method: 'POST', body: '{}' });
    await vi.waitFor(() => expect(upstreamFetch).toHaveBeenCalledTimes(1));
    const logout = provider.logout();
    late.resolve(new Response(source.stream));

    await expect(request).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await vi.waitFor(() => expect(source.cancel).toHaveBeenCalledTimes(1));
    await logout;
  });

  it('publishes a response after a managed same-account refresh while awaiting headers', async () => {
    const rotatedAccessToken = unsignedJwt({ chatgpt_account_id: 'managed-account-id' });
    const { provider, vault } = createManagedProvider(
      vi.fn(async () => successfulManagedRefresh()),
    );
    const pendingHeaders = deferred<Response>();
    const upstreamFetch = vi.fn<typeof fetch>(() => pendingHeaders.promise);
    const transport = createCodexResponsesTransport({ tokenProvider: provider, upstreamFetch });

    const request = transport(CODEX_RESPONSES_ENDPOINT, { method: 'POST', body: '{}' });
    await vi.waitFor(() => expect(upstreamFetch).toHaveBeenCalledTimes(1));
    await provider.getValidCredentials({ forceRefresh: true });
    expect(vault.current?.accessToken).toBe(rotatedAccessToken);
    pendingHeaders.resolve(new Response('response-after-rotation'));

    const response = await request;
    await expect(response.text()).resolves.toBe('response-after-rotation');
  });

  it('completes EOF after a delivered chunk and managed same-account refresh', async () => {
    const rotatedAccessToken = unsignedJwt({ chatgpt_account_id: 'managed-account-id' });
    const { provider, vault } = createManagedProvider(
      vi.fn(async () => successfulManagedRefresh()),
    );
    const source = controllableByteStream();
    const transport = createCodexResponsesTransport({
      tokenProvider: provider,
      upstreamFetch: vi.fn(async () => new Response(source.stream)),
    });
    const response = await transport(CODEX_RESPONSES_ENDPOINT, {
      method: 'POST',
      body: '{}',
    });
    const reader = response.body!.getReader();

    source.enqueue(Uint8Array.of(1));
    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: Uint8Array.of(1),
    });
    await provider.getValidCredentials({ forceRefresh: true });
    expect(vault.current?.accessToken).toBe(rotatedAccessToken);
    source.close();

    await expect(reader.read()).resolves.toMatchObject({ done: true });
    expect(source.cancel).not.toHaveBeenCalled();
  });

  it('disposes the first 401 guard before conditional refresh', async () => {
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, 'removeEventListener');
    let current = { accessToken: 'old-token', accountId: 'account-id' };
    const tokenProvider = {
      getValidCredentials: vi.fn(async () => ({ ...current })),
      refreshIfCurrent: vi.fn(async () => {
        // The acquisition guard and first response guard are both gone before
        // refresh; the replay gets a fresh guard with the same deadline.
        expect(remove).toHaveBeenCalledTimes(2);
        current = { accessToken: 'new-token', accountId: 'account-id' };
        return { ...current };
      }),
    };
    const first = controllableByteStream();
    const second = controllableByteStream();
    const upstreamFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(first.stream, { status: 401 }))
      .mockResolvedValueOnce(new Response(second.stream));
    const transport = createCodexResponsesTransport({ tokenProvider, upstreamFetch });

    const response = await transport(CODEX_RESPONSES_ENDPOINT, {
      body: '{}',
      method: 'POST',
      signal: caller.signal,
    });

    expect(response.status).toBe(200);
    expect(first.cancel).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(2);
    await response.body!.cancel();
    expect(remove).toHaveBeenCalledTimes(3);
    expect(second.cancel).toHaveBeenCalledTimes(1);
  });

  it('preserves replay body and session while later logout cancels the replay body', async () => {
    const tokenExchangeFetch = vi
      .fn<
        NonNullable<
          ConstructorParameters<typeof ManagedCodexTokenProvider>[0]['tokenExchangeFetch']
        >
      >()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: unsignedJwt({ chatgpt_account_id: 'managed-account-id' }),
            refresh_token: 'rotated-refresh-token',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValue(new Response(null, { status: 200 }));
    const { provider } = createManagedProvider(tokenExchangeFetch);
    const first = controllableByteStream();
    const second = controllableByteStream();
    const upstreamFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(first.stream, { status: 401 }))
      .mockResolvedValueOnce(new Response(second.stream));
    const transport = createCodexResponsesTransport({ tokenProvider: provider, upstreamFetch });

    const response = await transport(CODEX_RESPONSES_ENDPOINT, {
      body: '{"input":[]}',
      method: 'POST',
    });
    const firstInit = upstreamFetch.mock.calls[0]?.[1];
    const secondInit = upstreamFetch.mock.calls[1]?.[1];
    expect(secondInit?.body).toBe(firstInit?.body);
    expect(new Headers(secondInit?.headers).get('session-id')).toBe(
      new Headers(firstInit?.headers).get('session-id'),
    );
    expect(first.cancel).toHaveBeenCalledTimes(1);

    const reader = response.body!.getReader();
    const read = reader.read();
    const logout = provider.logout();
    second.enqueue(Uint8Array.of(1));

    await expect(read).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await logout;
    expect(second.cancel).toHaveBeenCalledTimes(1);
  });

  it('shares one absolute deadline across the first attempt and 401 replay', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let current = { accessToken: 'old-token', accountId: 'account-id' };
    const tokenProvider = {
      getValidCredentials: vi.fn(async () => ({ ...current })),
      refreshIfCurrent: vi.fn(async () => {
        current = { accessToken: 'new-token', accountId: 'account-id' };
        return { ...current };
      }),
    };
    const firstResponse = deferred<Response>();
    const replayResponse = deferred<Response>();
    const replayStarted = deferred<void>();
    const first = controllableByteStream();
    const lateReplay = controllableByteStream();
    const upstreamFetch = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => {
        replayStarted.resolve();
        return replayResponse.promise;
      });
    const transport = createCodexResponsesTransport({ tokenProvider, upstreamFetch });
    let caught: unknown;
    const request = transport(CODEX_RESPONSES_ENDPOINT, { body: '{}', method: 'POST' });
    void request.then(
      () => undefined,
      (error: unknown) => {
        caught = error;
      },
    );

    await vi.advanceTimersByTimeAsync(CODEX_RESPONSE_LIMITS.totalTimeoutMs - 1);
    firstResponse.resolve(new Response(first.stream, { status: 401 }));
    await replayStarted.promise;
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
    expect(first.cancel).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    replayResponse.resolve(new Response(lateReplay.stream));
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await Promise.resolve();
    }

    expect(caught).toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(lateReplay.cancel).toHaveBeenCalledTimes(1);
  });

  it('maps an asynchronous response-body read failure through the safe transport error', async () => {
    const source = controllableByteStream();
    const transport = createCodexResponsesTransport({
      tokenProvider: createTokenProvider(),
      upstreamFetch: vi.fn(async () => new Response(source.stream)),
    });
    const response = await transport(CODEX_RESPONSES_ENDPOINT, {
      body: '{}',
      method: 'POST',
    });
    const reader = response.body!.getReader();

    source.error(new Error('upstream-secret-body access-token account-id'));
    const error = await reader.read().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CodexResponsesTransportError);
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(String(error)).not.toContain('upstream-secret-body');
    expect(String(error)).not.toContain('access-token');
    expect(String(error)).not.toContain('account-id');
  });

  it('maps the raw body limit to a safe error without exposing body or credentials', async () => {
    const cancel = vi.fn();
    const oversized = new Uint8Array(CODEX_RESPONSE_LIMITS.maxBytes + 1);
    oversized.set(new TextEncoder().encode('upstream-secret-body'));
    const transport = createCodexResponsesTransport({
      tokenProvider: createTokenProvider(),
      upstreamFetch: vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(oversized);
              },
              cancel,
            }),
          ),
      ),
    });
    const response = await transport(CODEX_RESPONSES_ENDPOINT, {
      body: '{}',
      method: 'POST',
    });

    const error = await response
      .body!.getReader()
      .read()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CodexResponsesTransportError);
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(String(error)).not.toContain('upstream-secret-body');
    expect(String(error)).not.toContain('access-token');
    expect(String(error)).not.toContain('account-id');
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
