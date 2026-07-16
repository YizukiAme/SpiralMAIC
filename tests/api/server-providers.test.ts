import { beforeEach, describe, expect, it, vi } from 'vitest';

const getServerProviders = vi.fn();
const getServerImageProviders = vi.fn();
const getCodexNativeServerProvider = vi.fn();
const getCodexNativeImageProvider = vi.fn();

vi.mock('@/lib/server/provider-config', () => ({
  getServerProviders,
  getServerTTSProviders: vi.fn(() => ({ tts: {} })),
  getServerASRProviders: vi.fn(() => ({ asr: {} })),
  getServerPDFProviders: vi.fn(() => ({ pdf: {} })),
  getServerImageProviders,
  getServerVideoProviders: vi.fn(() => ({ video: {} })),
  getServerWebSearchProviders: vi.fn(() => ({ search: {} })),
  getParallelSceneConcurrency: vi.fn(() => 3),
}));

vi.mock('@/lib/server/codex/server-provider', () => ({
  getCodexNativeServerProvider,
  getCodexNativeImageProvider,
}));

describe('/api/server-providers Codex publication', () => {
  beforeEach(() => {
    vi.resetModules();
    getServerProviders.mockReset().mockReturnValue({ openai: { models: ['gpt-5.4'] } });
    getServerImageProviders.mockReset().mockReturnValue({ image: {} });
    getCodexNativeServerProvider.mockReset().mockResolvedValue(null);
    getCodexNativeImageProvider.mockReset().mockResolvedValue(null);
  });

  it('is a dynamic Node route with explicit no-store caching', async () => {
    const route = await import('@/app/api/server-providers/route');
    const response = await route.GET();

    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('publishes sanitized Codex models only when native OAuth reports connected', async () => {
    getCodexNativeServerProvider.mockResolvedValue({
      models: ['gpt-live'],
      fastModels: ['gpt-live'],
      modelCatalog: [
        {
          id: 'gpt-live',
          name: 'GPT Live',
          contextWindow: 372_000,
          capabilities: { streaming: true, tools: true, serviceTiers: ['priority'] },
          source: 'probed',
          prompt: 'must-not-leak',
        },
      ],
      accountId: 'must-not-leak',
      email: 'must-not-leak@example.com',
    });
    const { GET } = await import('@/app/api/server-providers/route');

    const response = await GET();
    const body = await response.json();

    expect(body.providers).toEqual({
      openai: { models: ['gpt-5.4'] },
      'openai-codex': {
        models: ['gpt-live'],
        fastModels: ['gpt-live'],
        modelCatalog: [
          {
            id: 'gpt-live',
            name: 'GPT Live',
            contextWindow: 372_000,
            capabilities: {
              streaming: true,
              tools: true,
              serviceTiers: ['priority'],
            },
            source: 'probed',
          },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toContain('must-not-leak');
  });

  it('hides Codex when disconnected and preserves every existing provider category', async () => {
    const { GET } = await import('@/app/api/server-providers/route');
    const body = await (await GET()).json();

    expect(body.providers['openai-codex']).toBeUndefined();
    expect(body).toMatchObject({
      tts: { tts: {} },
      asr: { asr: {} },
      pdf: { pdf: {} },
      image: { image: {} },
      video: { video: {} },
      webSearch: { search: {} },
      generation: { parallelSceneConcurrency: 3 },
    });
  });

  it('keeps the route usable when Codex model discovery fails', async () => {
    getCodexNativeServerProvider.mockRejectedValue(new Error('model failure sentinel'));
    getCodexNativeImageProvider.mockResolvedValue({
      models: ['gpt-image-2'],
      accountId: 'must-not-leak',
      email: 'must-not-leak@example.com',
    });
    const { GET } = await import('@/app/api/server-providers/route');
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.providers).toEqual({ openai: { models: ['gpt-5.4'] } });
    expect(body.image).toEqual({ image: {}, 'codex-image': { models: ['gpt-image-2'] } });
    expect(JSON.stringify(body)).not.toMatch(/sentinel|must-not-leak/);
  });

  it('revalidates image connection after text discovery changes OAuth state', async () => {
    let connected = true;
    getCodexNativeServerProvider.mockImplementationOnce(async () => {
      connected = false;
      throw new Error('terminal refresh cleared credentials');
    });
    getCodexNativeImageProvider.mockImplementationOnce(async () =>
      connected ? { models: ['gpt-image-2'] } : null,
    );
    const { GET } = await import('@/app/api/server-providers/route');

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.image['codex-image']).toBeUndefined();
    expect(getCodexNativeServerProvider).toHaveBeenCalledBefore(getCodexNativeImageProvider);
  });

  it('publishes no Codex image metadata while disconnected', async () => {
    getServerImageProviders.mockReturnValue({
      image: {},
      'codex-image': { models: ['attacker-yaml-model'] },
    });
    const { GET } = await import('@/app/api/server-providers/route');
    const body = await (await GET()).json();

    expect(body.image['codex-image']).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('attacker-yaml-model');
  });
});
