import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CodexOAuthClient,
  getProviderBadgeTranslationKey,
  selectCodexCapability,
  syncCodexProviderAndSelect,
  syncServerProvidersAfterAccessUnlock,
} from '@/lib/client/codex-oauth';
import type { CodexAuthPublicStatus, CodexLoginAttempt } from '@/lib/types/codex-auth';
import { createModelSettingsClient, type ModelSettingsView } from '@/lib/model-settings/client';

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
      onLoginComplete: async () => {
        syncStarted.resolve();
        await syncGate.promise;
        setModel('openai-codex', 'gpt-live');
      },
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

  it('tracks the selected login method while the device request is starting', async () => {
    const post = deferred<Response>();
    const client = createClient(vi.fn(async () => post.promise));

    const starting = client.startDevice();
    const inFlightSnapshot = client.getSnapshot();
    post.resolve(jsonResponse(pendingDevice()));
    await starting;

    expect(inFlightSnapshot).toMatchObject({
      busy: 'starting',
      startingMethod: 'device',
    });
    expect(client.getSnapshot().startingMethod).toBeNull();
  });

  it('cancels a blocked browser attempt without starting device login', async () => {
    const events: string[] = [];
    const client = createClient(
      vi.fn(async (_input, init) => {
        const method = init?.method ?? 'GET';
        if (method === 'POST') {
          const body = JSON.parse(String(init?.body)) as { method: string };
          events.push(`POST:${body.method}`);
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

    expect(events).toEqual(['open', 'POST:browser', 'DELETE']);
    expect(client.getSnapshot()).toMatchObject({
      attempt: null,
      busy: null,
      startingMethod: null,
      errorKey: 'loginFailed',
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
          return popup;
        },
      },
    );

    await client.startBrowser();

    expect(events).toEqual(['open', 'POST:browser', 'DELETE']);
    expect(popup.navigate).not.toHaveBeenCalled();
    expect(client.getSnapshot()).toMatchObject({
      attempt: null,
      busy: null,
      startingMethod: null,
      errorKey: 'loginFailed',
    });
  });

  it('cancels the browser attempt when popup navigation fails without starting device login', async () => {
    const events: string[] = [];
    const popup = {
      closed: false,
      navigate: vi.fn(() => {
        events.push('navigate');
        throw new Error('navigation blocked');
      }),
      close: vi.fn(() => events.push('close')),
    };
    const client = createClient(
      vi.fn(async (_input, init) => {
        const method = init?.method ?? 'GET';
        if (method === 'POST') {
          const body = JSON.parse(String(init?.body)) as { method: string };
          events.push(`POST:${body.method}`);
          return jsonResponse({
            method: 'browser',
            status: 'pending',
            authorizationUrl: 'https://auth.openai.com/oauth/authorize',
          });
        }
        events.push(method);
        return jsonResponse({ cancelled: true });
      }),
      { openPopup: () => popup },
    );

    await client.startBrowser();

    expect(events).toEqual(['POST:browser', 'navigate', 'close', 'DELETE']);
    expect(client.getSnapshot()).toMatchObject({
      attempt: null,
      busy: null,
      startingMethod: null,
      errorKey: 'loginFailed',
    });
  });

  it('cleans up an invalid browser response without starting device login', async () => {
    const requests: string[] = [];
    const popup = { closed: false, navigate: vi.fn(), close: vi.fn() };
    const client = createClient(
      vi.fn(async (_input, init) => {
        const method = init?.method ?? 'GET';
        if (method === 'POST') {
          const body = JSON.parse(String(init?.body)) as { method: string };
          requests.push(`POST:${body.method}`);
          return jsonResponse({ method: 'browser', status: 'pending' });
        }
        requests.push(method);
        return jsonResponse({ cancelled: true });
      }),
      { openPopup: () => popup },
    );

    await client.startBrowser();

    expect(requests).toEqual(['POST:browser', 'DELETE']);
    expect(popup.navigate).not.toHaveBeenCalled();
    expect(client.getSnapshot()).toMatchObject({
      attempt: null,
      busy: null,
      startingMethod: null,
      errorKey: 'loginFailed',
    });
  });

  it('keeps a newer browser popup owned when stale browser cleanup arrives late', async () => {
    const delayedOldResponse = deferred();
    const oldPopup = { closed: false, navigate: vi.fn(), close: vi.fn() };
    const newPopup = { closed: false, navigate: vi.fn(), close: vi.fn() };
    const client = createClient(
      vi.fn(async (_input, init) =>
        init?.method === 'POST'
          ? jsonResponse({
              method: 'browser',
              status: 'pending',
              authorizationUrl: 'https://auth.openai.com/oauth/authorize',
            })
          : jsonResponse({ cancelled: true }),
      ),
      { openPopup: () => newPopup },
    );
    const staleBrowserCompletion = delayedOldResponse.promise.then(() =>
      (
        client as unknown as {
          failBrowserAttempt: (generation: number, popup: typeof oldPopup) => Promise<void>;
        }
      ).failBrowserAttempt(0, oldPopup),
    );

    await client.startBrowser();
    delayedOldResponse.resolve();
    await staleBrowserCompletion;
    await client.cancel();

    expect(oldPopup.close).toHaveBeenCalledTimes(1);
    expect(newPopup.close).toHaveBeenCalledTimes(1);
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
  const connectedView = (locked = false, allowUserKeys = true): ModelSettingsView => ({
    revision: 1,
    allowUserKeys,
    presets: [],
    providers: [
      {
        id: 'subscription',
        preset: 'openai-codex',
        presetName: 'Codex',
        presetKind: 'single',
        source: 'deployment',
        connected: true,
        capabilities: {
          chat: { registryId: 'openai-codex', models: [{ id: 'gpt-live', name: 'Live' }] },
        },
      },
    ],
    slots: [
      {
        slot: 'llm',
        parent: null,
        capability: 'chat',
        configOnly: false,
        locked,
        source: { kind: 'unconfigured' },
        effective: { status: 'unassigned' },
      },
    ],
  });

  it('refreshes the catalogue before selecting a saved OAuth provider via server slots', async () => {
    const view = connectedView();
    const writes: unknown[] = [];
    const fetcher = vi.fn(async (_input: string, init?: RequestInit) => {
      if (init?.method === 'PUT') writes.push(JSON.parse(String(init.body)));
      return jsonResponse(view);
    });
    await syncCodexProviderAndSelect(createModelSettingsClient(fetcher));
    expect(writes).toEqual([
      {
        revision: 1,
        change: { kind: 'slots', set: { llm: 'subscription:gpt-live' } },
      },
    ]);
    expect(JSON.stringify(writes)).not.toContain('apiKey');
  });

  it('does not override a locked default when a user completes OAuth sign-in', async () => {
    const fetcher = vi.fn(async () => jsonResponse(connectedView(true, false)));
    await syncCodexProviderAndSelect(createModelSettingsClient(fetcher));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  const withImage = (): ModelSettingsView => {
    const view = connectedView();
    view.providers.push({
      id: 'native-image',
      preset: 'codex-image',
      presetName: 'Codex Image',
      presetKind: 'single',
      source: 'deployment',
      connected: true,
      capabilities: {
        image: { registryId: 'codex-image', models: [{ id: 'gpt-image-2', name: 'Image' }] },
      },
    });
    view.slots.push({
      slot: 'image',
      parent: null,
      capability: 'image',
      configOnly: false,
      locked: false,
      source: { kind: 'unconfigured' },
      effective: { status: 'unassigned' },
    });
    return view;
  };

  it.each(['unassigned', 'disabled', 'invalid', 'assigned'] as const)(
    'sign-in selects chat and fills image only when its state is unassigned (%s)',
    async (status) => {
      const view = withImage();
      view.slots[1].effective =
        status === 'disabled'
          ? { status, resolvedAt: 'image', source: 'workspace' }
          : status === 'invalid'
            ? { status, message: 'Existing image provider is unavailable' }
            : status === 'assigned'
              ? {
                  status,
                  resolvedAt: 'image',
                  source: 'workspace',
                  requirements: [],
                  providerId: 'existing-image',
                  providerSource: 'workspace',
                  presetId: 'openai-image',
                  registryId: 'openai-image',
                  modelId: 'existing',
                }
              : { status };
      const writes: unknown[] = [];
      const fetcher = vi.fn(async (_input: string, init?: RequestInit) => {
        if (init?.method === 'PUT') writes.push(JSON.parse(String(init.body)).change);
        return jsonResponse(view);
      });

      await syncCodexProviderAndSelect(createModelSettingsClient(fetcher));

      expect(writes).toEqual([
        {
          kind: 'slots',
          set: {
            llm: 'subscription:gpt-live',
            ...(status === 'unassigned' ? { image: 'native-image:gpt-image-2' } : {}),
          },
        },
      ]);
    },
  );

  it('explicit image selection does not require or mutate chat and may replace off', async () => {
    const view = withImage();
    view.providers.shift();
    view.slots[1].effective = { status: 'disabled', resolvedAt: 'image', source: 'workspace' };
    const writes: unknown[] = [];
    const fetcher = vi.fn(async (_input: string, init?: RequestInit) => {
      if (init?.method === 'PUT') writes.push(JSON.parse(String(init.body)).change);
      return jsonResponse(view);
    });

    await selectCodexCapability('image', createModelSettingsClient(fetcher));

    expect(writes).toEqual([{ kind: 'slots', set: { image: 'native-image:gpt-image-2' } }]);
  });

  it.each(['locked', 'keys-disabled'] as const)(
    'explicit Use cannot create a provider when %s',
    async (gate) => {
      const view = withImage();
      const image = view.providers.pop()!;
      view.presets = [
        {
          id: 'codex-image',
          name: 'Codex Image',
          kind: 'single',
          capabilities: image.capabilities,
          requiresBaseUrl: false,
          customEndpoint: false,
          recommended: {},
        },
      ];
      view.slots[1].locked = gate === 'locked';
      view.allowUserKeys = gate !== 'keys-disabled';
      const fetcher = vi.fn(async () => jsonResponse(view));

      await selectCodexCapability('image', createModelSettingsClient(fetcher));

      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('refreshes server settings after unlock without rewriting saved assignments', async () => {
    const fetcher = vi.fn(async () => jsonResponse(connectedView()));
    await syncServerProvidersAfterAccessUnlock(createModelSettingsClient(fetcher));
    expect(fetcher).toHaveBeenCalledWith('/api/model-config', { cache: 'no-store' });
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
