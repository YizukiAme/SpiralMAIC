import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo } from '@/lib/types/provider';
import type { ModelConfigLayer } from '@/lib/server/model-config/resolve-slot';
import { deriveCodexUpstreamSessionId } from '@/lib/server/codex/logical-session';

const mocks = vi.hoisted(() => ({
  getModel: vi.fn(),
  transport: vi.fn(),
  createTransport: vi.fn(),
  availability: vi.fn(),
  capability: vi.fn(),
  tokenProvider: {},
}));
vi.mock('@/lib/ai/providers', async (original) => ({
  ...(await original<typeof import('@/lib/ai/providers')>()),
  getModel: mocks.getModel,
}));
vi.mock('@/lib/server/codex/availability', () => ({
  getCodexOAuthAvailability: mocks.availability,
}));
vi.mock('@/lib/server/codex/runtime', () => ({
  getCodexAuthRuntime: () => ({
    tokenProvider: mocks.tokenProvider,
    modelDiscovery: { getModelCapability: mocks.capability },
  }),
}));
vi.mock('@/lib/server/codex/transport', () => ({
  createCodexResponsesTransport: mocks.createTransport,
}));

const liveModel = (): ModelInfo => ({
  id: 'gpt-live',
  name: 'Live account model',
  contextWindow: 200000,
  capabilities: {
    vision: true,
    tools: true,
    streaming: true,
    serviceTiers: ['priority'],
    thinking: {
      control: 'effort',
      requestAdapter: 'openai',
      effortValues: ['low', 'high'],
      defaultEffort: 'high',
    },
  },
});

describe('Codex in server model slots', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.availability.mockResolvedValue({ available: true, reason: 'available', methods: [] });
    mocks.capability.mockResolvedValue({
      modelInfo: liveModel(),
      capabilityLease: { account: 'test' },
    });
    mocks.createTransport.mockReturnValue(mocks.transport);
    mocks.getModel.mockImplementation((args) => ({
      model: { provider: 'openai-codex', modelId: args.modelId, specificationVersion: 'v4' },
      modelInfo: undefined,
    }));
    const runtime = await import('@/lib/server/model-config/runtime');
    runtime.setDeploymentConfigForTests({ layer: null, legacy: false, notices: [] });
    runtime.setWorkspaceLayerLoaderForTests(async () => ({
      source: 'workspace',
      config: {
        providers: { subscription: { preset: 'openai-codex' } },
        slots: { llm: 'subscription:gpt-live' },
      },
    }));
  });
  afterEach(async () => {
    const runtime = await import('@/lib/server/model-config/runtime');
    runtime.setDeploymentConfigForTests();
    runtime.setWorkspaceLayerLoaderForTests();
  });

  it('uses the saved OAuth slot and live capability without any browser credentials', async () => {
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const resolved = await resolveModel({
      stage: 'revisit-blueprint',
      workspaceId: 'owner',
      modelString: 'openai:unrelated',
      apiKey: 'browser-key',
      baseUrl: 'https://browser.example',
      providerType: 'anthropic',
      serviceTier: 'priority',
    });
    expect(resolved).toMatchObject({
      providerId: 'openai-codex',
      modelId: 'gpt-live',
      apiKey: '',
      serverManaged: true,
      serviceTier: 'priority',
      modelInfo: { contextWindow: 200000, capabilities: { vision: true } },
    });
    expect(mocks.getModel).toHaveBeenCalledWith({
      providerId: 'openai-codex',
      modelId: 'gpt-live',
      apiKey: '',
      customFetch: mocks.transport,
      serviceTier: 'priority',
    });
  });

  it('passes the logical session into the OAuth transport for a configured stage', async () => {
    const logicalSession = { kind: 'chat', id: 'stable-session' } as const;
    const { resolveModel } = await import('@/lib/server/resolve-model');
    await resolveModel({ stage: 'chat-adapter', workspaceId: 'owner', logicalSession });
    expect(mocks.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: deriveCodexUpstreamSessionId(logicalSession),
        tokenProvider: mocks.tokenProvider,
      }),
    );
  });

  it('drops Fast tier when the connected model does not support it', async () => {
    mocks.capability.mockResolvedValue({
      modelInfo: {
        ...liveModel(),
        capabilities: { ...liveModel().capabilities, serviceTiers: [] },
      },
      capabilityLease: {},
    });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const resolved = await resolveModel({
      stage: 'revisit-judge',
      workspaceId: 'owner',
      serviceTier: 'priority',
    });
    expect(resolved.serviceTier).toBeUndefined();
    expect(mocks.getModel.mock.calls[0][0]).not.toHaveProperty('serviceTier');
  });

  it('fails closed when the configured model disappeared from the connected account', async () => {
    mocks.capability.mockResolvedValue(null);
    const { resolveModel } = await import('@/lib/server/resolve-model');
    await expect(
      resolveModel({ stage: 'revisit-materials', workspaceId: 'owner' }),
    ).rejects.toThrow('Codex model is unavailable for the connected account');
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });

  it('a deployment lock keeps its provider and model when a workspace selects Codex', async () => {
    const deployment: ModelConfigLayer = {
      source: 'deployment',
      config: {
        allowUserKeys: false,
        lock: ['llm'],
        providers: { operator: { preset: 'openai', apiKey: 'operator-key' } },
        slots: { llm: 'operator:gpt-5.6' },
      },
    };
    const runtime = await import('@/lib/server/model-config/runtime');
    runtime.setDeploymentConfigForTests({ layer: deployment, legacy: false, notices: [] });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const resolved = await resolveModel({
      stage: 'overtime-outline',
      workspaceId: 'owner',
      serviceTier: 'priority',
      modelString: 'openai-codex:gpt-live',
    });
    expect(resolved.providerId).toBe('openai');
    expect(mocks.capability).not.toHaveBeenCalled();
  });
});
