import { describe, expect, it, vi } from 'vitest';

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
});
