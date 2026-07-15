import { beforeEach, describe, expect, it, vi } from 'vitest';

const getCodexOAuthAvailability = vi.fn();
const getCodexAuthRuntime = vi.fn();
const withCodexCredentialVaultMutation = vi.fn(
  async (_vault: unknown, operation: () => Promise<unknown>) => operation(),
);

vi.mock('@/lib/server/codex/availability', () => ({
  getCodexOAuthAvailability,
}));

vi.mock('@/lib/server/codex/runtime', () => ({
  getCodexAuthRuntime,
}));

vi.mock('@/lib/server/codex/vault', () => ({
  withCodexCredentialVaultMutation,
}));

describe('getCodexNativeServerProvider', () => {
  beforeEach(() => {
    getCodexOAuthAvailability.mockReset().mockResolvedValue({ available: true });
    getCodexAuthRuntime.mockReset();
    withCodexCredentialVaultMutation.mockClear();
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
          capabilities: { serviceTiers: ['priority'] },
          accountId: 'model-account-secret',
        },
        { id: 'gpt-standard' },
      ]),
      invalidate: vi.fn(),
    };
    getCodexAuthRuntime.mockReturnValue({ vault, modelDiscovery });
    const { getCodexNativeServerProvider } = await import('@/lib/server/codex/server-provider');

    const result = await getCodexNativeServerProvider();

    expect(result).toEqual({
      models: ['gpt-fast', 'gpt-standard'],
      fastModels: ['gpt-fast'],
    });
    expect(JSON.stringify(result)).not.toMatch(/access-secret|refresh-secret|account-secret/);
  });
});
