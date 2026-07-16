import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_COMPATIBILITY_VERSION,
  CODEX_MODELS_ENDPOINT,
  CODEX_MODELS_REQUEST_TIMEOUT_MS,
  CodexModelDiscovery,
  createCodexModelsTransport,
  getCodexFallbackModels,
  getCodexCredentialGeneration,
  parseCodexModels,
} from '@/lib/server/codex/models';
import {
  CODEX_OAUTH_ERROR_CODES,
  CodexOAuthError,
  ManagedCodexTokenProvider,
  type CodexTokenProvider,
} from '@/lib/server/codex/token-provider';
import type { CodexCredentialVault, CodexOAuthCredentials } from '@/lib/server/codex/vault';
import type {
  CodexModelCatalogCacheEntry,
  CodexModelCatalogStore,
} from '@/lib/server/codex/model-cache-store';
import type { ModelInfo } from '@/lib/types/provider';

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

class MemoryCatalogStore implements CodexModelCatalogStore {
  current: { accountId: string; entry: CodexModelCatalogCacheEntry } | null = null;
  readonly saves: Array<{ accountId: string; entry: CodexModelCatalogCacheEntry }> = [];
  clearCount = 0;

  async load(accountId: string): Promise<CodexModelCatalogCacheEntry | null> {
    return this.current?.accountId === accountId ? structuredClone(this.current.entry) : null;
  }

  async save(
    accountId: string,
    models: ModelInfo[],
    validatedAt: number,
    options?: { shouldCommit?(): boolean | Promise<boolean> },
  ): Promise<boolean> {
    if (options?.shouldCommit && !(await options.shouldCommit())) return false;
    const entry = { models: structuredClone(models), validatedAt };
    this.saves.push({ accountId, entry });
    this.current = { accountId, entry };
    return true;
  }

  async clear(): Promise<void> {
    this.clearCount += 1;
    this.current = null;
  }
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
      {
        id: 'gpt-last',
        name: 'Duplicate',
        capabilities: { streaming: true, tools: true },
        source: 'probed',
      },
      {
        id: 'gpt-chatgpt-only',
        name: 'gpt-chatgpt-only',
        capabilities: { streaming: true, tools: true },
        source: 'probed',
      },
      {
        id: 'gpt-first',
        name: 'GPT First',
        capabilities: { streaming: true, tools: true },
        source: 'probed',
      },
    ]);
  });

  it('exposes only the supported Fast service tier from current and legacy catalog metadata', () => {
    const parsed = parseCodexModels({
      models: [
        {
          slug: 'ranking-priority-only',
          visibility: 'list',
          priority: 1,
        },
        {
          slug: 'modern-fast',
          visibility: 'list',
          priority: 10,
          service_tiers: [
            { id: 'priority', name: 'Fast' },
            { id: 'flex', name: 'Flex' },
            { id: 7 },
            'priority',
          ],
        },
        {
          slug: 'legacy-fast',
          visibility: 'list',
          priority: 20,
          additional_speed_tiers: ['fast', 'unknown', null],
        },
        {
          slug: 'malformed-tiers',
          visibility: 'list',
          priority: 30,
          service_tiers: [{ id: 'fast' }, { id: ' priority' }, null],
          additional_speed_tiers: ['priority', { id: 'fast' }],
        },
      ],
    });

    expect(parsed).toEqual([
      {
        id: 'ranking-priority-only',
        name: 'ranking-priority-only',
        source: 'probed',
        capabilities: { streaming: true, tools: true },
      },
      {
        id: 'modern-fast',
        name: 'modern-fast',
        source: 'probed',
        capabilities: { streaming: true, tools: true, serviceTiers: ['priority'] },
      },
      {
        id: 'legacy-fast',
        name: 'legacy-fast',
        source: 'probed',
        capabilities: { streaming: true, tools: true, serviceTiers: ['priority'] },
      },
      {
        id: 'malformed-tiers',
        name: 'malformed-tiers',
        source: 'probed',
        capabilities: { streaming: true, tools: true },
      },
    ]);
  });

  it('rebuilds rich safe metadata, filters unknown efforts, and omits upstream-only fields', () => {
    const upstream = {
      models: [
        {
          slug: 'gpt-safe',
          display_name: 'GPT Safe',
          visibility: 'list',
          context_window: 372_000,
          input_modalities: ['text', 'image'],
          default_reasoning_level: 'medium',
          supported_reasoning_levels: [
            { effort: 'low', description: 'must not cross the boundary' },
            { effort: 'medium' },
            { effort: 'ultra' },
            { effort: 'medium' },
            null,
          ],
          service_tiers: [{ id: 'priority', description: 'must not cross the boundary' }],
          base_instructions: 'secret prompt',
          description: 'private upstream description',
          available_in_plans: ['plus'],
          account_id: 'raw-account',
        },
        {
          id: 'legacy-id',
          name: 'Legacy Name',
          visibility: 'list',
          context_window: 0,
          input_modalities: 'image',
          default_reasoning_level: 'ultra',
          supported_reasoning_levels: [{ effort: 'ultra' }, { effort: 7 }],
        },
      ],
    };

    const parsed = parseCodexModels(upstream);

    expect(parsed).toEqual([
      {
        id: 'gpt-safe',
        name: 'GPT Safe',
        contextWindow: 372_000,
        capabilities: {
          streaming: true,
          tools: true,
          vision: true,
          thinking: {
            control: 'effort',
            requestAdapter: 'openai',
            defaultMode: 'enabled',
            effortValues: ['low', 'medium'],
            defaultEffort: 'medium',
            toggleable: false,
            budgetAdjustable: true,
            defaultEnabled: true,
          },
          serviceTiers: ['priority'],
        },
        source: 'probed',
      },
      {
        id: 'legacy-id',
        name: 'Legacy Name',
        capabilities: { streaming: true, tools: true },
        source: 'probed',
      },
    ]);
    expect(JSON.stringify(parsed)).not.toMatch(
      /secret prompt|private upstream|available_in_plans|raw-account|description|ultra/,
    );

    parsed[0].capabilities!.thinking!.effortValues!.push('high');
    expect(upstream.models[0].supported_reasoning_levels).toHaveLength(5);
  });

  it('uses the exact audited fallback list and never grants Fast statically', () => {
    expect(
      getCodexFallbackModels().map((model) => ({
        id: model.id,
        contextWindow: model.contextWindow,
      })),
    ).toEqual([
      { id: 'gpt-5.6-sol', contextWindow: 372_000 },
      { id: 'gpt-5.6-terra', contextWindow: 372_000 },
      { id: 'gpt-5.6-luna', contextWindow: 372_000 },
      { id: 'gpt-5.5', contextWindow: 272_000 },
      { id: 'gpt-5.2', contextWindow: 272_000 },
    ]);
    expect(
      getCodexFallbackModels().every(
        (model) => !model.capabilities?.serviceTiers?.includes('priority'),
      ),
    ).toBe(true);
  });

  it('returns an isolated fallback catalog that callers cannot poison', () => {
    const first = getCodexFallbackModels();
    first[0]!.capabilities!.serviceTiers = ['priority'];
    first[0]!.name = 'mutated';

    const second = getCodexFallbackModels();
    expect(second[0]!.name).toBe('GPT-5.6 Sol');
    expect(second[0]!.capabilities?.serviceTiers).toBeUndefined();
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

  it('keeps the timeout active while a successful response body is stalled', async () => {
    vi.useFakeTimers();
    try {
      let upstreamSignal: AbortSignal | undefined;
      const transport = createCodexModelsTransport({
        tokenProvider: createTokenProvider(),
        upstreamFetch: vi.fn(async (_input, init) => {
          upstreamSignal = init?.signal ?? undefined;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"models":['));
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
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

  it('keeps the parent abort active after successful response headers arrive', async () => {
    const parent = new AbortController();
    const headersReturned = deferred<void>();
    const transport = createCodexModelsTransport({
      tokenProvider: createTokenProvider(),
      upstreamFetch: vi.fn(async () => {
        headersReturned.resolve();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"models":['));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    });

    const request = transport(CODEX_MODELS_ENDPOINT, { signal: parent.signal });
    await headersReturned.promise;
    parent.abort();

    await expect(request).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('cancels a successful response body when abort wins before body reading starts', async () => {
    const parent = new AbortController();
    const cancelBody = vi.fn();
    const transport = createCodexModelsTransport({
      tokenProvider: createTokenProvider(),
      upstreamFetch: vi.fn(async () => {
        // A custom fetch may resolve despite observing an abort. Exercise the
        // gap between response resolution and installing the body listener.
        parent.abort();
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel: cancelBody,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    });

    await expect(transport(CODEX_MODELS_ENDPOINT, { signal: parent.signal })).rejects.toMatchObject(
      { code: 'NETWORK_ERROR' },
    );
    await vi.waitFor(() => expect(cancelBody).toHaveBeenCalledTimes(1));
  });

  it('rejects an oversized successful model catalog without retaining its body', async () => {
    const transport = createCodexModelsTransport({
      tokenProvider: createTokenProvider(),
      upstreamFetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ models: [], padding: 'x'.repeat(2 * 1024 * 1024) }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    });

    await expect(transport(CODEX_MODELS_ENDPOINT)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('force-refreshes credentials and replays exactly once after a 401', async () => {
    let currentCredentials = { accessToken: 'old-access', accountId: 'account-id' };
    const tokenProvider = {
      getValidCredentials: vi.fn(async () => currentCredentials),
      refreshIfCurrent: vi.fn(async () => {
        currentCredentials = { accessToken: 'fresh-access', accountId: 'account-id' };
        return currentCredentials;
      }),
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

    expect(tokenProvider.getValidCredentials).toHaveBeenCalled();
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
    let currentCredentials = { accessToken: 'old-access', accountId: 'account-id' };
    const tokenProvider = {
      getValidCredentials: vi.fn(async () => currentCredentials),
      refreshIfCurrent: vi.fn(async () => {
        currentCredentials = { accessToken: 'fresh-access', accountId: 'account-id' };
        return currentCredentials;
      }),
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
    expect(tokenProvider.getValidCredentials).toHaveBeenCalled();
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
  it('expires a resolved capability when the same-account catalog revokes it', async () => {
    let now = NOW;
    const upstreamFetch = vi
      .fn()
      .mockResolvedValueOnce(
        modelResponse([
          {
            slug: 'gpt-bound',
            visibility: 'list',
            service_tiers: [{ id: 'priority' }],
          },
        ]),
      )
      .mockResolvedValueOnce(modelResponse([{ slug: 'gpt-bound', visibility: 'list' }]));
    const discovery = new CodexModelDiscovery({
      tokenProvider: createTokenProvider(),
      credentialGeneration: async () => 'account-a:1',
      upstreamFetch,
      clock: { now: () => now },
    });

    const resolved = await discovery.getModelCapability('gpt-bound');
    expect(resolved?.modelInfo.capabilities?.serviceTiers).toEqual(['priority']);

    now += 300_001;
    await discovery.getModels();

    expect(await resolved?.capabilityLease.isCatalogCurrent()).toBe(false);
  });

  it.each([400, 401, 403, 429])(
    'does not publish stale, LKG, or bundled models for non-recoverable HTTP %s',
    async (status) => {
      const store = new MemoryCatalogStore();
      store.current = {
        accountId: 'account-secret',
        entry: {
          models: [{ id: 'gpt-lkg', name: 'GPT LKG' }],
          validatedAt: NOW,
        },
      };
      const discovery = new CodexModelDiscovery({
        tokenProvider: createTokenProvider(),
        credentialGeneration: async () => 'generation-1',
        upstreamFetch: vi.fn(async () => new Response('sensitive body', { status })),
        catalogStore: store,
        clock: { now: () => NOW },
      });

      await expect(discovery.getModels()).resolves.toEqual([]);
    },
  );

  it('does not publish a catalog when credential loading reports auth required', async () => {
    const store = new MemoryCatalogStore();
    store.current = {
      accountId: 'account-secret',
      entry: { models: [{ id: 'gpt-lkg', name: 'GPT LKG' }], validatedAt: NOW },
    };
    const discovery = new CodexModelDiscovery({
      tokenProvider: {
        getValidCredentials: vi.fn(async () => {
          throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.CREDENTIALS_MISSING, false);
        }),
      },
      credentialGeneration: async () => 'preserved-generation',
      credentialAccountId: async () => 'account-secret',
      upstreamFetch: vi.fn(),
      catalogStore: store,
      clock: { now: () => NOW },
    });

    await expect(discovery.getModels()).resolves.toEqual([]);
  });

  it('rejects discovery when credentials switch between the account and generation snapshots', async () => {
    let credentials = { accessToken: 'account-a-token', accountId: 'account-a' };
    const tokenProvider = {
      getValidCredentials: vi.fn(async () => credentials),
      refreshIfCurrent: vi.fn(async () => credentials),
    } satisfies CodexTokenProvider & {
      refreshIfCurrent(): Promise<{ accessToken: string; accountId: string }>;
    };
    const store = new MemoryCatalogStore();
    const upstreamFetch = vi.fn(async () =>
      modelResponse([{ slug: 'gpt-account-b-only', visibility: 'list' }]),
    );
    const discovery = new CodexModelDiscovery({
      tokenProvider,
      credentialGeneration: async () => {
        credentials = { accessToken: 'account-b-token', accountId: 'account-b' };
        return 'generation-b';
      },
      upstreamFetch,
      catalogStore: store,
      clock: { now: () => NOW },
    });

    await expect(discovery.getModels()).resolves.toEqual([]);
    expect(upstreamFetch).not.toHaveBeenCalled();
    expect(store.saves).toEqual([]);
  });

  it('keeps fresh memory across a same-account refresh rotation', async () => {
    let generation = 'generation-1';
    const upstreamFetch = vi.fn(async () =>
      modelResponse([{ slug: 'gpt-live', visibility: 'list' }]),
    );
    const discovery = new CodexModelDiscovery({
      tokenProvider: createTokenProvider(),
      credentialGeneration: async () => generation,
      upstreamFetch,
      clock: { now: () => NOW },
    });

    await expect(discovery.getModels()).resolves.toMatchObject([{ id: 'gpt-live' }]);
    generation = 'generation-2';
    await expect(discovery.getModels()).resolves.toMatchObject([{ id: 'gpt-live' }]);

    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('persists successful 200 and valid 304 validation times while keeping ETag memory-only', async () => {
    let now = NOW;
    const store = new MemoryCatalogStore();
    const upstreamFetch = vi
      .fn()
      .mockResolvedValueOnce(
        modelResponse([{ slug: 'gpt-live', visibility: 'list' }], { etag: 'private-etag' }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const discovery = new CodexModelDiscovery({
      tokenProvider: createTokenProvider(),
      credentialGeneration: async () => 'generation-1',
      upstreamFetch,
      catalogStore: store,
      clock: { now: () => now },
    });

    await discovery.getModels();
    now += 5 * 60 * 1000;
    await discovery.getModels();

    expect(store.saves.map((save) => save.entry.validatedAt)).toEqual([NOW, now]);
    expect(JSON.stringify(store.saves)).not.toContain('private-etag');
    expect(new Headers(upstreamFetch.mock.calls[1][1]?.headers).get('if-none-match')).toBe(
      'private-etag',
    );
  });

  it('prefers same-account stale memory over LKG after a malformed live response', async () => {
    let now = NOW;
    const store = new MemoryCatalogStore();
    store.current = {
      accountId: 'account-secret',
      entry: {
        models: [{ id: 'gpt-lkg', name: 'GPT LKG' }],
        validatedAt: NOW - 1,
      },
    };
    const upstreamFetch = vi
      .fn()
      .mockResolvedValueOnce(modelResponse([{ slug: 'gpt-memory', visibility: 'list' }]))
      .mockResolvedValueOnce(new Response('{"models":', { status: 200 }));
    const discovery = new CodexModelDiscovery({
      tokenProvider: createTokenProvider(),
      credentialGeneration: async () => 'generation-1',
      upstreamFetch,
      catalogStore: store,
      clock: { now: () => now },
    });

    await discovery.getModels();
    store.current = {
      accountId: 'account-secret',
      entry: {
        models: [{ id: 'gpt-lkg', name: 'GPT LKG' }],
        validatedAt: NOW,
      },
    };
    now += 5 * 60 * 1000;

    await expect(discovery.getModels()).resolves.toMatchObject([{ id: 'gpt-memory' }]);
  });

  it('uses valid same-account LKG before bundled fallback on a cold failure', async () => {
    const store = new MemoryCatalogStore();
    store.current = {
      accountId: 'account-secret',
      entry: {
        models: [
          {
            id: 'gpt-lkg-fast',
            name: 'GPT LKG Fast',
            capabilities: { serviceTiers: ['priority'] },
          },
        ],
        validatedAt: NOW - 1,
      },
    };
    const discovery = new CodexModelDiscovery({
      tokenProvider: createTokenProvider(),
      credentialGeneration: async () => 'generation-1',
      upstreamFetch: vi.fn(async () => {
        throw new Error('network detail');
      }),
      catalogStore: store,
      clock: { now: () => NOW },
    });

    await expect(discovery.getModels()).resolves.toMatchObject([
      {
        id: 'gpt-lkg-fast',
        capabilities: { serviceTiers: ['priority'] },
      },
    ]);
  });

  it('never reuses memory or LKG from another account', async () => {
    let credentials = { accessToken: 'account-a-token', accountId: 'account-a' };
    let generation = 'generation-a';
    let now = NOW;
    const tokenProvider = {
      getValidCredentials: vi.fn(async () => credentials),
      refreshIfCurrent: vi.fn(async () => credentials),
    } satisfies CodexTokenProvider & {
      refreshIfCurrent(): Promise<{ accessToken: string; accountId: string }>;
    };
    const store = new MemoryCatalogStore();
    store.current = {
      accountId: 'account-a',
      entry: { models: [{ id: 'gpt-account-a-lkg', name: 'A' }], validatedAt: NOW },
    };
    const upstreamFetch = vi
      .fn()
      .mockResolvedValueOnce(modelResponse([{ slug: 'gpt-account-a', visibility: 'list' }]))
      .mockRejectedValueOnce(new Error('offline'));
    const discovery = new CodexModelDiscovery({
      tokenProvider,
      credentialGeneration: async () => generation,
      upstreamFetch,
      catalogStore: store,
      clock: { now: () => now },
    });

    await discovery.getModels();
    credentials = { accessToken: 'account-b-token', accountId: 'account-b' };
    generation = 'generation-b';
    now += 5 * 60 * 1000;

    const accountBModels = await discovery.getModels();
    expect(accountBModels.map((model) => model.id)).toEqual(
      getCodexFallbackModels().map((model) => model.id),
    );
    expect(JSON.stringify(accountBModels)).not.toContain('account-a');
  });

  it('returns no provider catalog without connected credentials even if an LKG exists', async () => {
    const store = new MemoryCatalogStore();
    store.current = {
      accountId: 'account-secret',
      entry: { models: [{ id: 'gpt-lkg', name: 'GPT LKG' }], validatedAt: NOW },
    };
    const discovery = new CodexModelDiscovery({
      tokenProvider: {
        getValidCredentials: vi.fn(async () => {
          throw new Error('signed out');
        }),
      },
      credentialGeneration: async () => null,
      upstreamFetch: vi.fn(),
      catalogStore: store,
      clock: { now: () => NOW },
    });

    await expect(discovery.getModels()).resolves.toEqual([]);
  });

  it('uses a five-minute cache scoped to the connected account', async () => {
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
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('revalidates instead of treating a future-dated memory entry as fresh after clock rollback', async () => {
    let now = 1_000;
    const upstreamFetch = vi.fn(async () =>
      modelResponse([{ slug: 'gpt-live', visibility: 'list' }]),
    );
    const discovery = new CodexModelDiscovery({
      tokenProvider: createTokenProvider(),
      credentialGeneration: async () => 'account-a:1',
      upstreamFetch,
      clock: { now: () => now },
    });

    await discovery.getModels();
    now -= 1;
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

    expect(await discovery.getModels()).toEqual(getCodexFallbackModels());
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

      await expect(request).resolves.toEqual(getCodexFallbackModels());
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

  it('uses same-account stale models when a 401 refresh fails transiently', async () => {
    let now = 1_000;
    const tokenProvider = createTokenProvider();
    tokenProvider.refreshIfCurrent.mockRejectedValue(
      new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.NETWORK_ERROR, true),
    );
    const upstreamFetch = vi
      .fn()
      .mockResolvedValueOnce(modelResponse([{ slug: 'gpt-stale', visibility: 'list' }]))
      .mockResolvedValueOnce(new Response('expired', { status: 401 }));
    const discovery = new CodexModelDiscovery({
      tokenProvider,
      credentialGeneration: async () => 'account-a:1',
      upstreamFetch,
      clock: { now: () => now },
    });

    await discovery.getModels();
    now += 300_001;

    expect((await discovery.getModels()).map((model) => model.id)).toEqual(['gpt-stale']);
    expect(tokenProvider.refreshIfCurrent).toHaveBeenCalledTimes(1);
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

    await expect(discovery.getModels()).resolves.toEqual([]);
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
    await expect(callerB).resolves.toEqual([]);
    firstReplay.resolve(new Response('replay-unauthorized-body', { status: 401 }));
    await expect(callerA).resolves.toEqual([]);

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

  it('does not return a live catalog after invalidation starts during persistence', async () => {
    const saveStarted = deferred<void>();
    const releaseSave = deferred<void>();
    const store = {
      load: vi.fn(async () => null),
      save: vi.fn(
        async (
          _accountId: string,
          _models: ModelInfo[],
          _validatedAt: number,
          options?: { shouldCommit?(): boolean | Promise<boolean> },
        ) => {
          expect(await options?.shouldCommit?.()).toBe(true);
          saveStarted.resolve();
          await releaseSave.promise;
          return true;
        },
      ),
      clear: vi.fn(async () => undefined),
    } satisfies CodexModelCatalogStore;
    const discovery = new CodexModelDiscovery({
      tokenProvider: createTokenProvider(),
      credentialGeneration: async () => 'account-a:1',
      upstreamFetch: vi.fn(async () =>
        modelResponse([{ slug: 'gpt-before-clear', visibility: 'list' }]),
      ),
      catalogStore: store,
    });

    const request = discovery.getModels();
    await saveStarted.promise;
    const clearing = discovery.clear();
    releaseSave.resolve();

    await clearing;
    await expect(request).resolves.toEqual([]);
  });

  it('keeps the store commit guard synchronous to avoid vault/cache lock inversion', async () => {
    let storeMutationHeld = false;
    let generationReadInsideStore = false;
    const store = {
      load: vi.fn(async () => null),
      save: vi.fn(
        async (
          _accountId: string,
          _models: ModelInfo[],
          _validatedAt: number,
          options?: { shouldCommit?(): boolean | Promise<boolean> },
        ) => {
          storeMutationHeld = true;
          expect(await options?.shouldCommit?.()).toBe(true);
          storeMutationHeld = false;
          return true;
        },
      ),
      clear: vi.fn(async () => undefined),
    } satisfies CodexModelCatalogStore;
    const discovery = new CodexModelDiscovery({
      tokenProvider: createTokenProvider(),
      credentialGeneration: async () => {
        if (storeMutationHeld) generationReadInsideStore = true;
        return 'account-a:1';
      },
      upstreamFetch: vi.fn(async () =>
        modelResponse([{ slug: 'gpt-lock-safe', visibility: 'list' }]),
      ),
      catalogStore: store,
    });

    await expect(discovery.getModels()).resolves.toMatchObject([{ id: 'gpt-lock-safe' }]);
    expect(generationReadInsideStore).toBe(false);
  });

  it('does not dereference or return a 304 catalog cleared during persistence', async () => {
    let now = NOW;
    let saveCount = 0;
    const revalidationSaveStarted = deferred<void>();
    const releaseRevalidationSave = deferred<void>();
    const store = {
      load: vi.fn(async () => null),
      save: vi.fn(async () => {
        saveCount += 1;
        if (saveCount === 2) {
          revalidationSaveStarted.resolve();
          await releaseRevalidationSave.promise;
        }
        return true;
      }),
      clear: vi.fn(async () => undefined),
    } satisfies CodexModelCatalogStore;
    const upstreamFetch = vi
      .fn()
      .mockResolvedValueOnce(
        modelResponse([{ slug: 'gpt-before-clear', visibility: 'list' }], {
          etag: 'etag-before-clear',
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const discovery = new CodexModelDiscovery({
      tokenProvider: createTokenProvider(),
      credentialGeneration: async () => 'account-a:1',
      upstreamFetch,
      catalogStore: store,
      clock: { now: () => now },
    });

    await discovery.getModels();
    now += 5 * 60 * 1000;
    const request = discovery.getModels();
    await revalidationSaveStarted.promise;
    const clearing = discovery.clear();
    releaseRevalidationSave.resolve();

    await clearing;
    await expect(request).resolves.toEqual([]);
  });

  it('does not fall back or repopulate memory when invalidated during an LKG read', async () => {
    const loadStarted = deferred<void>();
    const releaseLoad = deferred<void>();
    const store = {
      load: vi.fn(async () => {
        loadStarted.resolve();
        await releaseLoad.promise;
        return {
          models: [{ id: 'gpt-old-lkg', name: 'GPT Old LKG' }],
          validatedAt: NOW,
        };
      }),
      save: vi.fn(async () => true),
      clear: vi.fn(async () => undefined),
    } satisfies CodexModelCatalogStore;
    const discovery = new CodexModelDiscovery({
      tokenProvider: createTokenProvider(),
      credentialGeneration: async () => 'account-a:1',
      upstreamFetch: vi.fn(async () => {
        throw new Error('network failure sentinel');
      }),
      catalogStore: store,
      clock: { now: () => NOW },
    });

    const request = discovery.getModels();
    await loadStarted.promise;
    const clearing = discovery.clear();
    releaseLoad.resolve();

    await clearing;
    await expect(request).resolves.toEqual([]);
  });

  it('does not let a new login read the old LKG while persistent clear is in flight', async () => {
    const clearStarted = deferred<void>();
    const releaseClear = deferred<void>();
    let cleared = false;
    const store = {
      load: vi.fn(async () =>
        cleared
          ? null
          : {
              models: [{ id: 'gpt-old-lkg', name: 'GPT Old LKG' }],
              validatedAt: NOW,
            },
      ),
      save: vi.fn(async () => true),
      clear: vi.fn(async () => {
        clearStarted.resolve();
        await releaseClear.promise;
        cleared = true;
      }),
    } satisfies CodexModelCatalogStore;
    const discovery = new CodexModelDiscovery({
      tokenProvider: createTokenProvider(),
      credentialGeneration: async () => 'new-login:1',
      upstreamFetch: vi.fn(async () => {
        throw new Error('network failure sentinel');
      }),
      catalogStore: store,
      clock: { now: () => NOW },
    });

    const clearing = discovery.clear();
    await clearStarted.promise;
    const request = discovery.getModels();
    await new Promise<void>((resolveTimer) => setTimeout(resolveTimer, 0));
    releaseClear.resolve();

    await clearing;
    expect((await request).map((model) => model.id)).toEqual(
      getCodexFallbackModels().map((model) => model.id),
    );
    expect(store.load).toHaveBeenCalledTimes(1);
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
        if (refreshFails) {
          throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.NETWORK_ERROR, true);
        }
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
    expect(await coldDiscovery.getModels()).toEqual(getCodexFallbackModels());
  });

  it('prefers same-account stale memory when refresh fails after credential rotation', async () => {
    let generation = 'account-a:token-1';
    let refreshFails = false;
    let now = NOW;
    const tokenProvider = {
      getValidCredentials: vi.fn(async () => {
        if (refreshFails) {
          throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.NETWORK_ERROR, true);
        }
        return { accessToken: 'access', accountId: 'account-a' };
      }),
    } satisfies CodexTokenProvider;
    const store = new MemoryCatalogStore();
    const discovery = new CodexModelDiscovery({
      tokenProvider,
      credentialGeneration: async () => generation,
      credentialAccountId: async () => 'account-a',
      upstreamFetch: vi.fn(async () => modelResponse([{ slug: 'gpt-memory', visibility: 'list' }])),
      catalogStore: store,
      clock: { now: () => now },
    });

    await expect(discovery.getModels()).resolves.toMatchObject([{ id: 'gpt-memory' }]);
    store.current = {
      accountId: 'account-a',
      entry: { models: [{ id: 'gpt-lkg', name: 'GPT LKG' }], validatedAt: NOW },
    };
    generation = 'account-a:token-2';
    refreshFails = true;
    now += 5 * 60 * 1000;

    await expect(discovery.getModels()).resolves.toMatchObject([{ id: 'gpt-memory' }]);
  });

  it('returns no cache when invalidated during the pre-discovery credential-failure LKG read', async () => {
    const loadStarted = deferred<void>();
    const releaseLoad = deferred<void>();
    const store = {
      load: vi.fn(async () => {
        loadStarted.resolve();
        await releaseLoad.promise;
        return {
          models: [{ id: 'gpt-old-lkg', name: 'GPT Old LKG' }],
          validatedAt: NOW,
        };
      }),
      save: vi.fn(async () => true),
      clear: vi.fn(async () => undefined),
    } satisfies CodexModelCatalogStore;
    const discovery = new CodexModelDiscovery({
      tokenProvider: {
        getValidCredentials: vi.fn(async () => {
          throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.NETWORK_ERROR, true);
        }),
      },
      credentialGeneration: async () => 'account-a:1',
      credentialAccountId: async () => 'account-a',
      upstreamFetch: vi.fn(),
      catalogStore: store,
      clock: { now: () => NOW },
    });

    const request = discovery.getModels();
    await loadStarted.promise;
    const clearing = discovery.clear();
    releaseLoad.resolve();

    await clearing;
    await expect(request).resolves.toEqual([]);
  });
});
