import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_COMPATIBILITY_VERSION,
  CODEX_FALLBACK_MODELS,
  CODEX_MODELS_ENDPOINT,
  CODEX_MODELS_REQUEST_TIMEOUT_MS,
  CodexModelDiscovery,
  createCodexModelsTransport,
  getCodexCredentialGeneration,
  parseCodexModels,
} from '@/lib/server/codex/models';
import {
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

function createTokenProvider() {
  return {
    getValidCredentials: vi.fn(async () => ({
      accessToken: 'access-secret',
      accountId: 'account-secret',
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

function modelResponse(
  models: unknown[],
  options: { status?: number; etag?: string } = {},
): Response {
  return new Response(JSON.stringify({ models }), {
    status: options.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...(options.etag ? { etag: options.etag } : {}),
    },
  });
}

function unsignedJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.models-test-signature`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('Codex model parsing', () => {
  it('uses the official Codex compatibility version instead of the OpenMAIC app version', () => {
    expect(CODEX_COMPATIBILITY_VERSION).toBe('0.144.4');
    expect(CODEX_MODELS_ENDPOINT).toBe(
      'https://chatgpt.com/backend-api/codex/models?client_version=0.144.4',
    );
  });

  it('keeps ChatGPT models unsupported by the API, filters hidden/incompatible records, and deduplicates slugs', () => {
    const parsed = parseCodexModels({
      models: [
        { slug: 'gpt-last', display_name: 'GPT Last', priority: 30, visibility: 'list' },
        { slug: 'gpt-hidden', priority: 1, visibility: 'hide' },
        {
          slug: 'gpt-future',
          priority: 1,
          visibility: 'list',
          minimal_client_version: '0.144.5',
        },
        {
          slug: 'gpt-malformed-minimum',
          priority: 1,
          visibility: 'list',
          minimal_client_version: '0.144',
        },
        {
          slug: 'gpt-chatgpt-only',
          priority: 2,
          visibility: 'list',
          supported_in_api: false,
          minimal_client_version: '0.144.4',
        },
        { slug: 'gpt-first', name: 'GPT First', priority: 5, visibility: 'list' },
        { slug: 'gpt-last', display_name: 'Duplicate', priority: 0, visibility: 'list' },
        { slug: '', priority: 0, visibility: 'list' },
        null,
      ],
    });

    expect(parsed).toEqual([
      { id: 'gpt-last', name: 'Duplicate', source: 'probed' },
      { id: 'gpt-chatgpt-only', name: 'gpt-chatgpt-only', source: 'probed' },
      { id: 'gpt-first', name: 'GPT First', source: 'probed' },
    ]);
  });

  it('compares prerelease minimum versions with SemVer precedence', () => {
    expect(
      parseCodexModels(
        {
          models: [
            {
              slug: 'compatible-prerelease',
              visibility: 'list',
              minimal_client_version: '0.145.0-beta.2',
            },
            {
              slug: 'future-prerelease',
              visibility: 'list',
              minimal_client_version: '0.145.0-beta.11',
            },
          ],
        },
        '0.145.0-beta.10',
      ).map((model) => model.id),
    ).toEqual(['compatible-prerelease']);
  });

  it('rejects malformed envelopes instead of exposing raw fields', () => {
    expect(() => parseCodexModels({ models: 'secret-upstream-body' })).toThrow(
      'Codex model service returned an invalid response',
    );
    expect(() => parseCodexModels({ models: [{ token: 'secret' }] })).toThrow(
      'Codex model service returned an invalid response',
    );
  });
});

describe('Codex models transport boundary', () => {
  it.each([
    'http://chatgpt.com/backend-api/codex/models?client_version=0.3.0',
    'https://chatgpt.com/backend-api/codex/models',
    `${CODEX_MODELS_ENDPOINT}&next=true`,
    `${CODEX_MODELS_ENDPOINT}#fragment`,
    `${CODEX_MODELS_ENDPOINT}/`,
  ])('rejects non-literal endpoint %s before credential lookup', async (endpoint) => {
    const tokenProvider = createTokenProvider();
    const upstreamFetch = vi.fn(async () => modelResponse([]));
    const transport = createCodexModelsTransport({ tokenProvider, upstreamFetch });

    await expect(transport(endpoint)).rejects.toMatchObject({ code: 'INVALID_ENDPOINT' });
    expect(tokenProvider.getValidCredentials).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('sends only a GET with server-owned identity and no redirects', async () => {
    const tokenProvider = createTokenProvider();
    const upstreamFetch = vi.fn(async () => modelResponse([]));
    const transport = createCodexModelsTransport({ tokenProvider, upstreamFetch });

    await transport(CODEX_MODELS_ENDPOINT, {
      method: 'GET',
      headers: {
        authorization: 'Bearer attacker',
        'chatgpt-account-id': 'attacker',
        originator: 'attacker',
        'user-agent': 'attacker',
        'if-none-match': 'etag-1',
      },
    });

    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    const [url, init] = upstreamFetch.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit | undefined,
    ];
    const headers = new Headers(init?.headers);
    expect(url).toBe(CODEX_MODELS_ENDPOINT);
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('manual');
    expect(headers.get('authorization')).toBe('Bearer access-secret');
    expect(headers.get('chatgpt-account-id')).toBe('account-secret');
    expect(headers.get('originator')).toBe('openmaic');
    expect(headers.get('if-none-match')).toBe('etag-1');
    expect(headers.get('user-agent')).toMatch(/^OpenMAIC\/0\.3\.0 /);
  });

  it('rejects non-GET requests before credential lookup', async () => {
    const tokenProvider = createTokenProvider();
    const transport = createCodexModelsTransport({ tokenProvider, upstreamFetch: vi.fn() });

    await expect(transport(CODEX_MODELS_ENDPOINT, { method: 'POST' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(tokenProvider.getValidCredentials).not.toHaveBeenCalled();
  });

  it('returns fixed errors without exposing an upstream response body', async () => {
    const tokenProvider = createTokenProvider();
    const sentinel = 'raw-secret-upstream-body';
    const transport = createCodexModelsTransport({
      tokenProvider,
      upstreamFetch: vi.fn(async () => new Response(sentinel, { status: 500 })),
    });

    const error = (await transport(CODEX_MODELS_ENDPOINT).catch((caught) => caught)) as Error;
    expect(error.message).toBe('Codex model service is temporarily unavailable');
    expect(JSON.stringify(error)).not.toContain(sentinel);
  });

  it('aborts an upstream models request after five seconds', async () => {
    vi.useFakeTimers();
    try {
      let upstreamSignal: AbortSignal | undefined;
      const transport = createCodexModelsTransport({
        tokenProvider: createTokenProvider(),
        upstreamFetch: vi.fn(async (_input, init) => {
          upstreamSignal = init?.signal ?? undefined;
          return await new Promise<Response>(() => undefined);
        }),
      });

      const request = transport(CODEX_MODELS_ENDPOINT);
      const rejection = expect(request).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
      await vi.advanceTimersByTimeAsync(CODEX_MODELS_REQUEST_TIMEOUT_MS);

      await rejection;
      expect(upstreamSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('force-refreshes credentials and replays exactly once after a 401', async () => {
    const tokenProvider = {
      getValidCredentials: vi.fn(async () => ({
        accessToken: 'old-access',
        accountId: 'account-id',
      })),
      refreshIfCurrent: vi.fn(async () => ({
        accessToken: 'fresh-access',
        accountId: 'account-id',
      })),
    } satisfies CodexTokenProvider & {
      refreshIfCurrent(expected: {
        accessToken: string;
        accountId: string;
      }): Promise<{ accessToken: string; accountId: string }>;
    };
    const upstreamFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('first-sensitive-body', { status: 401 }))
      .mockResolvedValueOnce(modelResponse([]));
    const transport = createCodexModelsTransport({ tokenProvider, upstreamFetch });

    await expect(transport(CODEX_MODELS_ENDPOINT)).resolves.toBeInstanceOf(Response);

    expect(tokenProvider.getValidCredentials).toHaveBeenCalledTimes(1);
    expect(tokenProvider.getValidCredentials).toHaveBeenCalledWith();
    expect(tokenProvider.refreshIfCurrent).toHaveBeenCalledOnce();
    expect(tokenProvider.refreshIfCurrent).toHaveBeenCalledWith({
      accessToken: 'old-access',
      accountId: 'account-id',
    });
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
    expect(new Headers(upstreamFetch.mock.calls[0][1]?.headers).get('authorization')).toBe(
      'Bearer old-access',
    );
    expect(new Headers(upstreamFetch.mock.calls[1][1]?.headers).get('authorization')).toBe(
      'Bearer fresh-access',
    );
  });

  it('does not retry a second 401 or expose response and refresh failures', async () => {
    const tokenProvider = {
      getValidCredentials: vi.fn(async () => ({
        accessToken: 'old-access',
        accountId: 'account-id',
      })),
      refreshIfCurrent: vi.fn(async () => ({
        accessToken: 'fresh-access',
        accountId: 'account-id',
      })),
    } satisfies CodexTokenProvider & {
      refreshIfCurrent(expected: {
        accessToken: string;
        accountId: string;
      }): Promise<{ accessToken: string; accountId: string }>;
    };
    const upstreamFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('first-sensitive-body', { status: 401 }))
      .mockResolvedValueOnce(new Response('second-sensitive-body', { status: 401 }));
    const transport = createCodexModelsTransport({ tokenProvider, upstreamFetch });

    const error = await transport(CODEX_MODELS_ENDPOINT).catch((caught) => caught);

    expect(error).toMatchObject({ code: 'AUTH_REQUIRED', upstreamStatus: 401 });
    expect(String(error)).not.toContain('sensitive-body');
    expect(JSON.stringify(error)).not.toContain('sensitive-body');
    expect(tokenProvider.getValidCredentials).toHaveBeenCalledTimes(1);
    expect(tokenProvider.refreshIfCurrent).toHaveBeenCalledTimes(1);
    expect(upstreamFetch).toHaveBeenCalledTimes(2);

    const refreshFailureTokenProvider = {
      getValidCredentials: vi.fn(async () => ({
        accessToken: 'old-access',
        accountId: 'account-id',
      })),
      refreshIfCurrent: vi.fn(async () => {
        throw new Error('refresh-secret-cause');
      }),
    };
    const refreshFailure = createCodexModelsTransport({
      tokenProvider: refreshFailureTokenProvider,
      upstreamFetch: vi.fn(async () => new Response('body-secret', { status: 401 })),
    });
    const refreshError = await refreshFailure(CODEX_MODELS_ENDPOINT).catch((caught) => caught);
    expect(refreshError).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(String(refreshError)).not.toContain('refresh-secret-cause');
    expect(JSON.stringify(refreshError)).not.toContain('body-secret');
  });
});

describe('Codex model discovery cache', () => {
  it('uses a five-minute cache scoped to the credential generation', async () => {
    let now = 1_000;
    let generation: string | null = 'account-a:1';
    const upstreamFetch = vi.fn(async () =>
      modelResponse([{ slug: 'gpt-live', visibility: 'list', priority: 1 }], { etag: 'etag-1' }),
    );
    const discovery = new CodexModelDiscovery({
      tokenProvider: createTokenProvider(),
      credentialGeneration: async () => generation,
      upstreamFetch,
      clock: { now: () => now },
    });

    expect((await discovery.getModels()).map((model) => model.id)).toEqual(['gpt-live']);
    now += 299_999;
    await discovery.getModels();
    expect(upstreamFetch).toHaveBeenCalledTimes(1);

    generation = 'account-a:2';
    await discovery.getModels();
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
  });

  it('revalidates with ETag and keeps the cached list on 304', async () => {
    let now = 1_000;
    const upstreamFetch = vi
      .fn()
      .mockResolvedValueOnce(
        modelResponse([{ slug: 'gpt-live', visibility: 'list' }], { etag: 'etag-1' }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const discovery = new CodexModelDiscovery({
      tokenProvider: createTokenProvider(),
      credentialGeneration: async () => 'account-a:1',
      upstreamFetch,
      clock: { now: () => now },
    });

    await discovery.getModels();
    now += 300_001;
    expect((await discovery.getModels()).map((model) => model.id)).toEqual(['gpt-live']);
    const headers = new Headers(upstreamFetch.mock.calls[1][1]?.headers);
    expect(headers.get('if-none-match')).toBe('etag-1');
  });

  it('serves stale last-known-good models on transient failure for the same generation', async () => {
    let now = 1_000;
    const upstreamFetch = vi
      .fn()
      .mockResolvedValueOnce(modelResponse([{ slug: 'gpt-live', visibility: 'list' }]))
      .mockRejectedValueOnce(new Error('network secret'));
    const discovery = new CodexModelDiscovery({
      tokenProvider: createTokenProvider(),
      credentialGeneration: async () => 'account-a:1',
      upstreamFetch,
      clock: { now: () => now },
    });

    await discovery.getModels();
    now += 300_001;
    expect((await discovery.getModels()).map((model) => model.id)).toEqual(['gpt-live']);
  });

  it('uses exact fallback models after a failure with no safe cache', async () => {
    const discovery = new CodexModelDiscovery({
      tokenProvider: createTokenProvider(),
      credentialGeneration: async () => 'account-a:1',
      upstreamFetch: vi.fn(async () => new Response('sentinel', { status: 502 })),
    });

    expect(await discovery.getModels()).toEqual(CODEX_FALLBACK_MODELS);
  });

  it('returns the same-generation stale list when a timed-out refresh is aborted', async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      let upstreamSignal: AbortSignal | undefined;
      const upstreamFetch = vi
        .fn()
        .mockResolvedValueOnce(modelResponse([{ slug: 'gpt-stale', visibility: 'list' }]))
        .mockImplementationOnce(async (_input, init) => {
          upstreamSignal = init?.signal ?? undefined;
          return await new Promise<Response>(() => undefined);
        });
      const discovery = new CodexModelDiscovery({
        tokenProvider: createTokenProvider(),
        credentialGeneration: async () => 'account-a:1',
        upstreamFetch,
        clock: { now: () => now },
      });

      await expect(discovery.getModels()).resolves.toMatchObject([{ id: 'gpt-stale' }]);
      now += 300_001;
      const refresh = discovery.getModels();
      await vi.advanceTimersByTimeAsync(CODEX_MODELS_REQUEST_TIMEOUT_MS);

      await expect(refresh).resolves.toMatchObject([{ id: 'gpt-stale' }]);
      expect(upstreamSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns fallback models when a cold discovery request times out', async () => {
    vi.useFakeTimers();
    try {
      const discovery = new CodexModelDiscovery({
        tokenProvider: createTokenProvider(),
        credentialGeneration: async () => 'account-a:1',
        upstreamFetch: vi.fn(async () => await new Promise<Response>(() => undefined)),
      });

      const request = discovery.getModels();
      await vi.advanceTimersByTimeAsync(CODEX_MODELS_REQUEST_TIMEOUT_MS);

      await expect(request).resolves.toEqual(CODEX_FALLBACK_MODELS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears invalid-grant credentials after a models 401 and publishes no fallback models', async () => {
    const credentials: CodexOAuthCredentials = {
      version: 1,
      accessToken: 'expired-access-secret',
      refreshToken: 'invalid-refresh-secret',
      expiresAt: NOW + 3_600_000,
      accountId: 'account-secret',
      updatedAt: NOW,
    };
    const vault = new MemoryVault(credentials);
    const tokenProvider = new ManagedCodexTokenProvider({
      vault,
      clock: { now: () => NOW },
      tokenExchangeFetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: 'invalid_grant',
              error_description: 'refresh-secret-upstream-body',
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
      ),
    });
    const discovery = new CodexModelDiscovery({
      tokenProvider,
      credentialGeneration: () => getCodexCredentialGeneration(vault),
      upstreamFetch: vi.fn(async () => new Response('models-sensitive-body', { status: 401 })),
    });

    await expect(discovery.getModels()).resolves.toEqual([]);
    expect(await vault.load()).toBeNull();
  });

  it('rediscovers models under a same-account generation after a 401 refresh rotates credentials', async () => {
    const credentials: CodexOAuthCredentials = {
      version: 1,
      accessToken: 'old-access-secret',
      refreshToken: 'old-refresh-secret',
      expiresAt: NOW + 3_600_000,
      accountId: 'same-account',
      updatedAt: NOW - 1,
    };
    const vault = new MemoryVault(credentials);
    const refreshedAccess = unsignedJwt({ chatgpt_account_id: 'same-account' });
    const tokenProvider = new ManagedCodexTokenProvider({
      vault,
      clock: { now: () => NOW },
      tokenExchangeFetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: refreshedAccess,
              refresh_token: 'rotated-refresh-secret',
              expires_in: 3600,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    });
    const upstreamFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('expired-models-token', { status: 401 }))
      .mockResolvedValueOnce(
        modelResponse([{ slug: 'must-not-cross-generation', visibility: 'list' }]),
      )
      .mockResolvedValueOnce(modelResponse([{ slug: 'gpt-after-refresh', visibility: 'list' }]));
    const discovery = new CodexModelDiscovery({
      tokenProvider,
      credentialGeneration: () => getCodexCredentialGeneration(vault),
      upstreamFetch,
    });

    expect((await discovery.getModels()).map((model) => model.id)).toEqual(['gpt-after-refresh']);
    expect(upstreamFetch).toHaveBeenCalledTimes(3);
    expect((await discovery.getModels()).map((model) => model.id)).toEqual(['gpt-after-refresh']);
    expect(upstreamFetch).toHaveBeenCalledTimes(3);
  });

  it('spends at most one auth replay across a generation-rotation rediscovery', async () => {
    const credentials: CodexOAuthCredentials = {
      version: 1,
      accessToken: 'old-access-secret',
      refreshToken: 'old-refresh-secret',
      expiresAt: NOW + 3_600_000,
      accountId: 'same-account',
      updatedAt: NOW - 1,
    };
    const vault = new MemoryVault(credentials);
    const refreshedAccess = unsignedJwt({ chatgpt_account_id: 'same-account' });
    const tokenExchangeFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: refreshedAccess,
            refresh_token: 'rotated-refresh-secret',
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
    const upstreamFetch = vi.fn(
      async () => new Response('models-sensitive-unauthorized-body', { status: 401 }),
    );
    const discovery = new CodexModelDiscovery({
      tokenProvider,
      credentialGeneration: () => getCodexCredentialGeneration(vault),
      upstreamFetch,
    });

    await expect(discovery.getModels()).resolves.toEqual(CODEX_FALLBACK_MODELS);
    expect(tokenExchangeFetch).toHaveBeenCalledTimes(1);
    expect(upstreamFetch).toHaveBeenCalledTimes(3);
    expect(vault.current?.accessToken).toBe(refreshedAccess);
  });

  it('shares one auth replay across overlapping callers in the same rotation chain', async () => {
    const credentials: CodexOAuthCredentials = {
      version: 1,
      accessToken: 'old-access-secret',
      refreshToken: 'old-refresh-secret',
      expiresAt: NOW + 3_600_000,
      accountId: 'same-account',
      updatedAt: NOW - 1,
    };
    const vault = new MemoryVault(credentials);
    let refreshNumber = 0;
    const tokenExchangeFetch = vi.fn(async () => {
      refreshNumber += 1;
      return new Response(
        JSON.stringify({
          access_token: unsignedJwt({
            chatgpt_account_id: 'same-account',
            refresh_number: refreshNumber,
          }),
          refresh_token: `rotated-refresh-${refreshNumber}`,
          expires_in: 3600,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const tokenProvider = new ManagedCodexTokenProvider({
      vault,
      clock: { now: () => NOW },
      tokenExchangeFetch,
    });
    const firstReplay = deferred<Response>();
    const firstReplayStarted = deferred<void>();
    let modelsRequestNumber = 0;
    const upstreamFetch = vi.fn(async () => {
      modelsRequestNumber += 1;
      if (modelsRequestNumber === 1) {
        return new Response('first-unauthorized-body', { status: 401 });
      }
      if (modelsRequestNumber === 2) {
        firstReplayStarted.resolve();
        return firstReplay.promise;
      }
      return new Response('overlap-unauthorized-body', { status: 401 });
    });
    const discovery = new CodexModelDiscovery({
      tokenProvider,
      credentialGeneration: () => getCodexCredentialGeneration(vault),
      upstreamFetch,
    });

    const callerA = discovery.getModels();
    await firstReplayStarted.promise;
    const callerB = discovery.getModels();
    await expect(callerB).resolves.toEqual(CODEX_FALLBACK_MODELS);
    firstReplay.resolve(new Response('replay-unauthorized-body', { status: 401 }));
    await expect(callerA).resolves.toEqual(CODEX_FALLBACK_MODELS);

    expect(tokenExchangeFetch).toHaveBeenCalledTimes(1);
    expect(upstreamFetch).toHaveBeenCalledTimes(4);
    expect(vault.current?.accountId).toBe('same-account');
  });

  it('never lets an invalidated account flight force-refresh the replacement account', async () => {
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
            access_token: unsignedJwt({ chatgpt_account_id: 'account-b' }),
            refresh_token: 'account-b-rotated-by-stale-flight',
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
    const staleAccountResponse = deferred<Response>();
    const upstreamFetch = vi
      .fn()
      .mockImplementationOnce(() => staleAccountResponse.promise)
      .mockImplementation(async () =>
        modelResponse([{ slug: 'gpt-account-b', visibility: 'list' }]),
      );
    const discovery = new CodexModelDiscovery({
      tokenProvider,
      credentialGeneration: () => getCodexCredentialGeneration(vault),
      upstreamFetch,
    });

    const accountARequest = discovery.getModels();
    await vi.waitFor(() => expect(upstreamFetch).toHaveBeenCalledTimes(1));
    const accountB: CodexOAuthCredentials = {
      version: 1,
      accessToken: 'account-b-access',
      refreshToken: 'account-b-refresh',
      expiresAt: NOW + 3_600_000,
      accountId: 'account-b',
      updatedAt: NOW + 1,
    };
    await vault.save(accountB);
    const accountBGeneration = await getCodexCredentialGeneration(vault);
    discovery.invalidate();
    staleAccountResponse.resolve(new Response('stale-account-unauthorized', { status: 401 }));

    await expect(accountARequest).resolves.toEqual([]);
    expect(tokenExchangeFetch).not.toHaveBeenCalled();
    expect(vault.current).toEqual(accountB);
    expect(await getCodexCredentialGeneration(vault)).toBe(accountBGeneration);

    await expect(discovery.getModels()).resolves.toMatchObject([{ id: 'gpt-account-b' }]);
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
  });

  it('never returns fallback or stale models after credentials disappear', async () => {
    let generation: string | null = 'account-a:1';
    const discovery = new CodexModelDiscovery({
      tokenProvider: createTokenProvider(),
      credentialGeneration: async () => generation,
      upstreamFetch: vi.fn(async () => modelResponse([{ slug: 'gpt-live', visibility: 'list' }])),
    });
    await discovery.getModels();
    generation = null;

    expect(await discovery.getModels()).toEqual([]);
  });

  it('drops stale models when explicitly invalidated after login or logout', async () => {
    const upstreamFetch = vi
      .fn()
      .mockResolvedValueOnce(modelResponse([{ slug: 'gpt-old', visibility: 'list' }]))
      .mockResolvedValueOnce(modelResponse([{ slug: 'gpt-new', visibility: 'list' }]));
    const discovery = new CodexModelDiscovery({
      tokenProvider: createTokenProvider(),
      credentialGeneration: async () => 'account-a:1',
      upstreamFetch,
    });

    await discovery.getModels();
    discovery.invalidate();
    expect((await discovery.getModels()).map((model) => model.id)).toEqual(['gpt-new']);
  });

  it('does not let a new credential generation join an older in-flight refresh', async () => {
    let generation: string | null = 'account-a:1';
    const accountA = deferred<Response>();
    const upstreamFetch = vi
      .fn()
      .mockImplementationOnce(() => accountA.promise)
      .mockResolvedValueOnce(modelResponse([{ slug: 'gpt-b', visibility: 'list' }]));
    const tokenProvider = {
      getValidCredentials: vi.fn(async () => ({
        accessToken: 'access-secret',
        accountId: generation?.startsWith('account-b') ? 'account-b' : 'account-a',
      })),
    } satisfies CodexTokenProvider;
    const discovery = new CodexModelDiscovery({
      tokenProvider,
      credentialGeneration: async () => generation,
      upstreamFetch,
    });

    const accountARequest = discovery.getModels();
    await vi.waitFor(() => expect(upstreamFetch).toHaveBeenCalledTimes(1));
    generation = 'account-b:1';
    const accountBRequest = discovery.getModels();
    await vi.waitFor(() => expect(upstreamFetch).toHaveBeenCalledTimes(2));
    accountA.resolve(modelResponse([{ slug: 'gpt-a', visibility: 'list' }]));

    expect((await accountBRequest).map((model) => model.id)).toEqual(['gpt-b']);
    expect(await accountARequest).toEqual([]);
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
  });

  it('does not repopulate or return an in-flight model cache after logout', async () => {
    let generation: string | null = 'account-a:1';
    const oldResponse = deferred<Response>();
    const upstreamFetch = vi
      .fn()
      .mockImplementationOnce(() => oldResponse.promise)
      .mockResolvedValueOnce(modelResponse([{ slug: 'gpt-after-login', visibility: 'list' }]));
    const discovery = new CodexModelDiscovery({
      tokenProvider: createTokenProvider(),
      credentialGeneration: async () => generation,
      upstreamFetch,
    });

    const oldRequest = discovery.getModels();
    await vi.waitFor(() => expect(upstreamFetch).toHaveBeenCalledTimes(1));
    generation = null;
    expect(await discovery.getModels()).toEqual([]);
    oldResponse.resolve(modelResponse([{ slug: 'gpt-before-logout', visibility: 'list' }]));
    expect(await oldRequest).toEqual([]);

    generation = 'account-a:1';
    expect((await discovery.getModels()).map((model) => model.id)).toEqual(['gpt-after-login']);
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
  });

  it('settles a token refresh before choosing the cache generation', async () => {
    let generation = 'account-a:old-token';
    const tokenProvider = {
      getValidCredentials: vi.fn(async () => {
        generation = 'account-a:new-token';
        return { accessToken: 'new-access', accountId: 'account-a' };
      }),
    } satisfies CodexTokenProvider;
    const upstreamFetch = vi.fn(async () =>
      modelResponse([{ slug: 'gpt-after-refresh', visibility: 'list' }]),
    );
    const discovery = new CodexModelDiscovery({
      tokenProvider,
      credentialGeneration: async () => generation,
      upstreamFetch,
    });

    expect((await discovery.getModels()).map((model) => model.id)).toEqual(['gpt-after-refresh']);
    expect(tokenProvider.getValidCredentials).toHaveBeenCalled();
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps stale or fallback models when refresh fails but credentials remain', async () => {
    let now = 1_000;
    let refreshFails = false;
    const tokenProvider = {
      getValidCredentials: vi.fn(async () => {
        if (refreshFails) throw new Error('network failure sentinel');
        return { accessToken: 'access', accountId: 'account-a' };
      }),
    } satisfies CodexTokenProvider;
    const discovery = new CodexModelDiscovery({
      tokenProvider,
      credentialGeneration: async () => 'account-a:1',
      upstreamFetch: vi.fn(async () =>
        modelResponse([{ slug: 'gpt-last-known-good', visibility: 'list' }]),
      ),
      clock: { now: () => now },
    });

    await discovery.getModels();
    refreshFails = true;
    now += 300_001;
    expect((await discovery.getModels()).map((model) => model.id)).toEqual(['gpt-last-known-good']);

    const coldDiscovery = new CodexModelDiscovery({
      tokenProvider,
      credentialGeneration: async () => 'account-a:1',
      upstreamFetch: vi.fn(),
    });
    expect(await coldDiscovery.getModels()).toEqual(CODEX_FALLBACK_MODELS);
  });
});
