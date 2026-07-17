import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_ERROR_CODES,
  CODEX_OAUTH_TOKEN_ENDPOINT,
  ManagedCodexTokenProvider,
  acquireCodexCredentialLease,
  invalidateCodexCredentialLeases,
  isCodexCapabilityLifecycleCurrent,
  isCodexCredentialLeaseCurrent,
  isCodexCredentialLifecycleCurrent,
  refreshCodexCredentialLease,
  type CodexTokenProvider,
  type TokenExchangeFetch,
} from '@/lib/server/codex/token-provider';
import {
  FileCodexCredentialVault,
  withCodexCredentialVaultMutation,
  type CodexCredentialVault,
  type CodexOAuthCredentials,
} from '@/lib/server/codex/vault';

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

function declaredOversizeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'content-length': String(1024 * 1024 + 1),
    },
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
  tokenExchangeFetch: TokenExchangeFetch = vi.fn(),
  overrides: {
    oauthRequestTimeoutMs?: number;
    revokeTimeoutMs?: number;
    onCredentialsCleared?: () => void | Promise<void>;
  } = {},
): ManagedCodexTokenProvider {
  return new ManagedCodexTokenProvider({
    vault,
    tokenExchangeFetch,
    clock: { now: () => NOW },
    ...overrides,
  } as ConstructorParameters<typeof ManagedCodexTokenProvider>[0]);
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error('Expected promise to reject');
  } catch (error) {
    return error;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ManagedCodexTokenProvider', () => {
  it('normalizes a retained v4 HMR shared state without a lifecycle controller', async () => {
    const registrySymbol = Symbol.for('openmaic.codex.oauth.shared-credential-state.v4');
    const host = globalThis as unknown as Record<PropertyKey, unknown>;
    const existingRegistry = host[registrySymbol] as
      | {
          byCoordinationKey: Map<string, object>;
          byVault: WeakMap<object, object>;
        }
      | undefined;
    const registry =
      existingRegistry ??
      ({
        byCoordinationKey: new Map<string, object>(),
        byVault: new WeakMap<object, object>(),
      } satisfies {
        byCoordinationKey: Map<string, object>;
        byVault: WeakMap<object, object>;
      });
    if (!existingRegistry) {
      host[registrySymbol] = registry;
    }
    const coordinationKey = `retained-hmr-${crypto.randomUUID()}`;
    registry.byCoordinationKey.set(coordinationKey, {
      generation: 0,
      catalogGeneration: 0,
      operationInFlight: null,
      logoutInFlight: null,
    });
    const vault = Object.assign(new MemoryVault(credentials({ expiresAt: NOW + 60_001 })), {
      coordinationKey,
    });
    const provider = createProvider(vault);

    invalidateCodexCredentialLeases(provider);

    await expect(acquireCodexCredentialLease(provider)).resolves.toMatchObject({
      lifecycleGeneration: 1,
      lifecycleSignal: { aborted: false },
      credentials: { accountId: 'current-account', accessToken: 'current-access' },
    });
  });

  it('uses no lifecycle signal for an unmanaged provider', async () => {
    const provider: CodexTokenProvider = {
      getValidCredentials: vi.fn().mockResolvedValue({
        accessToken: 'unmanaged-access',
        accountId: 'unmanaged-account',
      }),
    };

    await expect(acquireCodexCredentialLease(provider)).resolves.toMatchObject({
      lifecycleGeneration: null,
      lifecycleSignal: null,
    });
  });

  it('aborts the old lease synchronously when logout starts', async () => {
    const vault = new MemoryVault(credentials({ expiresAt: NOW + 60_001 }));
    const provider = createProvider(
      vault,
      vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    );
    const lease = await acquireCodexCredentialLease(provider);

    const logout = provider.logout();

    expect(lease.lifecycleSignal?.aborted).toBe(true);
    await logout;
  });

  it('aborts old leases on interactive replacement but not normal refresh rotation', async () => {
    const vault = new MemoryVault(credentials({ expiresAt: NOW + 60_001 }));
    const provider = createProvider(
      vault,
      vi.fn().mockResolvedValue(
        jsonResponse({
          access_token: unsignedJwt({ chatgpt_account_id: 'current-account' }),
          expires_in: 300,
        }),
      ),
    );
    const stale = await acquireCodexCredentialLease(provider);

    invalidateCodexCredentialLeases(provider);
    expect(stale.lifecycleSignal?.aborted).toBe(true);

    const current = await acquireCodexCredentialLease(provider);
    const refreshed = await refreshCodexCredentialLease(current);
    expect(refreshed.lifecycleSignal).toBe(current.lifecycleSignal);
    expect(current.lifecycleSignal?.aborted).toBe(false);
  });

  it('separates exact send authority from response lifecycle and catalog currentness', async () => {
    const vault = new MemoryVault(credentials({ expiresAt: NOW + 60_001 }));
    const provider = createProvider(
      vault,
      vi.fn().mockResolvedValue(
        jsonResponse({
          access_token: unsignedJwt({ chatgpt_account_id: 'current-account' }),
          expires_in: 300,
        }),
      ),
    );
    const lease = await acquireCodexCredentialLease(provider);
    let catalogCurrent = true;
    const capabilityLease = {
      credentialLease: lease,
      isCatalogCurrent: vi.fn(() => catalogCurrent),
    };

    await provider.getValidCredentials({ forceRefresh: true });

    await expect(isCodexCredentialLeaseCurrent(lease)).resolves.toBe(false);
    await expect(isCodexCredentialLifecycleCurrent(lease)).resolves.toBe(true);
    await expect(isCodexCapabilityLifecycleCurrent(capabilityLease)).resolves.toBe(true);

    catalogCurrent = false;
    await expect(isCodexCapabilityLifecycleCurrent(capabilityLease)).resolves.toBe(false);

    catalogCurrent = true;
    await vault.save(
      credentials({
        accessToken: 'replacement-access',
        accountId: 'replacement-account',
      }),
    );
    await expect(isCodexCredentialLifecycleCurrent(lease)).resolves.toBe(false);
    await expect(isCodexCapabilityLifecycleCurrent(capabilityLease)).resolves.toBe(false);
  });

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

  it('does not overwrite credentials from a login that completes during refresh', async () => {
    const initial = credentials({ expiresAt: NOW });
    const vault = new MemoryVault(initial);
    const response = deferred<Response>();
    const refreshStarted = deferred<void>();
    const provider = createProvider(
      vault,
      vi.fn(async () => {
        refreshStarted.resolve();
        return response.promise;
      }),
    );

    const refreshing = provider.getValidCredentials({ forceRefresh: true });
    await refreshStarted.promise;
    const relogged = credentials({
      accessToken: 'relogged-during-refresh-access',
      refreshToken: 'relogged-during-refresh-token',
      accountId: 'relogged-during-refresh-account',
      updatedAt: NOW + 1,
    });
    await withCodexCredentialVaultMutation(vault, () => vault.save(relogged));
    response.resolve(
      jsonResponse({
        access_token: unsignedJwt({ chatgpt_account_id: 'stale-refresh-account' }),
        refresh_token: 'stale-rotated-refresh',
        expires_in: 300,
      }),
    );

    await expect(refreshing).resolves.toEqual({
      accessToken: relogged.accessToken,
      accountId: relogged.accountId,
    });
    expect(vault.current).toEqual(relogged);
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
    expect(init.redirect).toBe('error');
    expect(init.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' });
    const body = init.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('client_id')).toBe(CODEX_OAUTH_CLIENT_ID);
    expect(body.get('refresh_token')).toBe('current-refresh');
  });

  it('refuses a conditional refresh unless the exact request credentials remain current', async () => {
    const newerLogin = credentials({
      accessToken: 'account-a-new-access',
      refreshToken: 'account-a-new-refresh',
      accountId: 'account-a',
    });
    const vault = new MemoryVault(newerLogin);
    const tokenExchangeFetch = vi.fn();
    const provider = createProvider(vault, tokenExchangeFetch);

    await expect(
      provider.refreshIfCurrent({ accountId: 'account-a', accessToken: 'account-a-access' }),
    ).rejects.toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.SIGNED_OUT,
      retryable: false,
    });
    expect(tokenExchangeFetch).not.toHaveBeenCalled();
    expect(vault.current).toEqual(newerLogin);
  });

  it('does not persist a conditional refresh response for another account', async () => {
    const accountA = credentials({
      accessToken: 'account-a-access',
      refreshToken: 'account-a-refresh',
      accountId: 'account-a',
    });
    const vault = new MemoryVault(accountA);
    const tokenExchangeFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        access_token: unsignedJwt({ chatgpt_account_id: 'account-b' }),
        refresh_token: 'account-b-refresh',
        expires_in: 900,
      }),
    );
    const provider = createProvider(vault, tokenExchangeFetch);

    await expect(
      provider.refreshIfCurrent({
        accountId: accountA.accountId,
        accessToken: accountA.accessToken,
      }),
    ).rejects.toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.SIGNED_OUT,
      retryable: false,
    });
    expect(tokenExchangeFetch).toHaveBeenCalledTimes(1);
    expect(vault.saved).toEqual([]);
    expect(vault.current).toEqual(accountA);
  });

  it('does not force an existing operation until its account identity is known', async () => {
    const accountB = credentials({
      accessToken: 'account-b-access',
      refreshToken: 'account-b-refresh',
      accountId: 'account-b',
    });
    const pendingLoad = deferred<CodexOAuthCredentials | null>();
    const vault = new MemoryVault(accountB);
    vault.load = vi.fn(() => pendingLoad.promise);
    const tokenExchangeFetch = vi.fn();
    const provider = createProvider(vault, tokenExchangeFetch);

    const accountBOperation = provider.getValidCredentials();
    await vi.waitFor(() => expect(vault.load).toHaveBeenCalledTimes(1));
    const staleAccountAForce = provider.refreshIfCurrent({
      accountId: 'account-a',
      accessToken: 'account-a-access',
    });
    pendingLoad.resolve(accountB);

    await expect(accountBOperation).resolves.toEqual({
      accessToken: accountB.accessToken,
      accountId: accountB.accountId,
    });
    await expect(staleAccountAForce).rejects.toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.SIGNED_OUT,
    });
    expect(tokenExchangeFetch).not.toHaveBeenCalled();
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

  it('shares one refresh flight across provider instances using the same vault', async () => {
    const initial = credentials({ expiresAt: NOW });
    const vault = new MemoryVault(initial);
    vault.load = vi.fn(vault.load.bind(vault));
    const tokenExchangeFetch = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          access_token: unsignedJwt({ chatgpt_account_id: 'refreshed-account' }),
          expires_in: 300,
        }),
      ),
    );
    const providerA = createProvider(vault, tokenExchangeFetch);
    const providerB = createProvider(vault, tokenExchangeFetch);

    const [first, second] = await Promise.all([
      providerA.getValidCredentials(),
      providerB.getValidCredentials({ forceRefresh: true }),
    ]);

    expect(first).toEqual(second);
    // One initial read plus one compare-and-swap read before the rotated
    // credentials commit. Both callers still share the same refresh flight.
    expect(vault.load).toHaveBeenCalledTimes(2);
    expect(tokenExchangeFetch).toHaveBeenCalledTimes(1);
  });

  it('shares one refresh flight across separate file vaults using the same credential path', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'openmaic-codex-provider-'));

    try {
      const vaultA = new FileCodexCredentialVault({ baseDir });
      const vaultB = new FileCodexCredentialVault({ baseDir });
      await vaultA.save(credentials({ expiresAt: NOW }));
      const tokenExchangeFetch = vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            access_token: unsignedJwt({ chatgpt_account_id: 'refreshed-account' }),
            expires_in: 300,
          }),
        ),
      );

      const [first, second] = await Promise.all([
        createProvider(vaultA, tokenExchangeFetch).getValidCredentials({ forceRefresh: true }),
        createProvider(vaultB, tokenExchangeFetch).getValidCredentials({ forceRefresh: true }),
      ]);

      expect(first).toEqual(second);
      expect(tokenExchangeFetch).toHaveBeenCalledTimes(1);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it('does not share coordination between different vault instances', async () => {
    const vaultA = new MemoryVault(credentials({ expiresAt: NOW }));
    const vaultB = new MemoryVault(credentials({ expiresAt: NOW }));
    const fetchA = vi.fn().mockResolvedValue(
      jsonResponse({
        access_token: unsignedJwt({ chatgpt_account_id: 'account-a' }),
        expires_in: 300,
      }),
    );
    const fetchB = vi.fn().mockResolvedValue(
      jsonResponse({
        access_token: unsignedJwt({ chatgpt_account_id: 'account-b' }),
        expires_in: 300,
      }),
    );

    await Promise.all([
      createProvider(vaultA, fetchA).getValidCredentials(),
      createProvider(vaultB, fetchB).getValidCredentials(),
    ]);

    expect(fetchA).toHaveBeenCalledTimes(1);
    expect(fetchB).toHaveBeenCalledTimes(1);
  });

  it('preserves same-path file-vault coordination across a development module reload', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'openmaic-codex-provider-'));
    const releaseResponse = deferred<void>();
    const tokenExchangeFetch = vi.fn(async () => {
      await releaseResponse.promise;
      return jsonResponse({
        access_token: unsignedJwt({ chatgpt_account_id: 'refreshed-account' }),
        expires_in: 300,
      });
    });
    const pending: Promise<unknown>[] = [];

    try {
      const vaultA = new FileCodexCredentialVault({ baseDir });
      await vaultA.save(credentials({ expiresAt: NOW }));
      const providerA = createProvider(vaultA, tokenExchangeFetch);

      const first = providerA.getValidCredentials();
      pending.push(first);
      await vi.waitFor(() => expect(tokenExchangeFetch).toHaveBeenCalledTimes(1));
      vi.resetModules();
      const [{ ManagedCodexTokenProvider: ReloadedTokenProvider }, vaultModule] = await Promise.all(
        [import('@/lib/server/codex/token-provider'), import('@/lib/server/codex/vault')],
      );
      const vaultB = new vaultModule.FileCodexCredentialVault({ baseDir });
      const providerB = new ReloadedTokenProvider({
        vault: vaultB,
        tokenExchangeFetch,
        clock: { now: () => NOW },
      });
      const second = providerB.getValidCredentials({ forceRefresh: true });
      pending.push(second);
      await Promise.resolve();
      await Promise.resolve();

      releaseResponse.resolve();
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(tokenExchangeFetch).toHaveBeenCalledTimes(1);
    } finally {
      releaseResponse.resolve();
      await Promise.allSettled(pending);
      await rm(baseDir, { recursive: true, force: true });
    }
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
    const lease = await acquireCodexCredentialLease(provider);

    const error = await captureError(provider.getValidCredentials({ forceRefresh: true }));

    expect(error).toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.INVALID_GRANT,
      retryable: false,
    });
    expect(String(error)).not.toContain('leaked-body');
    expect(JSON.stringify(error)).not.toContain('current-refresh');
    expect(vault.current).toBeNull();
    expect(vault.clearCount).toBe(1);
    expect(lease.lifecycleSignal?.aborted).toBe(true);
  });

  it('aborts the terminal lifecycle before clear starts or clear-queued work runs', async () => {
    const vault = new MemoryVault(credentials());
    const onCredentialsCleared = vi.fn();
    const provider = createProvider(
      vault,
      vi.fn().mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400)),
      { onCredentialsCleared },
    );
    const lease = await acquireCodexCredentialLease(provider);
    const abortedInClearMicrotask = deferred<boolean>();
    let abortedAtClearEntry: boolean | undefined;
    vault.clear = vi.fn(async () => {
      vault.clearCount += 1;
      abortedAtClearEntry = lease.lifecycleSignal?.aborted;
      queueMicrotask(() => {
        abortedInClearMicrotask.resolve(lease.lifecycleSignal?.aborted ?? false);
      });
      await Promise.resolve();
      vault.current = null;
    });

    await expect(provider.getValidCredentials({ forceRefresh: true })).rejects.toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.INVALID_GRANT,
      retryable: false,
    });

    expect(abortedAtClearEntry).toBe(true);
    await expect(abortedInClearMicrotask.promise).resolves.toBe(true);
    expect(vault.current).toBeNull();
    expect(onCredentialsCleared).toHaveBeenCalledTimes(1);
  });

  it('keeps credentials but starts a usable new lifecycle when terminal clear fails', async () => {
    const initial = credentials();
    const vault = new MemoryVault(initial);
    const onCredentialsCleared = vi.fn();
    vault.clear = vi.fn(async () => {
      vault.clearCount += 1;
      throw new Error('private clear failure');
    });
    const provider = createProvider(
      vault,
      vi.fn().mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400)),
      { onCredentialsCleared },
    );
    const staleLease = await acquireCodexCredentialLease(provider);

    await expect(provider.getValidCredentials({ forceRefresh: true })).rejects.toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.STORAGE_ERROR,
      retryable: false,
    });

    expect(vault.current).toBe(initial);
    expect(vault.clearCount).toBe(1);
    expect(staleLease.lifecycleSignal?.aborted).toBe(true);
    expect(onCredentialsCleared).not.toHaveBeenCalled();

    const currentLease = await acquireCodexCredentialLease(provider);
    expect(currentLease.lifecycleSignal).not.toBe(staleLease.lifecycleSignal);
    expect(currentLease.lifecycleSignal?.aborted).toBe(false);
    expect(currentLease.credentials).toEqual({
      accessToken: initial.accessToken,
      accountId: initial.accountId,
    });
    await expect(isCodexCredentialLeaseCurrent(currentLease)).resolves.toBe(true);
  });

  it.each([
    ['nested expired', { error: { code: ' Refresh_Token_Expired ' } }],
    ['string reused', { error: ' REFRESH_TOKEN_REUSED ' }],
    ['top-level invalidated', { code: ' refresh_token_invalidated ' }],
    ['nested invalid grant', { error: { code: ' INVALID_GRANT ' } }],
  ])('treats %s refresh failure codes as terminal', async (_name, body) => {
    const vault = new MemoryVault(credentials());
    const onCredentialsCleared = vi.fn();
    const provider = createProvider(vault, vi.fn().mockResolvedValue(jsonResponse(body, 400)), {
      onCredentialsCleared,
    });

    await expect(provider.getValidCredentials({ forceRefresh: true })).rejects.toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.INVALID_GRANT,
      retryable: false,
    });
    expect(vault.current).toBeNull();
    expect(vault.clearCount).toBe(1);
    expect(onCredentialsCleared).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['empty', () => new Response(null, { status: 401 })],
    ['malformed', () => new Response('not-json private-refresh-body', { status: 401 })],
    ['unknown code', () => jsonResponse({ error: { code: 42 } }, 401)],
  ])('treats a %s HTTP 401 as terminal', async (_name, responseFactory) => {
    const vault = new MemoryVault(credentials());
    const provider = createProvider(vault, vi.fn().mockImplementation(responseFactory));

    const error = await captureError(provider.getValidCredentials({ forceRefresh: true }));

    expect(error).toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.INVALID_GRANT,
      retryable: false,
    });
    expect(String(error)).not.toContain('private-refresh-body');
    expect(vault.current).toBeNull();
  });

  it('treats HTTP 401 as terminal without waiting for a hung response body', async () => {
    const vault = new MemoryVault(credentials());
    const response = new Response(new ReadableStream<Uint8Array>(), { status: 401 });
    const getReader = vi.spyOn(response.body!, 'getReader');
    const provider = createProvider(vault, vi.fn().mockResolvedValue(response), {
      oauthRequestTimeoutMs: 25,
    });
    const refresh = provider.getValidCredentials({ forceRefresh: true });

    await expect(refresh).rejects.toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.INVALID_GRANT,
      retryable: false,
    });
    expect(getReader).not.toHaveBeenCalled();
    expect(vault.current).toBeNull();
  });

  it('does not clear a newer login when an older refresh receives invalid_grant', async () => {
    const initial = credentials();
    const vault = new MemoryVault(initial);
    const response = deferred<Response>();
    const refreshStarted = deferred<void>();
    const provider = createProvider(
      vault,
      vi.fn(async () => {
        refreshStarted.resolve();
        return response.promise;
      }),
    );

    const refreshing = provider.getValidCredentials({ forceRefresh: true });
    await refreshStarted.promise;
    const relogged = credentials({
      accessToken: 'new-login-access',
      refreshToken: 'new-login-refresh',
      accountId: 'new-login-account',
      updatedAt: NOW + 1,
    });
    await withCodexCredentialVaultMutation(vault, () => vault.save(relogged));
    response.resolve(jsonResponse({ error: 'invalid_grant' }, 400));

    await expect(refreshing).resolves.toEqual({
      accessToken: relogged.accessToken,
      accountId: relogged.accountId,
    });
    expect(vault.current).toEqual(relogged);
    expect(vault.clearCount).toBe(0);
  });

  it.each([
    ['nested terminal code', () => jsonResponse({ error: { code: 'refresh_token_expired' } }, 400)],
    ['malformed 401', () => new Response('invalid-json', { status: 401 })],
    ['empty 401', () => new Response(null, { status: 401 })],
  ])('preserves newer credentials after an older %s response', async (_name, responseFactory) => {
    const initial = credentials();
    const vault = new MemoryVault(initial);
    const response = deferred<Response>();
    const refreshStarted = deferred<void>();
    const onCredentialsCleared = vi.fn();
    const provider = createProvider(
      vault,
      vi.fn(async () => {
        refreshStarted.resolve();
        return response.promise;
      }),
      { onCredentialsCleared },
    );

    const refreshing = provider.getValidCredentials({ forceRefresh: true });
    await refreshStarted.promise;
    const relogged = credentials({
      accessToken: 'newer-terminal-access',
      refreshToken: 'newer-terminal-refresh',
      accountId: 'newer-terminal-account',
      updatedAt: NOW + 2,
    });
    await withCodexCredentialVaultMutation(vault, () => vault.save(relogged));
    response.resolve(responseFactory());

    await expect(refreshing).resolves.toEqual({
      accessToken: relogged.accessToken,
      accountId: relogged.accountId,
    });
    expect(vault.current).toEqual(relogged);
    expect(vault.clearCount).toBe(0);
    expect(onCredentialsCleared).not.toHaveBeenCalled();
  });

  it('reports signed out when logout invalidates an in-flight invalid_grant transaction', async () => {
    const initial = credentials();
    const vault = new MemoryVault(initial);
    const invalidGrantLoadStarted = deferred<void>();
    const releaseInvalidGrantLoad = deferred<void>();
    let loadCount = 0;
    vault.load = vi.fn(async () => {
      loadCount += 1;
      if (loadCount === 2) {
        invalidGrantLoadStarted.resolve();
        await releaseInvalidGrantLoad.promise;
      }
      return vault.current;
    });
    const provider = createProvider(
      vault,
      vi.fn().mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400)),
    );

    const refreshing = provider.getValidCredentials({ forceRefresh: true });
    await invalidGrantLoadStarted.promise;
    const logout = provider.logout();
    releaseInvalidGrantLoad.resolve();

    await expect(refreshing).rejects.toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.SIGNED_OUT,
      retryable: false,
    });
    await logout;
    expect(vault.current).toBeNull();
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
    const response = new Response('upstream-body access-secret', { status: 503 });
    const getReader = vi.spyOn(response.body!, 'getReader');
    const tokenExchangeFetch = vi.fn().mockResolvedValue(response);
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
    expect(getReader).not.toHaveBeenCalled();
  });

  it('never treats a nested terminal code inside a 5xx response as a reason to clear credentials', async () => {
    const initial = credentials();
    const vault = new MemoryVault(initial);
    const tokenExchangeFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { code: 'refresh_token_reused' } }, 503));
    const provider = createProvider(vault, tokenExchangeFetch);

    await expect(provider.getValidCredentials({ forceRefresh: true })).rejects.toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.UPSTREAM_ERROR,
      retryable: true,
      upstreamStatus: 503,
    });
    expect(vault.current).toBe(initial);
    expect(vault.clearCount).toBe(0);
  });

  it('keeps unknown non-401 4xx failures as rejected refreshes', async () => {
    const initial = credentials();
    const vault = new MemoryVault(initial);
    const provider = createProvider(
      vault,
      vi.fn().mockResolvedValue(jsonResponse({ error: { code: 'unknown_refresh_error' } }, 400)),
    );

    await expect(provider.getValidCredentials({ forceRefresh: true })).rejects.toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.REFRESH_REJECTED,
      retryable: false,
      upstreamStatus: 400,
    });
    expect(vault.current).toEqual(initial);
    expect(vault.clearCount).toBe(0);
  });

  it('keeps an oversized non-401 4xx as a rejected refresh without clearing credentials', async () => {
    const initial = credentials();
    const vault = new MemoryVault(initial);
    const provider = createProvider(
      vault,
      vi
        .fn()
        .mockResolvedValue(declaredOversizeJsonResponse({ error: { code: 'invalid_grant' } }, 400)),
    );

    await expect(provider.getValidCredentials({ forceRefresh: true })).rejects.toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.REFRESH_REJECTED,
      retryable: false,
      upstreamStatus: 400,
    });
    expect(vault.current).toEqual(initial);
    expect(vault.clearCount).toBe(0);
  });

  it('rejects an oversized successful refresh without clearing or replacing credentials', async () => {
    const initial = credentials();
    const vault = new MemoryVault(initial);
    const provider = createProvider(
      vault,
      vi.fn().mockResolvedValue(
        declaredOversizeJsonResponse({
          access_token: unsignedJwt({ chatgpt_account_id: 'oversized-account' }),
          refresh_token: 'must-not-save',
          expires_in: 300,
        }),
      ),
    );

    await expect(provider.getValidCredentials({ forceRefresh: true })).rejects.toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.INVALID_RESPONSE,
      retryable: false,
    });
    expect(vault.current).toEqual(initial);
    expect(vault.saved).toEqual([]);
    expect(vault.clearCount).toBe(0);
  });

  it('times out a stalled successful refresh body without clearing credentials', async () => {
    vi.useFakeTimers();
    const initial = credentials();
    const vault = new MemoryVault(initial);
    const cancelled = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel: cancelled,
      }),
    );
    const provider = createProvider(vault, vi.fn().mockResolvedValue(response), {
      oauthRequestTimeoutMs: 25,
    });
    const refresh = provider.getValidCredentials({ forceRefresh: true });
    const rejection = expect(refresh).rejects.toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.NETWORK_ERROR,
      retryable: true,
    });

    await vi.advanceTimersByTimeAsync(25);
    await rejection;

    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(vault.current).toEqual(initial);
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

  it('revokes the captured refresh token with the exact logout request', async () => {
    const initial = credentials({ refreshToken: 'captured-refresh-token' });
    const vault = new MemoryVault(initial);
    const revokeFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const onCredentialsCleared = vi.fn();
    const provider = createProvider(vault, revokeFetch, { onCredentialsCleared });

    await provider.logout();

    expect(vault.current).toBeNull();
    expect(vault.clearCount).toBe(1);
    expect(onCredentialsCleared).toHaveBeenCalledTimes(1);
    expect(revokeFetch).toHaveBeenCalledTimes(1);
    const [endpoint, init] = revokeFetch.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe('https://auth.openai.com/oauth/revoke');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({
      token: 'captured-refresh-token',
      token_type_hint: 'refresh_token',
      client_id: CODEX_OAUTH_CLIENT_ID,
    });
  });

  it('never follows refresh or revoke redirects with OAuth secrets', async () => {
    const refreshTarget = vi.fn(() =>
      jsonResponse({
        access_token: unsignedJwt({ chatgpt_account_id: 'current-account' }),
        expires_in: 300,
      }),
    );
    const refreshVault = new MemoryVault(credentials({ expiresAt: NOW }));
    const refreshProvider = createProvider(
      refreshVault,
      vi.fn(async (_input: string, init: RequestInit) => {
        if (init.redirect !== 'error') return refreshTarget();
        throw new TypeError('redirect rejected');
      }),
    );

    await expect(refreshProvider.getValidCredentials({ forceRefresh: true })).rejects.toMatchObject(
      {
        code: CODEX_OAUTH_ERROR_CODES.NETWORK_ERROR,
        retryable: true,
      },
    );
    expect(refreshTarget).not.toHaveBeenCalled();
    expect(refreshVault.current).not.toBeNull();

    const revokeTarget = vi.fn(() => new Response(null, { status: 200 }));
    const revokeVault = new MemoryVault(credentials());
    const revokeProvider = createProvider(
      revokeVault,
      vi.fn(async (_input: string, init: RequestInit) => {
        if (init.redirect !== 'error') return revokeTarget();
        throw new TypeError('redirect rejected');
      }),
    );

    await expect(revokeProvider.logout()).resolves.toBeUndefined();
    expect(revokeTarget).not.toHaveBeenCalled();
    expect(revokeVault.current).toBeNull();
  });

  it.each([
    ['network rejection', () => Promise.reject(new Error('private revoke network body'))],
    [
      'non-2xx response',
      () => Promise.resolve(new Response('private revoke body', { status: 503 })),
    ],
  ])('keeps local logout successful after a revoke %s', async (_name, revoke) => {
    const vault = new MemoryVault(credentials());
    const revokeFetch = vi.fn(revoke);
    const provider = createProvider(vault, revokeFetch);

    await expect(provider.logout()).resolves.toBeUndefined();

    expect(revokeFetch).toHaveBeenCalledTimes(1);
    expect(vault.current).toBeNull();
    expect(vault.clearCount).toBe(1);
  });

  it('bounds a hung revoke and still resolves with credentials cleared', async () => {
    vi.useFakeTimers();
    const vault = new MemoryVault(credentials());
    let revokeSignal: AbortSignal | undefined;
    const provider = createProvider(
      vault,
      vi.fn(async (_input, init) => {
        revokeSignal = init.signal as AbortSignal;
        return new Promise<Response>(() => undefined);
      }),
      { revokeTimeoutMs: 25 },
    );
    let settled = false;
    const logout = provider.logout().then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(24);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await logout;

    expect(settled).toBe(true);
    expect(revokeSignal?.aborted).toBe(true);
    expect(vault.current).toBeNull();
    expect(vault.clearCount).toBe(1);
  });

  it('aborts a hung shared refresh before awaiting it during logout', async () => {
    const vault = new MemoryVault(credentials({ expiresAt: NOW }));
    const refreshResponse = deferred<Response>();
    const refreshStarted = deferred<void>();
    let refreshSignal: AbortSignal | undefined;
    const tokenExchangeFetch = vi.fn(async (input: string, init: RequestInit) => {
      if (input === CODEX_OAUTH_TOKEN_ENDPOINT) {
        refreshSignal = init.signal as AbortSignal;
        refreshStarted.resolve();
        return refreshResponse.promise;
      }
      return new Response(null, { status: 200 });
    });
    const provider = createProvider(vault, tokenExchangeFetch);

    const refresh = provider.getValidCredentials({ forceRefresh: true });
    const refreshOutcome = refresh.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await refreshStarted.promise;
    const logout = provider.logout();
    const settledPromptly = await Promise.race([
      logout.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    const abortedBeforeLateResponse = refreshSignal?.aborted;
    refreshResponse.resolve(
      jsonResponse({
        access_token: unsignedJwt({ chatgpt_account_id: 'late-refresh-account' }),
        refresh_token: 'late-refresh-token',
        expires_in: 300,
      }),
    );
    await logout;

    expect(settledPromptly).toBe(true);
    expect(abortedBeforeLateResponse).toBe(true);
    expect(await refreshOutcome).toMatchObject({
      ok: false,
      error: { code: CODEX_OAUTH_ERROR_CODES.SIGNED_OUT, retryable: false },
    });
    expect(vault.current).toBeNull();
    expect(tokenExchangeFetch).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent shared logout calls into one clear and one revoke', async () => {
    const vault = new MemoryVault(credentials());
    const revokeFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const providerA = createProvider(vault, revokeFetch);
    const providerB = createProvider(vault, revokeFetch);

    await Promise.all([providerA.logout(), providerB.logout()]);

    expect(vault.clearCount).toBe(1);
    expect(revokeFetch).toHaveBeenCalledTimes(1);
  });

  it('does not erase a new login committed after the logout clear', async () => {
    const vault = new MemoryVault(credentials());
    const revokeResponse = deferred<Response>();
    const revokeStarted = deferred<void>();
    const revokeFetch = vi.fn(async () => {
      revokeStarted.resolve();
      return revokeResponse.promise;
    });
    const provider = createProvider(vault, revokeFetch);

    const logout = provider.logout();
    const revokeStartedPromptly = await Promise.race([
      revokeStarted.promise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    const relogged = credentials({
      accessToken: 'post-clear-login-access',
      refreshToken: 'post-clear-login-refresh',
      accountId: 'post-clear-login-account',
      updatedAt: NOW + 3,
    });
    await withCodexCredentialVaultMutation(vault, () => vault.save(relogged));
    revokeResponse.resolve(new Response(null, { status: 200 }));
    await logout;

    expect(revokeStartedPromptly).toBe(true);
    expect(vault.current).toEqual(relogged);
    expect(vault.clearCount).toBe(1);
    expect(revokeFetch).toHaveBeenCalledTimes(1);
  });

  it('fails logout when the local vault cannot be cleared', async () => {
    const vault = new MemoryVault(credentials());
    vault.clear = vi.fn().mockRejectedValue(new Error('private clear failure'));
    const revokeFetch = vi.fn();
    const provider = createProvider(vault, revokeFetch);

    await expect(provider.logout()).rejects.toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.STORAGE_ERROR,
      retryable: false,
    });
    expect(revokeFetch).not.toHaveBeenCalled();
    expect(vault.current).not.toBeNull();
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
    await Promise.resolve();
    // The shared vault transaction keeps clear behind the in-flight save;
    // logout still invalidates the generation synchronously and stays pending.
    expect(vault.clearCount).toBe(0);
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

  it('shares logout generation with another provider that is finishing a late save', async () => {
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
    const providerA = createProvider(vault, tokenExchangeFetch);
    const providerB = createProvider(vault, tokenExchangeFetch);

    const refresh = providerB.getValidCredentials();
    await saveStarted.promise;
    const logoutSettled = vi.fn();
    const logout = providerA.logout().then(logoutSettled);
    await Promise.resolve();
    expect(vault.clearCount).toBe(0);
    expect(logoutSettled).not.toHaveBeenCalled();
    releaseSave.resolve();

    await expect(refresh).rejects.toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.SIGNED_OUT,
      retryable: false,
    });
    await logout;
    expect(vault.current).toBeNull();
  });

  it('waits for a late save from a separate file vault using the same credential path', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'openmaic-codex-provider-'));
    const saveStarted = deferred<void>();
    const releaseSave = deferred<void>();
    const pending: Promise<unknown>[] = [];

    try {
      const vaultA = new FileCodexCredentialVault({ baseDir });
      const vaultB = new FileCodexCredentialVault({ baseDir });
      await vaultA.save(credentials({ expiresAt: NOW }));
      const realSave = vaultB.save.bind(vaultB);
      vi.spyOn(vaultB, 'save').mockImplementation(async (next) => {
        saveStarted.resolve();
        await releaseSave.promise;
        await realSave(next);
      });
      const tokenExchangeFetch = vi.fn().mockResolvedValue(
        jsonResponse({
          access_token: unsignedJwt({ chatgpt_account_id: 'refreshed-account' }),
          expires_in: 300,
        }),
      );
      const providerA = createProvider(vaultA, tokenExchangeFetch);
      const providerB = createProvider(vaultB, tokenExchangeFetch);

      const refresh = providerB.getValidCredentials();
      pending.push(refresh);
      await saveStarted.promise;
      const logout = providerA.logout();
      pending.push(logout);

      await expect(
        Promise.race([
          logout.then(() => 'settled'),
          new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
        ]),
      ).resolves.toBe('pending');
      releaseSave.resolve();

      await expect(refresh).rejects.toMatchObject({
        code: CODEX_OAUTH_ERROR_CODES.SIGNED_OUT,
        retryable: false,
      });
      await logout;
      await expect(vaultA.load()).resolves.toBeNull();
    } finally {
      releaseSave.resolve();
      await Promise.allSettled(pending);
      await rm(baseDir, { recursive: true, force: true });
    }
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
