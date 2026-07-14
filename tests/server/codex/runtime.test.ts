import { describe, expect, it, vi } from 'vitest';

import { CodexLoginManager } from '@/lib/server/codex/login-manager';
import { ManagedCodexTokenProvider } from '@/lib/server/codex/token-provider';
import { FileCodexCredentialVault } from '@/lib/server/codex/vault';

describe('Codex auth runtime', () => {
  it('is lazy, survives module reload, and creates no callback listener on import', async () => {
    const runtimeModule = await import('@/lib/server/codex/runtime');
    const first = runtimeModule.getCodexAuthRuntime();

    expect(first.vault).toBeInstanceOf(FileCodexCredentialVault);
    expect(first.tokenProvider).toBeInstanceOf(ManagedCodexTokenProvider);
    expect(first.loginManager).toBeInstanceOf(CodexLoginManager);
    expect(runtimeModule.getCodexAuthRuntime()).toBe(first);

    vi.resetModules();
    const reloadedModule = await import('@/lib/server/codex/runtime');
    expect(reloadedModule.getCodexAuthRuntime()).toBe(first);

    await expect(first.loginManager.poll()).resolves.toBeNull();
  });
});
