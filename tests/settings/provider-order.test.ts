import { describe, expect, it } from 'vitest';
import { serviceEntries } from '@/lib/model-settings/services';
import type { ProviderView } from '@/lib/model-settings/client';
import { makeView, workspaceProvider } from '../model-settings/fixtures';

const provider = (id: string, registryId: string): ProviderView => ({
  ...workspaceProvider(id),
  preset: registryId,
  capabilities: { chat: { registryId, models: [{ id: 'live-model', name: 'Model' }] } },
});

describe('settings service order from the server view', () => {
  it('follows registry order for built-ins while keeping custom accounts first', () => {
    const view = makeView({
      presets: [],
      providers: [
        provider('anthropic', 'anthropic'),
        provider('openai-codex', 'openai-codex'),
        provider('openai', 'openai'),
        provider('custom-account', 'google'),
      ],
    });
    expect(
      serviceEntries(view, 'chat', ['openai', 'openai-codex', 'anthropic']).map(
        (entry) => entry.id,
      ),
    ).toEqual(['custom-account', 'openai', 'openai-codex', 'anthropic']);
  });

  it('does not let stale workspace order change built-in service positions', () => {
    const view = makeView({
      presets: [],
      providers: [provider('openai-codex', 'openai-codex'), provider('openai', 'openai')],
    });
    expect(
      serviceEntries(view, 'chat', ['openai', 'openai-codex']).map((entry) => entry.id),
    ).toEqual(['openai', 'openai-codex']);
  });
});
