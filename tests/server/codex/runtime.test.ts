import { describe, expect, it, vi } from 'vitest';

describe('Codex auth runtime', () => {
  it('does not reuse the pre-hardening v2 runtime after a development reload', async () => {
    vi.resetModules();
    const legacyKey = Symbol.for('openmaic.codex.oauth.auth-runtime.v2');
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
});
