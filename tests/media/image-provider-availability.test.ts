import { describe, expect, it } from 'vitest';

import { isImageProviderAvailable } from '@/lib/media/image-provider-availability';

describe('isImageProviderAvailable', () => {
  it('requires server publication for OAuth providers and honors explicit disable', () => {
    const provider = { requiresApiKey: false, credentialMode: 'oauth' as const };

    expect(isImageProviderAvailable(provider, { isServerConfigured: false })).toBe(false);
    expect(isImageProviderAvailable(provider, { isServerConfigured: true })).toBe(true);
    expect(
      isImageProviderAvailable(provider, {
        enabled: false,
        isServerConfigured: true,
      }),
    ).toBe(false);
  });

  it('preserves API-key and server-managed availability for legacy providers', () => {
    const provider = { requiresApiKey: true };

    expect(isImageProviderAvailable(provider, {})).toBe(false);
    expect(isImageProviderAvailable(provider, { apiKey: 'local-key' })).toBe(true);
    expect(isImageProviderAvailable(provider, { isServerConfigured: true })).toBe(true);
  });

  it('keeps credential-free local providers available', () => {
    expect(isImageProviderAvailable({ requiresApiKey: false }, undefined)).toBe(true);
  });
});
