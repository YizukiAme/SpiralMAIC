// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelSettingsClient, type ModelSettingsView } from '@/lib/model-settings/client';
import { makeView } from '../model-settings/fixtures';

const state = vi.hoisted(() => ({ view: null as ModelSettingsView | null }));
vi.mock('@/lib/model-settings/use-model-settings', () => ({
  useModelSettingsView: () => state.view,
}));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: (select: (state: unknown) => unknown) =>
    select({ codexFastMode: false, setCodexFastMode: () => {} }),
}));
import { CodexProviderSettings } from '@/components/settings/codex-provider-settings';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  modelSettingsClient.adopt(null);
});

async function renderConnected(
  locked: boolean,
  capability: 'chat' | 'image' = 'chat',
  testStatus = 200,
) {
  state.view = makeView({
    revision: 100,
    presets: [
      {
        id: 'openai-codex',
        name: 'Codex',
        kind: 'single',
        capabilities: {
          chat: {
            registryId: 'openai-codex',
            models: [
              {
                id: 'gpt-live',
                name: 'Live account model',
                capabilities: { serviceTiers: ['priority'] },
              },
            ],
          },
        },
        requiresBaseUrl: false,
        customEndpoint: false,
        recommended: {},
      },
      {
        id: 'codex-image',
        name: 'Codex Image',
        kind: 'single',
        capabilities: {
          image: {
            registryId: 'codex-image',
            models: [{ id: 'gpt-image-2', name: 'Native image model' }],
          },
        },
        requiresBaseUrl: false,
        customEndpoint: false,
        recommended: {},
      },
    ],
  });
  state.view.slots.find((slot) => slot.slot === (capability === 'chat' ? 'llm' : 'image'))!.locked =
    locked;
  if (capability === 'image') {
    state.view.slots[0].assignment = 'other-chat:gpt-existing';
    state.view.slots[0].effective = { status: 'invalid', message: 'Unknown provider' };
    state.view.slots.find((slot) => slot.slot === 'image')!.assignment = 'other-image:existing';
    state.view.slots.find((slot) => slot.slot === 'image')!.effective = {
      status: 'invalid',
      message: 'Unknown provider',
    };
  }
  const changes: unknown[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('/api/verify-')) {
      return Response.json({ error: 'private-upstream-body' }, { status: testStatus });
    }
    if (String(input) === '/api/codex/auth') {
      return Response.json({
        available: true,
        reason: 'AVAILABLE',
        methods: ['browser', 'device'],
        connected: true,
      });
    }
    if (init?.method === 'PUT') {
      const change = JSON.parse(String(init.body)).change;
      changes.push(change);
      const view = state.view!;
      if (change.kind === 'provider') {
        state.view = {
          ...view,
          revision: 101,
          providers: [
            ...view.providers,
            {
              id: change.id,
              preset: change.preset,
              presetName: change.preset,
              presetKind: 'single',
              source: 'workspace',
              connected: true,
              capabilities: view.presets.find((preset) => preset.id === change.preset)!
                .capabilities,
            },
          ],
        };
      }
    }
    return Response.json(state.view);
  });
  vi.stubGlobal('fetch', fetcher);
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(CodexProviderSettings, { capability })));
  return { changes, host };
}

describe('connected native account settings', () => {
  it('shows live models after upgrade and saves a declaration only after explicit Use', async () => {
    const { changes, host } = await renderConnected(false);
    expect(host.textContent).toContain('Live account model');
    expect(host.querySelector('[role="switch"]')).not.toBeNull();
    expect(changes).toEqual([]);
    const use = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('settings.modelSettings.picker.use'),
    )!;
    await act(async () => use.click());
    expect(changes).toEqual([
      { kind: 'provider', id: 'openai-codex', preset: 'openai-codex' },
      { kind: 'slots', set: { llm: 'openai-codex:gpt-live' } },
    ]);
    expect(JSON.stringify(changes)).not.toContain('apiKey');
  });

  it('does not offer an actionable Use control for a locked default', async () => {
    const { host, changes } = await renderConnected(true);
    const use = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('settings.modelSettings.picker.use'),
    )!;
    expect(use.disabled).toBe(true);
    expect(changes).toEqual([]);
  });

  it('explicit image Use replaces only the image assignment and preserves unrelated chat', async () => {
    const { changes, host } = await renderConnected(false, 'image');
    const use = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('settings.modelSettings.picker.use'),
    )!;

    await act(async () => use.click());

    expect(changes).toEqual([
      { kind: 'provider', id: 'codex-image', preset: 'codex-image' },
      { kind: 'slots', set: { image: 'codex-image:gpt-image-2' } },
    ]);
    expect(state.view!.slots[0].assignment).toBe('other-chat:gpt-existing');
    expect(host.querySelector('[role="switch"]')).toBeNull();
  });

  it('keeps explicit image Use disabled when the image slot is locked', async () => {
    const { host, changes } = await renderConnected(true, 'image');
    const use = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('settings.modelSettings.picker.use'),
    )!;
    expect(use.disabled).toBe(true);
    expect(changes).toEqual([]);
  });

  it.each(['chat', 'image'] as const)(
    'keeps the safe rate-limit explanation when testing a saved %s provider',
    async (capability) => {
      const { host } = await renderConnected(false, capability, 429);
      const button = (key: string) =>
        [...host.querySelectorAll('button')].find((entry) => entry.textContent?.includes(key))!;
      await act(async () => button('settings.modelSettings.picker.use').click());

      await act(async () => button('settings.codexOAuth.testConnection').click());

      expect(host.textContent).toContain('settings.codexOAuth.testRateLimited');
      expect(host.textContent).not.toContain('private-upstream-body');
    },
  );
});
