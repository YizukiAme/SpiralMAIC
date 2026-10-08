import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ text: vi.fn(), image: vi.fn() }));
vi.mock('@/lib/server/codex/server-provider', () => ({
  getCodexNativeServerProvider: mocks.text,
  getCodexNativeImageProvider: mocks.image,
}));
import { withCodexModelSettings } from '@/lib/server/model-config/codex-view';
import type { ModelSettingsView } from '@/lib/server/model-config/settings';
import { entryConfigured, serviceEntries } from '@/lib/model-settings/services';

function savedView(): ModelSettingsView {
  return {
    revision: 3,
    allowUserKeys: true,
    presets: [],
    providers: [
      {
        id: 'subscription',
        preset: 'openai-codex',
        presetName: 'Codex',
        presetKind: 'single',
        source: 'workspace',
        key: { set: true },
        capabilities: {
          chat: { registryId: 'openai-codex', models: [{ id: 'stale-model', name: 'Stale' }] },
        },
      },
      {
        id: 'images',
        preset: 'codex-image',
        presetName: 'Images',
        presetKind: 'single',
        source: 'workspace',
        key: { set: true },
        capabilities: {
          image: {
            registryId: 'codex-image',
            models: [{ id: 'injected-model', name: 'Injected' }],
          },
        },
      },
    ],
    slots: [
      {
        slot: 'llm',
        effective: { status: 'assigned', registryId: 'openai-codex', modelId: 'gpt-live' },
      },
      {
        slot: 'image',
        effective: { status: 'assigned', registryId: 'codex-image', modelId: 'gpt-image-2' },
      },
    ] as ModelSettingsView['slots'],
  };
}

describe('live Codex model settings view', () => {
  beforeEach(() => {
    mocks.text.mockReset().mockResolvedValue({
      modelCatalog: [
        {
          id: 'gpt-live',
          name: 'Live model',
          capabilities: { vision: true, contextWindow: 100000, serviceTiers: ['priority'] },
        },
      ],
    });
    mocks.image.mockReset().mockResolvedValue({ models: ['gpt-image-2'] });
  });

  it('publishes account capabilities and fixed native images without persisting the live catalogue', async () => {
    const saved = savedView();
    const view = await withCodexModelSettings(saved);
    expect(view.providers[0].connected).toBe(true);
    expect(view.providers[0].capabilities.chat?.models).toMatchObject([
      { id: 'gpt-live', capabilities: { vision: true, serviceTiers: ['priority'] } },
    ]);
    expect(view.providers[1].capabilities.image?.models.map((model) => model.id)).toEqual([
      'gpt-image-2',
    ]);
    expect(saved.providers[1].capabilities.image?.models[0].id).toBe('injected-model');
    expect(entryConfigured(serviceEntries(view, 'image', ['codex-image'])[0], false)).toBe(true);
  });

  it('disables disconnected OAuth choices despite a stale saved key and assignment', async () => {
    mocks.text.mockResolvedValue(null);
    mocks.image.mockResolvedValue(null);
    const view = await withCodexModelSettings(savedView());
    expect(view.slots.map((slot) => slot.effective.status)).toEqual(['invalid', 'invalid']);
    expect(view.providers[1].capabilities.image?.models).toEqual([]);
    expect(entryConfigured(serviceEntries(view, 'image', ['codex-image'])[0], false)).toBe(false);
    expect(entryConfigured(serviceEntries(view, 'chat', ['openai-codex'])[0], false)).toBe(false);
  });

  it('refuses an unavailable text model while keeping independent image authorization usable', async () => {
    mocks.text.mockResolvedValue(null);
    const view = await withCodexModelSettings(savedView());
    expect(view.slots[0].effective.status).toBe('invalid');
    expect(view.slots[1].effective.status).toBe('assigned');
    expect(view.providers[1].connected).toBe(true);
  });
});
