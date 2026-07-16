import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  invalidateCodexCredentialLeases,
  ManagedCodexTokenProvider,
} from '@/lib/server/codex/token-provider';
import {
  withCodexCredentialVaultMutation,
  type CodexCredentialVault,
  type CodexOAuthCredentials,
} from '@/lib/server/codex/vault';

const getCodexOAuthAvailability = vi.fn();
const getCodexAuthRuntime = vi.fn();

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function deferredLifecycleRuntime() {
  let current: CodexOAuthCredentials | null = {
    version: 1,
    accessToken: 'account-a-access-secret',
    refreshToken: 'account-a-refresh-secret',
    expiresAt: 1_800_000_000_000,
    accountId: 'account-a-secret',
    updatedAt: 1_700_000_000_000,
  };
  let loads = 0;
  const currentnessStarted = deferred<void>();
  const releaseCurrentness = deferred<void>();
  const vault: CodexCredentialVault = {
    load: vi.fn(async () => {
      loads += 1;
      const snapshot = current;
      if (loads === 3) {
        currentnessStarted.resolve();
        await releaseCurrentness.promise;
      }
      return snapshot;
    }),
    save: vi.fn(async (next) => {
      current = next;
    }),
    clear: vi.fn(async () => {
      current = null;
    }),
  };
  const tokenProvider = new ManagedCodexTokenProvider({
    vault,
    tokenExchangeFetch: vi.fn(async () => new Response(null, { status: 200 })),
    clock: { now: () => 1_700_000_000_000 },
  });

  return {
    vault,
    tokenProvider,
    currentnessStarted,
    releaseCurrentness,
  };
}

vi.mock('@/lib/server/codex/availability', () => ({
  getCodexOAuthAvailability,
}));

vi.mock('@/lib/server/codex/runtime', () => ({
  getCodexAuthRuntime,
}));

describe('getCodexNativeServerProvider', () => {
  beforeEach(() => {
    getCodexOAuthAvailability.mockReset().mockResolvedValue({ available: true });
    getCodexAuthRuntime.mockReset();
  });

  it('publishes only model ids and the subset that advertises the priority service tier', async () => {
    const vault = {
      load: vi.fn(async () => ({
        accessToken: 'access-secret',
        refreshToken: 'refresh-secret',
        accountId: 'account-secret',
      })),
    };
    const modelDiscovery = {
      getModels: vi.fn(async () => [
        {
          id: 'gpt-fast',
          name: 'GPT Fast',
          contextWindow: 372_000,
          capabilities: {
            vision: true,
            thinking: {
              effortValues: ['low', 'medium'],
              defaultEffort: 'medium',
            },
            serviceTiers: ['priority'],
          },
          accountId: 'model-account-secret',
        },
        { id: 'gpt-standard', name: 'GPT Standard' },
      ]),
      invalidate: vi.fn(),
    };
    getCodexAuthRuntime.mockReturnValue({ vault, modelDiscovery });
    const { getCodexNativeServerProvider } = await import('@/lib/server/codex/server-provider');

    const result = await getCodexNativeServerProvider();

    expect(result).toEqual({
      models: ['gpt-fast', 'gpt-standard'],
      fastModels: ['gpt-fast'],
      modelCatalog: [
        {
          id: 'gpt-fast',
          name: 'GPT Fast',
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
          id: 'gpt-standard',
          name: 'GPT Standard',
          capabilities: { streaming: true, tools: true },
          source: 'probed',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/access-secret|refresh-secret|account-secret/);
  });

  it('publishes fixed image metadata without invoking text model discovery', async () => {
    const vault = {
      load: vi.fn(async () => ({
        accessToken: 'access-secret',
        refreshToken: 'refresh-secret',
        accountId: 'account-secret',
      })),
    };
    const modelDiscovery = {
      getModels: vi.fn(async () => {
        throw new Error('text discovery must not run');
      }),
      invalidate: vi.fn(),
    };
    const tokenProvider = {
      getValidCredentials: vi.fn(async () => ({
        accessToken: 'access-secret',
        accountId: 'account-secret',
      })),
    };
    getCodexAuthRuntime.mockReturnValue({ vault, tokenProvider, modelDiscovery });
    const { getCodexNativeImageProvider } = await import('@/lib/server/codex/server-provider');

    const result = await getCodexNativeImageProvider();

    expect(result).toEqual({ models: ['gpt-image-2'] });
    expect(tokenProvider.getValidCredentials).toHaveBeenCalledTimes(2);
    expect(modelDiscovery.getModels).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/access-secret|refresh-secret|account-secret/);
  });

  it('hides the image provider when OAuth is unavailable or disconnected', async () => {
    const vault = { load: vi.fn(async () => null) };
    const tokenProvider = {
      getValidCredentials: vi.fn(async () => {
        throw new Error('signed out');
      }),
    };
    getCodexAuthRuntime.mockReturnValue({
      vault,
      tokenProvider,
      modelDiscovery: { invalidate: vi.fn(), getModels: vi.fn() },
    });
    const { getCodexNativeImageProvider } = await import('@/lib/server/codex/server-provider');

    await expect(getCodexNativeImageProvider()).resolves.toBeNull();
    getCodexOAuthAvailability.mockResolvedValueOnce({ available: false });
    await expect(getCodexNativeImageProvider()).resolves.toBeNull();
    expect(tokenProvider.getValidCredentials).toHaveBeenCalledTimes(1);
  });

  it('does not publish when logout invalidates the lifecycle during final currentness validation', async () => {
    const lifecycle = deferredLifecycleRuntime();
    const modelDiscovery = {
      getModels: vi.fn(async () => {
        throw new Error('text discovery must not run');
      }),
      invalidate: vi.fn(),
    };
    getCodexAuthRuntime.mockReturnValue({
      vault: lifecycle.vault,
      tokenProvider: lifecycle.tokenProvider,
      modelDiscovery,
    });
    const { getCodexNativeImageProvider } = await import('@/lib/server/codex/server-provider');

    const publication = getCodexNativeImageProvider();
    const firstSettled = await Promise.race([
      lifecycle.currentnessStarted.promise.then(() => 'currentness-started' as const),
      publication.then(() => 'published' as const),
    ]);

    expect(firstSettled).toBe('currentness-started');
    const logout = lifecycle.tokenProvider.logout();
    lifecycle.releaseCurrentness.resolve();
    await expect(publication).resolves.toBeNull();
    await expect(logout).resolves.toBeUndefined();
    expect(modelDiscovery.getModels).not.toHaveBeenCalled();
  });

  it('does not publish when replacement login invalidates the lifecycle during final validation', async () => {
    const lifecycle = deferredLifecycleRuntime();
    const modelDiscovery = {
      getModels: vi.fn(async () => {
        throw new Error('text discovery must not run');
      }),
      invalidate: vi.fn(),
    };
    getCodexAuthRuntime.mockReturnValue({
      vault: lifecycle.vault,
      tokenProvider: lifecycle.tokenProvider,
      modelDiscovery,
    });
    const { getCodexNativeImageProvider } = await import('@/lib/server/codex/server-provider');

    const publication = getCodexNativeImageProvider();
    const firstSettled = await Promise.race([
      lifecycle.currentnessStarted.promise.then(() => 'currentness-started' as const),
      publication.then(() => 'published' as const),
    ]);

    expect(firstSettled).toBe('currentness-started');
    // This is the synchronous lifecycle hook used before replacement login is saved.
    invalidateCodexCredentialLeases(lifecycle.tokenProvider);
    const replacement = withCodexCredentialVaultMutation(lifecycle.vault, () =>
      lifecycle.vault.save({
        version: 1,
        accessToken: 'account-b-access-secret',
        refreshToken: 'account-b-refresh-secret',
        expiresAt: 1_800_000_000_000,
        accountId: 'account-b-secret',
        updatedAt: 1_700_000_000_001,
      }),
    );
    lifecycle.releaseCurrentness.resolve();
    await expect(publication).resolves.toBeNull();
    await expect(replacement).resolves.toBeUndefined();
    expect(modelDiscovery.getModels).not.toHaveBeenCalled();
  });
});
