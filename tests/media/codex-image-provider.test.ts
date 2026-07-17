import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  IMAGE_PROVIDERS,
  generateImage,
  getImageProviderCredentialMode,
  testImageConnectivity,
} from '@/lib/media/image-providers';

describe('Codex image provider registry', () => {
  it('registers Codex second with fixed OAuth metadata', () => {
    expect(Object.keys(IMAGE_PROVIDERS).slice(0, 3)).toEqual([
      'seedream',
      'codex-image',
      'openai-image',
    ]);
    expect(IMAGE_PROVIDERS['codex-image']).toEqual({
      id: 'codex-image',
      name: 'Codex',
      requiresApiKey: false,
      credentialMode: 'oauth',
      icon: '/logos/openai.svg',
      models: [{ id: 'gpt-image-2', name: 'GPT Image 2' }],
      supportedAspectRatios: ['16:9', '4:3', '1:1', '9:16'],
    });
  });

  it('preserves legacy credential-mode inference', () => {
    expect(getImageProviderCredentialMode({ requiresApiKey: true })).toBe('api-key');
    expect(getImageProviderCredentialMode({ requiresApiKey: false })).toBe('none');
    expect(getImageProviderCredentialMode({ requiresApiKey: false, credentialMode: 'oauth' })).toBe(
      'oauth',
    );
  });

  it('keeps the generic provider module client-safe', async () => {
    const source = await readFile(
      new URL('../../lib/media/image-providers.ts', import.meta.url),
      'utf8',
    );

    expect(source).not.toContain('@/lib/server/codex');
    expect(source).not.toContain('./server/codex');
  });

  it('fails closed when generic client-safe dispatch is used for Codex', async () => {
    const config = {
      providerId: 'codex-image' as const,
      apiKey: 'must-be-ignored',
      baseUrl: 'https://attacker.invalid',
      model: 'attacker-model',
    };

    await expect(
      generateImage(config, { prompt: 'private prompt', aspectRatio: '16:9' }),
    ).rejects.toThrow(/server route/i);
    await expect(testImageConnectivity(config)).resolves.toMatchObject({
      success: false,
      message: expect.stringMatching(/server route/i),
    });
  });
});
