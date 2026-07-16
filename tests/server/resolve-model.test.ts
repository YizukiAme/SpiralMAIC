import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveCodexUpstreamSessionId } from '@/lib/server/codex/logical-session';
import type { ModelInfo } from '@/lib/types/provider';

// Mock the heavy downstream of resolveModel so the test isolates the model
// string *resolution order*: stage route > x-model > DEFAULT_MODEL > builtin.
// model-routes is left real (it just reads MODEL_ROUTES) so we exercise the
// real integration point.
// Use the real parseModelString (canonical `provider:model` colon format) so
// the test exercises actual separator handling; only stub getModel (recording
// its args) so no real provider client is constructed. provider-config stubs
// echo the client-supplied key/baseUrl so a test can assert they are dropped
// when a stage route overrides the client model.
const mocks = vi.hoisted(() => {
  const codexTokenProvider = {
    getValidCredentials: vi.fn(async () => ({ accessToken: 'token', accountId: 'account' })),
  };
  const capabilityLease = {
    credentialLease: {
      tokenProvider: codexTokenProvider,
      credentials: { accessToken: 'token', accountId: 'account' },
      lifecycleGeneration: 1,
    },
    isCatalogCurrent: () => true,
  };
  const codexModelDiscovery = {
    getModels: vi.fn<() => Promise<ModelInfo[]>>(async () => [
      {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        capabilities: { serviceTiers: ['priority'] },
      },
    ]),
    getModelCapability: vi.fn(async (modelId: string) => {
      const modelInfo = (await codexModelDiscovery.getModels()).find(
        (model: ModelInfo) => model.id === modelId,
      );
      return modelInfo ? { modelInfo, capabilityLease } : null;
    }),
  };
  return {
    getModelCalls: [] as Array<Record<string, unknown>>,
    getCodexOAuthAvailability: vi.fn(async () => ({
      available: true,
      reason: 'available',
      methods: ['device'],
    })),
    codexTokenProvider,
    codexModelDiscovery,
    capabilityLease,
    codexTransport: vi.fn(),
    createCodexResponsesTransport: vi.fn(
      (_options: { tokenProvider: unknown; sessionId?: string; capabilityLease?: unknown }) =>
        vi.fn(),
    ),
  };
});

vi.mock('@/lib/ai/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/providers')>();
  return {
    ...actual,
    getModel: (args: Record<string, unknown>) => {
      mocks.getModelCalls.push(args);
      return { model: { id: args.modelId }, modelInfo: undefined };
    },
  };
});

vi.mock('@/lib/server/provider-config', () => ({
  isServerConfiguredProvider: () => false,
  resolveApiKey: (_id: string, clientKey: string) => clientKey || 'server-key',
  resolveBaseUrl: (_id: string, clientBaseUrl?: string) => clientBaseUrl,
  resolveProxy: () => undefined,
}));

vi.mock('@/lib/server/ssrf-guard', () => ({
  validateUrlForSSRF: async () => null,
}));

vi.mock('@/lib/server/codex/availability', () => ({
  getCodexOAuthAvailability: mocks.getCodexOAuthAvailability,
}));

vi.mock('@/lib/server/codex/runtime', () => ({
  getCodexAuthRuntime: () => ({
    tokenProvider: mocks.codexTokenProvider,
    modelDiscovery: mocks.codexModelDiscovery,
  }),
}));

vi.mock('@/lib/server/codex/transport', () => ({
  createCodexResponsesTransport: mocks.createCodexResponsesTransport,
}));

describe('resolveModel — per-stage resolution order', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.getModelCalls.length = 0;
    mocks.getCodexOAuthAvailability.mockClear();
    mocks.getCodexOAuthAvailability.mockResolvedValue({
      available: true,
      reason: 'available',
      methods: ['device'],
    });
    mocks.codexTokenProvider.getValidCredentials.mockClear();
    mocks.codexTokenProvider.getValidCredentials.mockResolvedValue({
      accessToken: 'token',
      accountId: 'account',
    });
    mocks.codexModelDiscovery.getModels.mockClear();
    mocks.codexModelDiscovery.getModels.mockResolvedValue([
      {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        capabilities: { serviceTiers: ['priority'] },
      },
    ]);
    mocks.codexModelDiscovery.getModelCapability.mockClear();
    mocks.createCodexResponsesTransport.mockClear();
    mocks.createCodexResponsesTransport.mockReturnValue(mocks.codexTransport);
    delete process.env.MODEL_ROUTES;
    delete process.env.DEFAULT_MODEL;
  });

  it('throws (no hardcoded fallback) when nothing is configured', async () => {
    const { resolveModel } = await import('@/lib/server/resolve-model');
    await expect(resolveModel({ stage: 'scene-content' })).rejects.toThrow(
      /No model could be resolved/,
    );
  });

  it('uses DEFAULT_MODEL when no stage route matches', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'scene-content' });
    expect(r.modelString).toBe('openai:gpt-5.4-mini');
  });

  it('uses the stage route over DEFAULT_MODEL', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'scene-content' });
    expect(r.modelString).toBe('openai:gpt-5.4');
  });

  it('uses DEFAULT_MODEL for stages not listed in MODEL_ROUTES', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'quiz-grade' });
    expect(r.modelString).toBe('openai:gpt-5.4-mini');
  });

  it('lets a configured stage route win over an explicit modelString (x-model)', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({
      stage: 'scene-content',
      modelString: 'anthropic:claude-sonnet-4',
    });
    expect(r.modelString).toBe('openai:gpt-5.4');
  });

  it('falls back to x-model for a stage that is not routed', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'quiz-grade', modelString: 'anthropic:claude-sonnet-4' });
    expect(r.modelString).toBe('anthropic:claude-sonnet-4');
  });

  it('drops client apiKey/baseUrl/providerType when a stage route overrides the client model', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({ 'pbl-chat': 'anthropic:claude-sonnet-4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    await resolveModel({
      stage: 'pbl-chat',
      modelString: 'openai:gpt-5.4-mini',
      apiKey: 'client-openai-key',
      baseUrl: 'https://client.example/v1',
      providerType: 'openai',
    });
    const call = mocks.getModelCalls.at(-1)!;
    expect(call.providerId).toBe('anthropic');
    expect(call.modelId).toBe('claude-sonnet-4');
    // None of the client-sent connection params for the OLD provider leak onto
    // the routed provider — they resolve from server config instead.
    expect(call.providerType).toBeUndefined();
    expect(call.baseUrl).toBeUndefined();
    expect(call.apiKey).toBe('server-key');
  });

  it('keeps client apiKey/baseUrl/providerType for an unrouted stage (x-model honored)', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    await resolveModel({
      stage: 'quiz-grade',
      modelString: 'openai:gpt-5.4-mini',
      apiKey: 'client-key',
      baseUrl: 'https://client.example/v1',
      providerType: 'openai',
    });
    const call = mocks.getModelCalls.at(-1)!;
    expect(call.providerType).toBe('openai');
    expect(call.baseUrl).toBe('https://client.example/v1');
    expect(call.apiKey).toBe('client-key');
  });

  it('resolves Codex only through the server OAuth transport and ignores every client override', async () => {
    const { resolveModel } = await import('@/lib/server/resolve-model');

    const resolved = await resolveModel({
      modelString: 'openai-codex:gpt-5.4',
      apiKey: 'client-key',
      baseUrl: 'https://attacker.example/v1',
      providerType: 'anthropic',
    });

    expect(mocks.getCodexOAuthAvailability).toHaveBeenCalledTimes(1);
    expect(mocks.codexModelDiscovery.getModelCapability).toHaveBeenCalledWith('gpt-5.4');
    expect(mocks.createCodexResponsesTransport).toHaveBeenCalledWith({
      tokenProvider: mocks.codexTokenProvider,
      sessionId: expect.stringMatching(/^oma_[A-Za-z0-9_-]{43}$/),
      capabilityLease: mocks.capabilityLease,
    });
    expect(mocks.getModelCalls.at(-1)).toEqual({
      providerId: 'openai-codex',
      modelId: 'gpt-5.4',
      apiKey: '',
      customFetch: mocks.codexTransport,
    });
    expect(resolved).toMatchObject({
      providerId: 'openai-codex',
      modelId: 'gpt-5.4',
      apiKey: '',
      modelInfo: {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        capabilities: { serviceTiers: ['priority'] },
      },
    });
    expect(resolved.baseUrl).toBeUndefined();
  });

  it('binds a provided logical session to the Codex transport for this model resolution', async () => {
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const logicalSession = { kind: 'revisit-attempt', id: 'attempt-1' } as const;

    await resolveModel({
      modelString: 'openai-codex:gpt-5.4',
      logicalSession,
    });

    expect(mocks.createCodexResponsesTransport).toHaveBeenCalledWith({
      tokenProvider: mocks.codexTokenProvider,
      sessionId: deriveCodexUpstreamSessionId(logicalSession),
      capabilityLease: mocks.capabilityLease,
    });
  });

  it('creates a fresh ephemeral identity for each one-shot Codex model resolution', async () => {
    const { resolveModel } = await import('@/lib/server/resolve-model');

    await resolveModel({ modelString: 'openai-codex:gpt-5.4' });
    await resolveModel({ modelString: 'openai-codex:gpt-5.4' });

    const firstSessionId = mocks.createCodexResponsesTransport.mock.calls[0]?.[0]?.sessionId;
    const secondSessionId = mocks.createCodexResponsesTransport.mock.calls[1]?.[0]?.sessionId;
    expect(firstSessionId).toMatch(/^oma_[A-Za-z0-9_-]{43}$/);
    expect(secondSessionId).not.toBe(firstSessionId);
  });

  it('accepts priority for an unrouted Codex model only after server discovery confirms support', async () => {
    const { resolveModel } = await import('@/lib/server/resolve-model');

    const resolved = await resolveModel({
      modelString: 'openai-codex:gpt-5.4',
      serviceTier: 'priority',
    });

    expect(mocks.codexModelDiscovery.getModels).toHaveBeenCalledTimes(1);
    expect(mocks.getModelCalls.at(-1)).toMatchObject({ serviceTier: 'priority' });
    expect(resolved.serviceTier).toBe('priority');
  });

  it('drops priority when the discovered Codex model does not advertise it', async () => {
    mocks.codexModelDiscovery.getModels.mockResolvedValueOnce([
      { id: 'gpt-5.4', name: 'GPT-5.4', capabilities: { serviceTiers: [] } },
    ]);
    const { resolveModel } = await import('@/lib/server/resolve-model');

    const resolved = await resolveModel({
      modelString: 'openai-codex:gpt-5.4',
      serviceTier: 'priority',
    });

    expect(mocks.getModelCalls.at(-1)).not.toHaveProperty('serviceTier');
    expect(resolved.serviceTier).toBeUndefined();
  });

  it('does not let a client tier bleed into a routed Codex stage', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({ 'pbl-chat': 'openai-codex:gpt-5.4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');

    const resolved = await resolveModel({
      stage: 'pbl-chat',
      modelString: 'openai-codex:gpt-client',
      serviceTier: 'priority',
    });

    expect(mocks.codexModelDiscovery.getModels).toHaveBeenCalledTimes(1);
    expect(mocks.getModelCalls.at(-1)).not.toHaveProperty('serviceTier');
    expect(resolved.serviceTier).toBeUndefined();
  });

  it('returns dynamic Codex vision, thinking, and context metadata from discovery', async () => {
    mocks.codexModelDiscovery.getModels.mockResolvedValueOnce([
      {
        id: 'gpt-dynamic',
        name: 'GPT Dynamic',
        contextWindow: 456_789,
        capabilities: {
          streaming: true,
          tools: true,
          vision: true,
          thinking: {
            control: 'effort',
            requestAdapter: 'openai',
            effortValues: ['low', 'high'],
            defaultEffort: 'high',
          },
        },
      },
    ]);
    const { resolveModel } = await import('@/lib/server/resolve-model');

    const resolved = await resolveModel({ modelString: 'openai-codex:gpt-dynamic' });

    expect(resolved.modelInfo).toMatchObject({
      id: 'gpt-dynamic',
      contextWindow: 456_789,
      capabilities: {
        vision: true,
        thinking: { effortValues: ['low', 'high'], defaultEffort: 'high' },
      },
    });
  });

  it('only accepts the exact priority service-tier header', async () => {
    const { NextRequest } = await import('next/server');
    const { resolveModelFromHeaders } = await import('@/lib/server/resolve-model');

    await resolveModelFromHeaders(
      new NextRequest('http://localhost/api/test', {
        headers: {
          'x-model': 'openai-codex:gpt-5.4',
          'x-service-tier': 'fast',
        },
      }),
    );
    expect(mocks.codexModelDiscovery.getModels).toHaveBeenCalledTimes(1);
    expect(mocks.getModelCalls.at(-1)).not.toHaveProperty('serviceTier');

    await resolveModelFromHeaders(
      new NextRequest('http://localhost/api/test', {
        headers: {
          'x-model': 'openai-codex:gpt-5.4',
          'x-service-tier': 'priority',
        },
      }),
    );
    expect(mocks.codexModelDiscovery.getModels).toHaveBeenCalledTimes(2);
    expect(mocks.getModelCalls.at(-1)).toMatchObject({ serviceTier: 'priority' });
  });

  it('rejects an unavailable Codex provider before reading credentials or constructing a model', async () => {
    mocks.getCodexOAuthAvailability.mockResolvedValueOnce({
      available: false,
      reason: 'feature-disabled',
      methods: [],
    });
    const { resolveModel } = await import('@/lib/server/resolve-model');

    await expect(resolveModel({ modelString: 'openai-codex:gpt-5.4' })).rejects.toThrow(
      /Codex OAuth provider is unavailable \(feature-disabled\)/,
    );
    expect(mocks.codexTokenProvider.getValidCredentials).not.toHaveBeenCalled();
    expect(mocks.createCodexResponsesTransport).not.toHaveBeenCalled();
    expect(mocks.getModelCalls).toHaveLength(0);
  });

  it('rejects disconnected Codex credentials before constructing a model', async () => {
    mocks.codexModelDiscovery.getModelCapability.mockRejectedValueOnce(
      new Error('Codex credentials are unavailable'),
    );
    const { resolveModel } = await import('@/lib/server/resolve-model');

    await expect(resolveModel({ modelString: 'openai-codex:gpt-5.4' })).rejects.toThrow(
      'Codex credentials are unavailable',
    );
    expect(mocks.createCodexResponsesTransport).not.toHaveBeenCalled();
    expect(mocks.getModelCalls).toHaveLength(0);
  });

  it('uses a scene-content:<type> route over the base route and x-model', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({
      'scene-content': 'openai:gpt-5.4-mini',
      'scene-content:quiz': 'openai:gpt-5.4',
    });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({
      stage: 'scene-content:quiz',
      modelString: 'anthropic:claude-sonnet-4',
    });
    expect(r.modelString).toBe('openai:gpt-5.4');
  });

  it('falls back to the base scene-content route for an unrouted type', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'scene-content:slide' });
    expect(r.modelString).toBe('openai:gpt-5.4');
  });

  it('resolves the stage route provider for cross-provider routing', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'pbl-chat': 'anthropic:claude-sonnet-4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'pbl-chat' });
    expect(r.modelString).toBe('anthropic:claude-sonnet-4');
    expect(r.providerId).toBe('anthropic');
    expect(r.modelId).toBe('claude-sonnet-4');
  });

  it('route thinking wins over client thinking when the stage is routed', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'pbl-chat': { model: 'anthropic:claude-sonnet-4', thinking: { effort: 'high' } },
    });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'pbl-chat', thinkingConfig: { effort: 'low' } });
    expect(r.thinkingConfig).toEqual({ effort: 'high' });
  });

  it('route can pass a full thinking config (enabled + budgetTokens)', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'scene-content:interactive': {
        model: 'qwen:qwen3.7-plus',
        thinking: { enabled: true, budgetTokens: 8000 },
      },
    });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'scene-content:interactive' });
    expect(r.thinkingConfig).toEqual({ enabled: true, budgetTokens: 8000 });
  });

  it('routed-without-thinking drops client thinking (routed model uses its default)', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'deepseek:deepseek-v4-pro' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'scene-content', thinkingConfig: { effort: 'high' } });
    expect(r.thinkingConfig).toBeUndefined();
  });

  it('unrouted stage keeps the client thinking config', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'deepseek:deepseek-v4-pro' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({
      stage: 'quiz-grade',
      modelString: 'openai:gpt-5.4-mini',
      thinkingConfig: { effort: 'medium' },
    });
    expect(r.thinkingConfig).toEqual({ effort: 'medium' });
  });

  it('ignores stage routing entirely when no stage is passed', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({});
    expect(r.modelString).toBe('openai:gpt-5.4-mini');
  });
});
