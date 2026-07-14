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
}));

vi.mock('@/lib/server/codex/availability', () => ({
  getCodexOAuthAvailability: mocks.availability,
}));

vi.mock('@/lib/server/codex/runtime', () => ({
  getCodexAuthRuntime: mocks.getRuntime,
}));

const ORIGINAL_ACCESS_CODE = process.env.ACCESS_CODE;
const NOW = 1_700_000_000_000;

class MemoryVault implements CodexCredentialVault {
  current: CodexOAuthCredentials | null = null;
  async load() {
    return this.current;
  }
  async save(credentials: CodexOAuthCredentials) {
    this.current = credentials;
  }
  async clear() {
    this.current = null;
  }
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
    methods: ['device'],
  });
  mocks.getRuntime.mockReset();
  mocks.getRuntime.mockImplementation(() => mocks.runtime);
});

afterEach(async () => {
  await mocks.runtime?.loginManager.cancel();
  if (ORIGINAL_ACCESS_CODE === undefined) delete process.env.ACCESS_CODE;
  else process.env.ACCESS_CODE = ORIGINAL_ACCESS_CODE;
});

describe('/api/codex/auth/login', () => {
  it('runs a sanitized device lifecycle and performs no early poll request', async () => {
    let now = NOW;
    const requests: string[] = [];
    const vault = new MemoryVault();
    const oauthFetch = async (input: string) => {
      requests.push(input);
      if (input.endsWith('/usercode')) {
        return Response.json({
          device_auth_id: 'route-private-device-id',
          user_code: 'ROUTE-CODE',
          interval: 5,
        });
      }
      return Response.json({ raw: 'route-private-pending-body' }, { status: 403 });
    };
    mocks.runtime = {
      vault,
      tokenProvider: new ManagedCodexTokenProvider({ vault, tokenExchangeFetch: oauthFetch }),
      loginManager: new CodexLoginManager({
        vault,
        oauthFetch,
        clock: { now: () => now },
      }),
    };
    const route = await import('@/app/api/codex/auth/login/route');

    const started = await route.POST(
      new Request('http://localhost/api/codex/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'device' }),
      }),
    );
    const startBody = await started.json();
    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
    expectNoStore(started);
    expect(startBody).toMatchObject({
      method: 'device',
      status: 'pending',
      userCode: 'ROUTE-CODE',
      interval: 5,
    });
    expect(JSON.stringify(startBody)).not.toMatch(
      /route-private-device-id|accessToken|refreshToken|accountId|authorization_code|code_verifier/,
    );

    const early = await route.PATCH(new Request('http://localhost/api/codex/auth/login'));
    expectNoStore(early);
    expect(requests).toHaveLength(1);
    now += 5_000;
    const due = await route.PATCH(new Request('http://localhost/api/codex/auth/login'));
    expectNoStore(due);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(await due.json())).not.toContain('route-private-pending-body');

    const cancelled = await route.DELETE(new Request('http://localhost/api/codex/auth/login'));
    expectNoStore(cancelled);
    await expect(cancelled.json()).resolves.toEqual({ cancelled: true });
    const absent = await route.PATCH(new Request('http://localhost/api/codex/auth/login'));
    expect(absent.status).toBe(404);
    expectNoStore(absent);
    await expect(absent.json()).resolves.toEqual({ errorCode: 'NO_ACTIVE_ATTEMPT' });
  });

  it('returns stable errors for malformed, unavailable, and unsupported starts', async () => {
    const vault = new MemoryVault();
    mocks.runtime = {
      vault,
      tokenProvider: new ManagedCodexTokenProvider({ vault }),
      loginManager: new CodexLoginManager({ vault }),
    };
    const route = await import('@/app/api/codex/auth/login/route');

    const malformed = await route.POST(
      new Request('http://localhost/api/codex/auth/login', {
        method: 'POST',
        body: '{bad-json',
      }),
    );
    expect(malformed.status).toBe(400);
    expectNoStore(malformed);
    await expect(malformed.json()).resolves.toEqual({ errorCode: 'INVALID_REQUEST' });

    const unsupported = await route.POST(
      new Request('http://localhost/api/codex/auth/login', {
        method: 'POST',
        body: JSON.stringify({ method: 'browser' }),
      }),
    );
    expect(unsupported.status).toBe(400);
    await expect(unsupported.json()).resolves.toEqual({ errorCode: 'METHOD_UNAVAILABLE' });

    mocks.availability.mockResolvedValueOnce({
      available: false,
      reason: 'FEATURE_DISABLED',
      methods: [],
    });
    const unavailable = await route.POST(
      new Request('http://localhost/api/codex/auth/login', {
        method: 'POST',
        body: JSON.stringify({ method: 'device' }),
      }),
    );
    expect(unavailable.status).toBe(503);
    expectNoStore(unavailable);
    await expect(unavailable.json()).resolves.toEqual({
      errorCode: 'UNAVAILABLE',
      reason: 'FEATURE_DISABLED',
    });
  });

  it('enforces ACCESS_CODE on POST, PATCH, and DELETE', async () => {
    const vault = new MemoryVault();
    mocks.runtime = {
      vault,
      tokenProvider: new ManagedCodexTokenProvider({ vault }),
      loginManager: new CodexLoginManager({ vault }),
    };
    process.env.ACCESS_CODE = 'login-route-secret';
    const route = await import('@/app/api/codex/auth/login/route');

    for (const [handler, request] of [
      [
        route.POST,
        new Request('http://localhost/api/codex/auth/login', {
          method: 'POST',
          body: JSON.stringify({ method: 'device' }),
        }),
      ],
      [route.PATCH, new Request('http://localhost/api/codex/auth/login', { method: 'PATCH' })],
      [route.DELETE, new Request('http://localhost/api/codex/auth/login', { method: 'DELETE' })],
    ] as const) {
      const response = await handler(request);
      expect(response.status).toBe(401);
      expectNoStore(response);
    }

    const token = createAccessToken('login-route-secret');
    const authorizedDelete = await route.DELETE(
      new Request('http://localhost/api/codex/auth/login', {
        method: 'DELETE',
        headers: { cookie: `openmaic_access=${token}` },
      }),
    );
    expect(authorizedDelete.status).toBe(200);
  });

  it('blocks polling and cancellation without touching runtime when unavailable', async () => {
    mocks.availability.mockResolvedValue({
      available: false,
      reason: 'ACCESS_CODE_REQUIRED',
      methods: [],
    });
    const route = await import('@/app/api/codex/auth/login/route');

    for (const [handler, method] of [
      [route.PATCH, 'PATCH'],
      [route.DELETE, 'DELETE'],
    ] as const) {
      const response = await handler(
        new Request('http://localhost/api/codex/auth/login', { method }),
      );
      expect(response.status).toBe(503);
      expectNoStore(response);
      await expect(response.json()).resolves.toEqual({
        errorCode: 'UNAVAILABLE',
        reason: 'ACCESS_CODE_REQUIRED',
      });
    }
    expect(mocks.getRuntime).not.toHaveBeenCalled();
  });
});
