import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAccessToken } from '@/lib/server/access-token';
import { CodexLoginManager } from '@/lib/server/codex/login-manager';
import { ManagedCodexTokenProvider } from '@/lib/server/codex/token-provider';
import type { CodexAuthRuntime } from '@/lib/server/codex/runtime';
import type { CodexCredentialVault, CodexOAuthCredentials } from '@/lib/server/codex/vault';

const mocks = vi.hoisted(() => ({
  availability: vi.fn(),
  runtime: undefined as unknown as CodexAuthRuntime,
  getRuntime: vi.fn(),
  oauthFetch: vi.fn(),
}));

vi.mock('@/lib/server/codex/availability', () => ({
  getCodexOAuthAvailability: mocks.availability,
}));

vi.mock('@/lib/server/codex/runtime', () => ({
  getCodexAuthRuntime: mocks.getRuntime,
}));

const ORIGINAL_ACCESS_CODE = process.env.ACCESS_CODE;

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

function credentials(): CodexOAuthCredentials {
  return {
    version: 1,
    accessToken: 'private-access',
    refreshToken: 'private-refresh',
    expiresAt: Date.now() + 60_000,
    accountId: 'private-account',
    email: 'connected@example.com',
    updatedAt: Date.now(),
  };
}

function runtimeFor(vault: MemoryVault): CodexAuthRuntime {
  return {
    vault,
    tokenProvider: new ManagedCodexTokenProvider({
      vault,
      tokenExchangeFetch: mocks.oauthFetch,
    }),
    loginManager: new CodexLoginManager({ vault }),
    modelDiscovery: {
      getModels: vi.fn(async () => []),
      invalidate: vi.fn(),
    } as never,
  };
}

function expectNoStore(response: Response): void {
  expect(response.headers.get('cache-control')).toBe('no-store');
}

beforeEach(() => {
  delete process.env.ACCESS_CODE;
  mocks.availability.mockReset();
  mocks.availability.mockResolvedValue({
    available: true,
    reason: 'AVAILABLE',
    methods: ['browser', 'device'],
  });
  mocks.runtime = runtimeFor(new MemoryVault(credentials()));
  mocks.getRuntime.mockReset();
  mocks.getRuntime.mockImplementation(() => mocks.runtime);
  mocks.oauthFetch.mockReset();
  mocks.oauthFetch.mockResolvedValue(new Response(null, { status: 200 }));
});

afterEach(() => {
  if (ORIGINAL_ACCESS_CODE === undefined) delete process.env.ACCESS_CODE;
  else process.env.ACCESS_CODE = ORIGINAL_ACCESS_CODE;
});

describe('/api/codex/auth', () => {
  it('exports dynamic Node handlers and returns connected public status with no secrets', async () => {
    const route = await import('@/app/api/codex/auth/route');
    const response = await route.GET(new Request('http://localhost/api/codex/auth'));
    const body = await response.json();

    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(body).toEqual({
      available: true,
      reason: 'AVAILABLE',
      methods: ['browser', 'device'],
      connected: true,
      email: 'connected@example.com',
    });
    expect(body).not.toHaveProperty('authenticated');
    expect(JSON.stringify(body)).not.toMatch(/private-access|private-refresh|private-account/);
  });

  it('requires a valid openmaic_access cookie whenever ACCESS_CODE is configured', async () => {
    process.env.ACCESS_CODE = 'route-secret';
    const route = await import('@/app/api/codex/auth/route');

    for (const handler of [route.GET, route.DELETE]) {
      const response = await handler(new Request('http://localhost/api/codex/auth'));
      expect(response.status).toBe(401);
      expectNoStore(response);
      await expect(response.json()).resolves.toEqual({ errorCode: 'UNAUTHORIZED' });
    }

    const token = createAccessToken('route-secret');
    const authorized = await route.GET(
      new Request('http://localhost/api/codex/auth', {
        headers: { cookie: `other=x; openmaic_access=${token}` },
      }),
    );
    expect(authorized.status).toBe(200);
  });

  it('cancels login and clears the vault on logout', async () => {
    const route = await import('@/app/api/codex/auth/route');
    const runtime = mocks.runtime;
    const response = await route.DELETE(new Request('http://localhost/api/codex/auth'));

    expect(response.status).toBe(200);
    expectNoStore(response);
    await expect(response.json()).resolves.toEqual({ connected: false });
    await expect(runtime.vault.load()).resolves.toBeNull();
    expect(runtime.modelDiscovery.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.oauthFetch).toHaveBeenCalledTimes(1);
    expect(mocks.oauthFetch.mock.calls[0]?.[0]).toBe('https://auth.openai.com/oauth/revoke');
  });

  it.each([
    ['network rejection', () => Promise.reject(new Error('private revoke route failure'))],
    ['non-2xx response', () => Promise.resolve(new Response('private body', { status: 503 }))],
  ])('returns disconnected and invalidates models after a revoke %s', async (_name, revoke) => {
    mocks.oauthFetch.mockImplementation(revoke);
    const route = await import('@/app/api/codex/auth/route');
    const runtime = mocks.runtime;

    const response = await route.DELETE(new Request('http://localhost/api/codex/auth'));

    expect(response.status).toBe(200);
    expectNoStore(response);
    await expect(response.json()).resolves.toEqual({ connected: false });
    await expect(runtime.vault.load()).resolves.toBeNull();
    expect(mocks.oauthFetch).toHaveBeenCalledTimes(1);
    expect(runtime.modelDiscovery.invalidate).toHaveBeenCalledTimes(1);
  });

  it('does not touch runtime and blocks logout when availability is false', async () => {
    mocks.availability.mockResolvedValue({
      available: false,
      reason: 'ACCESS_CODE_REQUIRED',
      methods: [],
    });
    const route = await import('@/app/api/codex/auth/route');

    const status = await route.GET(new Request('http://localhost/api/codex/auth'));
    expect(status.status).toBe(200);
    expectNoStore(status);
    await expect(status.json()).resolves.toEqual({
      available: false,
      reason: 'ACCESS_CODE_REQUIRED',
      methods: [],
      connected: false,
    });
    expect(mocks.getRuntime).not.toHaveBeenCalled();

    const logout = await route.DELETE(new Request('http://localhost/api/codex/auth'));
    expect(logout.status).toBe(503);
    expectNoStore(logout);
    await expect(logout.json()).resolves.toEqual({
      errorCode: 'UNAVAILABLE',
      reason: 'ACCESS_CODE_REQUIRED',
    });
    expect(mocks.getRuntime).not.toHaveBeenCalled();
  });
});
