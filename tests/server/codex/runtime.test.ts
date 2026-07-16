import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_OAUTH_DEVICE_TOKEN_ENDPOINT,
  CODEX_OAUTH_DEVICE_USERCODE_ENDPOINT,
} from '@/lib/server/codex/oauth';
import {
  CODEX_OAUTH_ERROR_CODES,
  CODEX_OAUTH_REVOKE_ENDPOINT,
  CODEX_OAUTH_TOKEN_ENDPOINT,
} from '@/lib/server/codex/token-provider';
import type { CodexAuthRuntime } from '@/lib/server/codex/runtime';
import type { CodexOAuthCredentials } from '@/lib/server/codex/vault';

const NOW = 1_700_000_000_000;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function unsignedJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.`;
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function runDeviceLogin(
  runtime: CodexAuthRuntime,
  advanceClock: () => void,
): Promise<Awaited<ReturnType<CodexAuthRuntime['loginManager']['poll']>>> {
  await runtime.loginManager.begin('device');
  advanceClock();
  return runtime.loginManager.poll();
}

function createOAuthFetch(options: { rejectFirstRefresh?: boolean } = {}) {
  const verifier = 'runtime-device-verifier';
  let rejectRefresh = options.rejectFirstRefresh === true;
  return vi.fn(async (input: string, init: RequestInit) => {
    if (input === CODEX_OAUTH_DEVICE_USERCODE_ENDPOINT) {
      return jsonResponse({
        device_auth_id: 'runtime-device-auth',
        user_code: 'RUNTIME-CODE',
        interval: 1,
      });
    }
    if (input === CODEX_OAUTH_DEVICE_TOKEN_ENDPOINT) {
      return jsonResponse({
        authorization_code: 'runtime-authorization-code',
        code_verifier: verifier,
        code_challenge: pkceChallenge(verifier),
      });
    }
    if (input === CODEX_OAUTH_REVOKE_ENDPOINT) return new Response(null, { status: 200 });
    if (input === CODEX_OAUTH_TOKEN_ENDPOINT) {
      const body = init.body as URLSearchParams;
      if (body.get('grant_type') === 'refresh_token' && rejectRefresh) {
        rejectRefresh = false;
        return jsonResponse({ error: 'invalid_grant' }, 400);
      }
      return jsonResponse({
        access_token: unsignedJwt({ chatgpt_account_id: 'relogged-account' }),
        refresh_token: 'relogged-refresh',
        expires_in: 600,
      });
    }
    throw new Error(`Unexpected OAuth endpoint: ${input}`);
  });
}

describe('Codex auth runtime', () => {
  it('does not reuse the pre-catalog v3 runtime after a development reload', async () => {
    vi.resetModules();
    const legacyKey = Symbol.for('openmaic.codex.oauth.auth-runtime.v3');
    const host = globalThis as unknown as Record<PropertyKey, unknown>;
    const legacyRuntime = {
      vault: {},
      tokenProvider: {},
      loginManager: {},
      modelDiscovery: {},
    };
    Object.defineProperty(host, legacyKey, {
      value: legacyRuntime,
      configurable: true,
    });

    try {
      const runtimeModule = await import('@/lib/server/codex/runtime');
      expect(runtimeModule.getCodexAuthRuntime()).not.toBe(legacyRuntime);
    } finally {
      delete host[legacyKey];
    }
  });

  it('is lazy, survives module reload, and creates no callback listener on import', async () => {
    const runtimeModule = await import('@/lib/server/codex/runtime');
    const first = runtimeModule.getCodexAuthRuntime();

    expect(first.vault.constructor.name).toBe('FileCodexCredentialVault');
    expect(first.tokenProvider.constructor.name).toBe('ManagedCodexTokenProvider');
    expect(first.loginManager.constructor.name).toBe('CodexLoginManager');
    expect(first.modelDiscovery.constructor.name).toBe('CodexModelDiscovery');
    expect(runtimeModule.getCodexAuthRuntime()).toBe(first);

    vi.resetModules();
    const reloadedModule = await import('@/lib/server/codex/runtime');
    expect(reloadedModule.getCodexAuthRuntime()).toBe(first);

    await expect(first.loginManager.poll()).resolves.toBeNull();
  });

  it('clears the model cache after credentials on logout through the shared lifecycle hook', async () => {
    const runtimeModule = await import('@/lib/server/codex/runtime');
    const vault = {
      current: {
        version: 1 as const,
        accessToken: 'access-secret',
        refreshToken: 'refresh-secret',
        expiresAt: 1_800_000_000_000,
        accountId: 'account-secret',
        updatedAt: 1_700_000_000_000,
      },
      async load() {
        return this.current;
      },
      async save(next: typeof this.current) {
        this.current = next;
      },
      async clear() {
        this.current = null as unknown as typeof this.current;
      },
    };
    const clear = vi.fn(async () => {
      expect(vault.current).toBeNull();
    });
    const catalogStore = {
      load: vi.fn(async () => null),
      save: vi.fn(async () => true),
      clear,
    };
    const runtime = runtimeModule.createCodexAuthRuntime({
      vault,
      catalogStore,
      oauthFetch: vi.fn(async () => new Response(null, { status: 200 })),
    } as Parameters<typeof runtimeModule.createCodexAuthRuntime>[0]);

    await runtime.tokenProvider.logout();

    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('keeps credentials unpublished until a failed logout cache clear is retried by login', async () => {
    const runtimeModule = await import('@/lib/server/codex/runtime');
    let now = NOW;
    let current: CodexOAuthCredentials | null = {
      version: 1,
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: NOW + 60_000,
      accountId: 'old-account',
      updatedAt: NOW,
    };
    const vault = {
      async load() {
        return current;
      },
      async save(next: CodexOAuthCredentials) {
        current = next;
      },
      async clear() {
        current = null;
      },
    };
    let clearAttempts = 0;
    const clear = vi.fn(async () => {
      clearAttempts += 1;
      if (clearAttempts <= 2) throw new Error('catalog clear unavailable');
    });
    const runtime = runtimeModule.createCodexAuthRuntime({
      vault,
      catalogStore: {
        load: vi.fn(async () => null),
        save: vi.fn(async () => true),
        clear,
      },
      oauthFetch: createOAuthFetch(),
      clock: { now: () => now },
    });

    await expect(runtime.tokenProvider.logout()).resolves.toBeUndefined();
    expect(current).toBeNull();
    expect(clear).toHaveBeenCalledTimes(1);

    await expect(
      runDeviceLogin(runtime, () => {
        now += 1_000;
      }),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'STORAGE_ERROR' });
    expect(current).toBeNull();
    expect(clear).toHaveBeenCalledTimes(2);

    await expect(
      runDeviceLogin(runtime, () => {
        now += 1_000;
      }),
    ).resolves.toMatchObject({ status: 'complete' });
    expect(current?.accountId).toBe('relogged-account');
    expect(clear).toHaveBeenCalledTimes(3);
  });

  it('keeps credentials unpublished until a failed invalid-grant cache clear is retried by login', async () => {
    const runtimeModule = await import('@/lib/server/codex/runtime');
    let now = NOW;
    let current: CodexOAuthCredentials | null = {
      version: 1,
      accessToken: 'expired-access',
      refreshToken: 'expired-refresh',
      expiresAt: NOW,
      accountId: 'expired-account',
      updatedAt: NOW,
    };
    const vault = {
      async load() {
        return current;
      },
      async save(next: CodexOAuthCredentials) {
        current = next;
      },
      async clear() {
        current = null;
      },
    };
    let clearAttempts = 0;
    const clear = vi.fn(async () => {
      clearAttempts += 1;
      if (clearAttempts <= 2) throw new Error('catalog clear unavailable');
    });
    const runtime = runtimeModule.createCodexAuthRuntime({
      vault,
      catalogStore: {
        load: vi.fn(async () => null),
        save: vi.fn(async () => true),
        clear,
      },
      oauthFetch: createOAuthFetch({ rejectFirstRefresh: true }),
      clock: { now: () => now },
    });

    await expect(runtime.tokenProvider.getValidCredentials()).rejects.toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.INVALID_GRANT,
    });
    expect(current).toBeNull();
    expect(clear).toHaveBeenCalledTimes(1);

    await expect(
      runDeviceLogin(runtime, () => {
        now += 1_000;
      }),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'STORAGE_ERROR' });
    expect(current).toBeNull();
    expect(clear).toHaveBeenCalledTimes(2);

    await expect(
      runDeviceLogin(runtime, () => {
        now += 1_000;
      }),
    ).resolves.toMatchObject({ status: 'complete' });
    expect(current?.accountId).toBe('relogged-account');
    expect(clear).toHaveBeenCalledTimes(3);
  });
});
