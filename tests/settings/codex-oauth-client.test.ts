import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CodexOAuthClient,
  getProviderBadgeTranslationKey,
  syncCodexProviderAndSelect,
  syncServerProvidersAfterAccessUnlock,
} from '@/lib/client/codex-oauth';
import type { CodexAuthPublicStatus, CodexLoginAttempt } from '@/lib/types/codex-auth';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function availableStatus(overrides: Partial<CodexAuthPublicStatus> = {}): CodexAuthPublicStatus {
  return {
    available: true,
    reason: 'AVAILABLE',
    methods: ['browser', 'device'],
    connected: false,
    ...overrides,
  };
}

function pendingDevice(overrides: Partial<CodexLoginAttempt> = {}): CodexLoginAttempt {
  return {
    method: 'device',
    status: 'pending',
    verificationUrl: 'https://auth.openai.com/device',
    userCode: 'ABCD-EFGH',
    interval: 2,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('CodexOAuthClient', () => {
  const changes: Array<ReturnType<CodexOAuthClient['getSnapshot']>> = [];
  const scheduled = new Map<number, () => void>();
  let nextTimer = 1;

  beforeEach(() => {
    changes.length = 0;
    scheduled.clear();
    nextTimer = 1;
  });

  function createClient(
    fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
    overrides: Partial<ConstructorParameters<typeof CodexOAuthClient>[0]> = {},
  ) {
    return new CodexOAuthClient({
      fetcher,
      openPopup: () => null,
      schedule: (callback) => {
        const id = nextTimer++;
        scheduled.set(id, callback);
        return id;
      },
      clearSchedule: (id) => scheduled.delete(id as number),
      onChange: (snapshot) => changes.push(snapshot),
      onLoginComplete: vi.fn(async () => undefined),
      onLogoutComplete: vi.fn(async () => undefined),
      ...overrides,
    });
  }

  it('mounts with one status GET and at most one recovery PATCH', async () => {
    const requests: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? 'GET'} ${String(input)}`);
      if ((init?.method ?? 'GET') === 'GET') return jsonResponse(availableStatus());
      return jsonResponse({ errorCode: 'NO_ACTIVE_ATTEMPT' }, 404);
    });
    const client = createClient(fetcher);

    await client.mount();
    await client.mount();

    expect(requests).toEqual(['GET /api/codex/auth', 'PATCH /api/codex/auth/login']);
    expect(client.getSnapshot().auth).toEqual(availableStatus());
  });

  it('polls a recovered pending attempt recursively with public interval', async () => {
    const responses = [
      jsonResponse(availableStatus()),
      jsonResponse(pendingDevice()),
      jsonResponse(pendingDevice({ interval: 5 })),
      jsonResponse({ method: 'device', status: 'complete' }),
    ];
    const onLoginComplete = vi.fn(async () => undefined);
    const client = createClient(
      vi.fn(async () => responses.shift()!),
      { onLoginComplete },
    );

    await client.mount();
    expect(scheduled.size).toBe(1);
    const firstPoll = [...scheduled.values()][0];
    scheduled.clear();
    await firstPoll();
    expect(scheduled.size).toBe(1);
    const secondPoll = [...scheduled.values()][0];
    scheduled.clear();
    await secondPoll();

    expect(onLoginComplete).toHaveBeenCalledTimes(1);
    expect(client.getSnapshot().attempt?.status).toBe('complete');
    expect(scheduled.size).toBe(0);
  });

  it('locks public actions while a completed login synchronizes providers', async () => {
    const syncGate = deferred();
    const syncStarted = deferred();
    let providersSynced = false;
    const setModel = vi.fn();
    const requests: string[] = [];
    const popup = { closed: false, navigate: vi.fn(), close: vi.fn() };
    const openPopup = vi.fn(() => popup);
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      requests.push(`${method} ${String(input)}`);
      if (String(input) === '/api/codex/auth' && method === 'GET') {
        return jsonResponse(availableStatus());
      }
      if (String(input) === '/api/codex/auth/login' && method === 'PATCH') {
        return requests.filter((request) => request === 'PATCH /api/codex/auth/login').length === 1
          ? jsonResponse({ errorCode: 'NO_ACTIVE_ATTEMPT' }, 404)
          : jsonResponse({ method: 'device', status: 'complete' });
      }
      if (String(input) === '/api/codex/auth/login' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { method: 'browser' | 'device' };
        return body.method === 'browser'
          ? jsonResponse({
              method: 'browser',
              status: 'pending',
              authorizationUrl: 'https://auth.openai.com/oauth/authorize',
              interval: 1,
            })
          : jsonResponse(pendingDevice({ interval: 1 }));
      }
      return jsonResponse({ ok: true });
    });
    const client = createClient(fetcher, {
      openPopup,
      onLoginComplete: () =>
        syncCodexProviderAndSelect(() => ({
          fetchServerProviders: async () => {
            syncStarted.resolve();
            await syncGate.promise;
            providersSynced = true;
          },
          providersConfig: {
            'openai-codex': {
              isServerConfigured: providersSynced,
              models: providersSynced ? [{ id: 'gpt-live' }] : [],
            },
          },
          setModel,
        })),
    });

    await client.mount();
    await client.startDevice();
    const poll = [...scheduled.values()][0];
    scheduled.clear();
    const completing = poll();
    await syncStarted.promise;

    expect(client.getSnapshot()).toMatchObject({
      attempt: { method: 'device', status: 'complete' },
      busy: 'syncing',
    });
    const requestCountDuringSync = requests.length;
    await client.startBrowser();
    await client.startDevice();
    await client.cancel();
    await client.logout();
    await expect(client.testConnection('gpt-live')).resolves.toEqual({
      ok: false,
      messageKey: 'testFailed',
    });

    expect(requests).toHaveLength(requestCountDuringSync);
    expect(openPopup).not.toHaveBeenCalled();
    expect(popup.navigate).not.toHaveBeenCalled();
    syncGate.resolve();
    await completing;

    expect(client.getSnapshot()).toMatchObject({
      auth: { connected: true },
      attempt: { method: 'device', status: 'complete' },
      busy: null,
      errorKey: null,
    });
    expect(setModel).toHaveBeenCalledWith('openai-codex', 'gpt-live');
  });

  it('opens the browser popup synchronously before POST', async () => {
    const events: string[] = [];
    const popup = {
      closed: false,
      navigate: vi.fn((url: string) => events.push(`navigate:${url}`)),
      close: vi.fn(),
    };
    const client = createClient(
      vi.fn(async (_input, init) => {
        events.push(`fetch:${init?.method}`);
        return jsonResponse({
          method: 'browser',
          status: 'pending',
          authorizationUrl: 'https://auth.openai.com/oauth/authorize?public=1',
          expiresAt: Date.now() + 60_000,
        });
      }),
      {
        openPopup: () => {
          events.push('open');
          return popup;
        },
      },
    );

    await client.startBrowser();

    expect(events).toEqual([
      'open',
      'fetch:POST',
      'navigate:https://auth.openai.com/oauth/authorize?public=1',
    ]);
  });

  it('cancels a blocked browser attempt before falling back to device login', async () => {
    const events: string[] = [];
    const client = createClient(
      vi.fn(async (_input, init) => {
        const method = init?.method ?? 'GET';
        if (method === 'POST') {
          const body = JSON.parse(String(init?.body)) as { method: string };
          events.push(`POST:${body.method}`);
          if (body.method === 'device') return jsonResponse(pendingDevice());
          return jsonResponse({
            method: 'browser',
            status: 'pending',
            authorizationUrl: 'https://auth.openai.com/oauth/authorize',
          });
        }
        events.push(method);
        return jsonResponse({ cancelled: true });
      }),
      {
        openPopup: () => {
          events.push('open');
          return null;
        },
      },
    );

    await client.startBrowser();

    expect(events).toEqual(['open', 'POST:browser', 'DELETE', 'POST:device']);
    expect(client.getSnapshot().attempt).toMatchObject({
      method: 'device',
      userCode: 'ABCD-EFGH',
    });
  });

  it('treats a non-null but already-closed popup as blocked after the browser POST', async () => {
    const events: string[] = [];
    const popup = {
      closed: true,
      navigate: vi.fn(() => events.push('navigate')),
      close: vi.fn(),
    };
    const client = createClient(
      vi.fn(async (_input, init) => {
        const method = init?.method ?? 'GET';
        if (method === 'POST') {
          const body = JSON.parse(String(init?.body)) as { method: string };
          events.push(`POST:${body.method}`);
          return body.method === 'browser'
            ? jsonResponse({
                method: 'browser',
                status: 'pending',
                authorizationUrl: 'https://auth.openai.com/oauth/authorize',
              })
            : jsonResponse(pendingDevice());
        }
        events.push(method);
        return jsonResponse({ cancelled: true });
      }),
      {
        openPopup: () => {
          events.push('open');
          return popup;
        },
      },
    );

    await client.startBrowser();

    expect(events).toEqual(['open', 'POST:browser', 'DELETE', 'POST:device']);
    expect(popup.navigate).not.toHaveBeenCalled();
  });

  it('ignores a late poll result from an older login generation', async () => {
    let resolveOldPoll!: (response: Response) => void;
    const oldPoll = new Promise<Response>((resolve) => {
      resolveOldPoll = resolve;
    });
    let patchCount = 0;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        patchCount += 1;
        if (patchCount === 1) return oldPoll;
      }
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { method: string };
        if (body.method === 'browser') {
          return jsonResponse({
            method: 'browser',
            status: 'pending',
            authorizationUrl: 'https://auth.openai.com/oauth/authorize',
            interval: 1,
          });
        }
        return jsonResponse(pendingDevice());
      }
      return jsonResponse({ cancelled: true });
    });
    const popup = { closed: false, navigate: vi.fn(), close: vi.fn() };
    const client = createClient(fetcher, { openPopup: () => popup });

    await client.startBrowser();
    const runOldPoll = [...scheduled.values()][0];
    scheduled.clear();
    const polling = runOldPoll();
    await client.cancel();
    await client.startDevice();
    resolveOldPoll(
      jsonResponse({
        method: 'browser',
        status: 'failed',
        errorCode: 'AUTHORIZATION_REJECTED',
      }),
    );
    await polling;

    expect(client.getSnapshot().attempt).toMatchObject({
      method: 'device',
      status: 'pending',
      userCode: 'ABCD-EFGH',
    });
  });

  it('dispose clears local timers without cancelling the server attempt', async () => {
    const requests: string[] = [];
    const client = createClient(
      vi.fn(async (_input, init) => {
        requests.push(init?.method ?? 'GET');
        return jsonResponse(pendingDevice());
      }),
    );
    await client.startDevice();
    expect(scheduled.size).toBe(1);

    client.dispose();

    expect(scheduled.size).toBe(0);
    expect(requests).toEqual(['POST']);
  });

  it('cancels explicitly with DELETE and never appends the device code to its URL', async () => {
    const requests: Array<{ method: string; body?: string }> = [];
    const client = createClient(
      vi.fn(async (_input, init) => {
        requests.push({ method: init?.method ?? 'GET', body: init?.body as string | undefined });
        return init?.method === 'POST'
          ? jsonResponse(pendingDevice())
          : jsonResponse({ cancelled: true });
      }),
    );
    await client.startDevice();
    expect(client.getSnapshot().attempt?.verificationUrl).toBe('https://auth.openai.com/device');

    await client.cancel();

    expect(requests.map((request) => request.method)).toEqual(['POST', 'DELETE']);
    expect(client.getSnapshot().attempt).toBeNull();
  });

  it.each([
    [401, 'testUnauthorized'],
    [403, 'testForbidden'],
    [429, 'testRateLimited'],
    [500, 'testFailed'],
  ] as const)('maps connection-test status %i to fixed safe copy', async (status, messageKey) => {
    const sentinel = 'private-upstream-body';
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ error: sentinel }, status),
    );
    const client = createClient(fetcher);

    const result = await client.testConnection('gpt-5.5');

    expect(result).toEqual({ ok: false, messageKey });
    const init = fetcher.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ model: 'openai-codex:gpt-5.5' });
    expect(String(init.body)).not.toContain('apiKey');
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it('does not write OAuth state to localStorage', async () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { setItem });
    const client = createClient(vi.fn(async () => jsonResponse(pendingDevice())));

    await client.startDevice();

    expect(setItem).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('keeps only public DTO fields even if a server response contains secret-shaped extras', async () => {
    const client = createClient(
      vi.fn(async () =>
        jsonResponse({
          ...pendingDevice(),
          accessToken: 'private-access',
          refreshToken: 'private-refresh',
          accountId: 'private-account',
          deviceAuthId: 'private-device',
          verifier: 'private-verifier',
          authorizationCode: 'private-auth-code',
        }),
      ),
    );

    await client.startDevice();

    expect(JSON.stringify(client.getSnapshot())).not.toMatch(
      /private-access|private-refresh|private-account|private-device|private-verifier|private-auth-code/,
    );
  });

  it('settles with a fixed error when provider sync rejects after login completes', async () => {
    const responses = [
      jsonResponse(availableStatus()),
      jsonResponse({ errorCode: 'NO_ACTIVE_ATTEMPT' }, 404),
      jsonResponse(pendingDevice({ interval: 1 })),
      jsonResponse({ method: 'device', status: 'complete' }),
    ];
    const client = createClient(
      vi.fn(async () => responses.shift()!),
      {
        onLoginComplete: vi.fn(async () => {
          throw new Error('private-sync-failure');
        }),
      },
    );
    await client.mount();
    await client.startDevice();
    const poll = [...scheduled.values()][0];
    scheduled.clear();

    await expect(poll()).resolves.toBeUndefined();

    expect(client.getSnapshot()).toMatchObject({
      auth: { connected: true },
      busy: null,
      errorKey: 'loginFailed',
    });
  });

  it('stays disconnected and clears busy when provider refresh rejects after logout', async () => {
    const client = createClient(
      vi.fn(async (_input, init) =>
        init?.method === 'DELETE'
          ? jsonResponse({ connected: false })
          : jsonResponse(availableStatus({ connected: true, email: 'person@example.com' })),
      ),
      {
        onLogoutComplete: vi.fn(async () => {
          throw new Error('private-refresh-failure');
        }),
      },
    );
    await client.mount();

    await expect(client.logout()).resolves.toBeUndefined();

    expect(client.getSnapshot()).toMatchObject({
      auth: { connected: false },
      busy: null,
      errorKey: 'loginFailed',
    });
    expect(client.getSnapshot().auth).not.toHaveProperty('email');
  });
});

describe('Codex settings integration helpers', () => {
  it('awaits provider sync, then selects the first Codex model from fresh state', async () => {
    const events: string[] = [];
    let synced = false;
    const setModel = vi.fn((providerId: string, modelId: string) =>
      events.push(`select:${providerId}:${modelId}`),
    );
    const getState = () => ({
      fetchServerProviders: async () => {
        events.push('sync');
        synced = true;
      },
      providersConfig: {
        'openai-codex': {
          isServerConfigured: synced,
          models: synced ? [{ id: 'gpt-live' }, { id: 'gpt-next' }] : [],
        },
      },
      setModel,
    });

    await syncCodexProviderAndSelect(getState);

    expect(events).toEqual(['sync', 'select:openai-codex:gpt-live']);
  });

  it('refreshes server providers after an access-code unlock', async () => {
    const fetchServerProviders = vi.fn(async () => undefined);

    await syncServerProvidersAfterAccessUnlock(() => ({ fetchServerProviders }));

    expect(fetchServerProviders).toHaveBeenCalledTimes(1);
  });

  it('uses Connected only for server-connected OAuth providers', () => {
    expect(
      getProviderBadgeTranslationKey({
        credentialMode: 'oauth',
        isServerConfigured: true,
      }),
    ).toBe('settings.connected');
    expect(
      getProviderBadgeTranslationKey({
        credentialMode: 'api-key',
        isServerConfigured: true,
      }),
    ).toBe('settings.serverConfigured');
    expect(
      getProviderBadgeTranslationKey({
        credentialMode: 'oauth',
        isServerConfigured: false,
      }),
    ).toBeNull();
  });
});
