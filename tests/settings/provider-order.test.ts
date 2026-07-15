import { describe, expect, it } from 'vitest';

import { orderProvidersForSettings } from '@/components/settings/utils';

describe('settings provider order', () => {
  it('keeps OpenAI first and pins Codex second without reordering the remaining providers', () => {
    const providers = [
      { id: 'openai', label: 'OpenAI' },
      { id: 'anthropic', label: 'Claude' },
      { id: 'google', label: 'Gemini' },
      { id: 'openai-codex', label: 'Codex' },
      { id: 'custom-provider', label: 'Custom' },
    ];

    expect(orderProvidersForSettings(providers).map((provider) => provider.id)).toEqual([
      'openai',
      'openai-codex',
      'anthropic',
      'google',
      'custom-provider',
    ]);
  });

  it('leaves provider order unchanged when Codex is absent', () => {
    const providers = [{ id: 'openai' }, { id: 'anthropic' }, { id: 'google' }];

    expect(orderProvidersForSettings(providers)).toEqual(providers);
  });

  it('keeps Codex in the absolute second position for legacy persisted orders', () => {
    const providers = [
      { id: 'anthropic' },
      { id: 'google' },
      { id: 'openai' },
      { id: 'openai-codex' },
    ];

    expect(orderProvidersForSettings(providers).map((provider) => provider.id)).toEqual([
      'anthropic',
      'openai-codex',
      'google',
      'openai',
    ]);
  });
});
