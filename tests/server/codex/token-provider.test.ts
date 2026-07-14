import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_ERROR_CODES,
  CODEX_OAUTH_TOKEN_ENDPOINT,
  ManagedCodexTokenProvider,
  type CodexTokenProvider,
} from '@/lib/server/codex/token-provider';
import type { CodexCredentialVault, CodexOAuthCredentials } from '@/lib/server/codex/vault';

const NOW = 1_700_000_000_000;

function credentials(overrides: Partial<CodexOAuthCredentials> = {}): CodexOAuthCredentials {
  return {
    version: 1,
    accessToken: 'current-access',
    refreshToken: 'current-refresh',
    expiresAt: NOW + 3_600_000,
    accountId: 'current-account',
    email: 'old@example.com',
    updatedAt: NOW - 10_000,
    ...overrides,
  };
}

function unsignedJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.token-endpoint-output`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class MemoryVault implements CodexCredentialVault {
  current: CodexOAuthCredentials | null;
  readonly saved: CodexOAuthCredentials[] = [];
  clearCount = 0;

  constructor(initial: CodexOAuthCredentials | null) {
    this.current = initial;
  }

  async load(): Promise<CodexOAuthCredentials | null> {
    return this.current;
  }

  async save(next: CodexOAuthCredentials): Promise<void> {
    this.saved.push(next);
    this.current = next;
  }

  async clear(): Promise<void> {
    this.clearCount += 1;
    this.current = null;
  }
}

function createProvider(
  vault: CodexCredentialVault,
  tokenExchangeFetch: typeof fetch = vi.fn(),
): ManagedCodexTokenProvider {
  return new ManagedCodexTokenProvider({
    vault,
    tokenExchangeFetch,
    clock: { now: () => NOW },
  });
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error('Expected promise to reject');
  } catch (error) {
    return error;
  }
}

describe('ManagedCodexTokenProvider', () => {
  it('implements the exact credential provider contract without refreshing a fresh token', async () => {
    const vault = new MemoryVault(credentials({ expiresAt: NOW + 60_001 }));
    const tokenExchangeFetch = vi.fn();
    const provider: CodexTokenProvider = createProvider(vault, tokenExchangeFetch);

    await expect(provider.getValidCredentials()).resolves.toEqual({
      accessToken: 'current-access',
      accountId: 'current-account',
    });
    expect(tokenExchangeFetch).not.toHaveBeenCalled();
  });

  it('refreshes at the 60-second boundary and persists refresh-token rotation before returning', async () => {
    const vault = new MemoryVault(credentials({ expiresAt: NOW + 60_000 }));
    const refreshedAccess = unsignedJwt({
      chatgpt_account_id: 'refreshed-account',
      email: 'new@example.com',
    });
    const tokenExchangeFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        access_token: refreshedAccess,
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
        id_token: 'id-token-must-not-be-persisted',
      }),
    );
    const provider = createProvider(vault, tokenExchangeFetch);

    await expect(provider.getValidCredentials()).resolves.toEqual({
      accessToken: refreshedAccess,
      accountId: 'refreshed-account',
    });
    expect(vault.current).toEqual({
      version: 1,
      accessToken: refreshedAccess,
      refreshToken: 'rotated-refresh',
      expiresAt: NOW + 3_600_000,
      accountId: 'refreshed-account',
      email: 'new@example.com',
      updatedAt: NOW,
    });
    expect(JSON.stringify(vault.current)).not.toContain('id-token-must-not-be-persisted');
  });

  it('keeps the old refresh token and uses the new access JWT exp when optional fields are absent', async () => {
    const vault = new MemoryVault(credentials({ expiresAt: NOW }));
    const jwtExpiry = NOW + 1_800_000;
    const refreshedAccess = unsignedJwt({
      chatgpt_account_id: 'refreshed-account',
      exp: jwtExpiry / 1000,
    });
    const tokenExchangeFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ access_token: refreshedAccess }));
    const provider = createProvider(vault, tokenExchangeFetch);

    await provider.getValidCredentials();

    expect(vault.current).toMatchObject({
      accessToken: refreshedAccess,
      refreshToken: 'current-refresh',
      expiresAt: jwtExpiry,
    });
  });

  it('prefers identity claims from id_token without persisting the ID token', async () => {
    const vault = new MemoryVault(credentials({ expiresAt: NOW }));
    const refreshedAccess = unsignedJwt({
      chatgpt_account_id: 'access-account',
      email: 'access@example.com',
    });
    const idToken = unsignedJwt({
      chatgpt_account_id: 'id-account',
      email: 'id@example.com',
    });
    const tokenExchangeFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        access_token: refreshedAccess,
        id_token: idToken,
        expires_in: 300,
      }),
    );
    const provider = createProvider(vault, tokenExchangeFetch);

    await provider.getValidCredentials();

    expect(vault.current).toMatchObject({
      accountId: 'id-account',
      email: 'id@example.com',
    });
    expect(JSON.stringify(vault.current)).not.toContain(idToken);
  });

  it('rejects a new access token without its own expiry metadata', async () => {
    const oldJwtExpiry = NOW + 600_000;
    const oldAccess = unsignedJwt({
      chatgpt_account_id: 'current-account',
      exp: oldJwtExpiry / 1000,
    });
    const vault = new MemoryVault(credentials({ accessToken: oldAccess, expiresAt: NOW }));
    const refreshedAccess = unsignedJwt({ chatgpt_account_id: 'refreshed-account' });
    const tokenExchangeFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ access_token: refreshedAccess }));
    const provider = createProvider(vault, tokenExchangeFetch);

    await expect(provider.getValidCredentials()).rejects.toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.INVALID_RESPONSE,
      retryable: false,
    });
    expect(vault.current).toEqual(credentials({ accessToken: oldAccess, expiresAt: NOW }));
  });

  it('uses the fixed token endpoint and client ID when force-refreshing after a 401', async () => {
    const vault = new MemoryVault(credentials());
    const tokenExchangeFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        access_token: unsignedJwt({ chatgpt_account_id: 'current-account' }),
        expires_in: 900,
      }),
    );
    const provider = createProvider(vault, tokenExchangeFetch);

    await provider.getValidCredentials({ forceRefresh: true });

    expect(tokenExchangeFetch).toHaveBeenCalledTimes(1);
    const [endpoint, init] = tokenExchangeFetch.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe(CODEX_OAUTH_TOKEN_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' });
    const body = init.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('client_id')).toBe(CODEX_OAUTH_CLIENT_ID);
    expect(body.get('refresh_token')).toBe('current-refresh');
  });

  it('coalesces concurrent refreshes into one in-process request', async () => {
    const vault = new MemoryVault(credentials({ expiresAt: NOW }));
    const response = deferred<Response>();
    const tokenExchangeFetch = vi.fn(() => response.promise);
    const provider = createProvider(vault, tokenExchangeFetch);

    const first = provider.getValidCredentials();
    const second = provider.getValidCredentials({ forceRefresh: true });
    await vi.waitFor(() => expect(tokenExchangeFetch).toHaveBeenCalledTimes(1));
    response.resolve(
      jsonResponse({
        access_token: unsignedJwt({ chatgpt_account_id: 'refreshed-account' }),
        expires_in: 300,
      }),
    );

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(tokenExchangeFetch).toHaveBeenCalledTimes(1);
  });

  it('coalesces the complete load, decide, and refresh operation', async () => {
    const initial = credentials({ expiresAt: NOW });
    const pendingLoad = deferred<CodexOAuthCredentials | null>();
    const vault = new MemoryVault(initial);
    vault.load = vi.fn(() => pendingLoad.promise);
    const tokenExchangeFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        access_token: unsignedJwt({ chatgpt_account_id: 'refreshed-account' }),
        expires_in: 300,
      }),
    );
    const provider = createProvider(vault, tokenExchangeFetch);

    const first = provider.getValidCredentials();
    const second = provider.getValidCredentials({ forceRefresh: true });

    await vi.waitFor(() => expect(vault.load).toHaveBeenCalledTimes(1));
    pendingLoad.resolve(initial);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(tokenExchangeFetch).toHaveBeenCalledTimes(1);
  });

  it('clears credentials on invalid_grant and exposes only a safe error classification', async () => {
    const vault = new MemoryVault(credentials());
    const tokenExchangeFetch = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: 'invalid_grant',
          error_description: 'leaked-body current-refresh access-secret',
        },
        400,
      ),
    );
    const provider = createProvider(vault, tokenExchangeFetch);

    const error = await captureError(provider.getValidCredentials({ forceRefresh: true }));

    expect(error).toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.INVALID_GRANT,
      retryable: false,
    });
    expect(String(error)).not.toContain('leaked-body');
    expect(JSON.stringify(error)).not.toContain('current-refresh');
    expect(vault.current).toBeNull();
    expect(vault.clearCount).toBe(1);
  });

  it('keeps credentials on network failures and removes sensitive upstream details', async () => {
    const initial = credentials();
    const vault = new MemoryVault(initial);
    const tokenExchangeFetch = vi
      .fn()
      .mockRejectedValue(new Error('socket failed with current-refresh'));
    const provider = createProvider(vault, tokenExchangeFetch);

    const error = await captureError(provider.getValidCredentials({ forceRefresh: true }));

    expect(error).toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.NETWORK_ERROR,
      retryable: true,
    });
    expect(String(error)).not.toContain('current-refresh');
    expect(vault.current).toBe(initial);
    expect(vault.clearCount).toBe(0);
  });

  it('keeps credentials on 5xx and never includes the response body in the error', async () => {
    const initial = credentials();
    const vault = new MemoryVault(initial);
    const tokenExchangeFetch = vi
      .fn()
      .mockResolvedValue(new Response('upstream-body access-secret', { status: 503 }));
    const provider = createProvider(vault, tokenExchangeFetch);

    const error = await captureError(provider.getValidCredentials({ forceRefresh: true }));

    expect(error).toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.UPSTREAM_ERROR,
      retryable: true,
      upstreamStatus: 503,
    });
    expect(String(error)).not.toContain('upstream-body');
    expect(JSON.stringify(error)).not.toContain('access-secret');
    expect(vault.current).toBe(initial);
  });

  it('never treats invalid_grant inside a 5xx response as a reason to clear credentials', async () => {
    const initial = credentials();
    const vault = new MemoryVault(initial);
    const tokenExchangeFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 503));
    const provider = createProvider(vault, tokenExchangeFetch);

    await expect(provider.getValidCredentials({ forceRefresh: true })).rejects.toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.UPSTREAM_ERROR,
      retryable: true,
      upstreamStatus: 503,
    });
    expect(vault.current).toBe(initial);
    expect(vault.clearCount).toBe(0);
  });

  it('safely rejects a successful response without an access token', async () => {
    const initial = credentials();
    const vault = new MemoryVault(initial);
    const tokenExchangeFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ refresh_token: 'should-not-be-written', expires_in: 300 }));
    const provider = createProvider(vault, tokenExchangeFetch);

    await expect(provider.getValidCredentials({ forceRefresh: true })).rejects.toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.INVALID_RESPONSE,
      retryable: false,
    });
    expect(vault.current).toBe(initial);
  });

  it('keeps logout pending until an old save is quiescent and preserves later login state', async () => {
    const initial = credentials({ expiresAt: NOW });
    const saveStarted = deferred<void>();
    const releaseSave = deferred<void>();
    const vault = new MemoryVault(initial);
    vault.save = vi.fn(async (next: CodexOAuthCredentials) => {
      saveStarted.resolve();
      await releaseSave.promise;
      vault.saved.push(next);
      vault.current = next;
    });
    const tokenExchangeFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        access_token: unsignedJwt({ chatgpt_account_id: 'refreshed-account' }),
        expires_in: 300,
      }),
    );
    const provider = createProvider(vault, tokenExchangeFetch);

    const refresh = provider.getValidCredentials();
    await saveStarted.promise;
    const logoutSettled = vi.fn();
    const logout = provider.logout().then(logoutSettled);
    await vi.waitFor(() => expect(vault.clearCount).toBe(1));
    await Promise.resolve();
    expect(logoutSettled).not.toHaveBeenCalled();
    releaseSave.resolve();

    await expect(refresh).rejects.toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.SIGNED_OUT,
      retryable: false,
    });
    await logout;

    const reloggedCredentials = credentials({
      accessToken: 'relogged-access',
      refreshToken: 'relogged-refresh',
      accountId: 'relogged-account',
      updatedAt: NOW + 1,
    });
    await vault.save(reloggedCredentials);
    await Promise.resolve();
    expect(vault.current).toEqual(reloggedCredentials);
  });

  it('classifies missing credentials without attempting a token exchange', async () => {
    const vault = new MemoryVault(null);
    const tokenExchangeFetch = vi.fn();
    const provider = createProvider(vault, tokenExchangeFetch);

    await expect(provider.getValidCredentials()).rejects.toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.CREDENTIALS_MISSING,
      retryable: false,
    });
    expect(tokenExchangeFetch).not.toHaveBeenCalled();
  });
});
