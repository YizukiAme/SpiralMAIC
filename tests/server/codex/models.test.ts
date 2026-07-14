import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_FALLBACK_MODELS,
  CODEX_MODELS_ENDPOINT,
  CodexModelDiscovery,
  createCodexModelsTransport,
  parseCodexModels,
} from '@/lib/server/codex/models';
import type { CodexTokenProvider } from '@/lib/server/codex/token-provider';

function createTokenProvider() {
  return {
    getValidCredentials: vi.fn(async () => ({
      accessToken: 'access-secret',
      accountId: 'account-secret',
    })),
  } satisfies CodexTokenProvider;
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('Codex model parsing', () => {
  it('filters unsupported and hidden records, sorts by priority, and deduplicates slugs', () => {
    const parsed = parseCodexModels({
      models: [
        { slug: 'gpt-last', display_name: 'GPT Last', priority: 30, visibility: 'list' },
        { slug: 'gpt-hidden', priority: 1, visibility: 'hide' },
        { slug: 'gpt-unsupported', priority: 2, visibility: 'list', supported_in_api: false },
        { slug: 'gpt-first', name: 'GPT First', priority: 5, visibility: 'list' },
        { slug: 'gpt-last', display_name: 'Duplicate', priority: 0, visibility: 'list' },
        { slug: '', priority: 0, visibility: 'list' },
        null,
      ],
    });

    expect(parsed).toEqual([
      { id: 'gpt-last', name: 'Duplicate', source: 'probed' },
      { id: 'gpt-first', name: 'GPT First', source: 'probed' },
    ]);
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
    const discovery = new CodexModelDiscovery({
      tokenProvider: createTokenProvider(),
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
