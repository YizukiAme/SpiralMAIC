import { getImageProviderCredentialMode } from './image-providers';
import type { ImageProviderConfig } from './types';

interface ImageProviderCredentialState {
  apiKey?: string;
  enabled?: boolean;
  isServerConfigured?: boolean;
}

/**
 * Client-safe provider visibility rule used by generation controls.
 * OAuth providers are server-published capabilities; browser state alone can
 * never make them available. Existing API-key and keyless behavior is kept.
 */
export function isImageProviderAvailable(
  provider: Pick<ImageProviderConfig, 'credentialMode' | 'requiresApiKey'> | undefined,
  config: ImageProviderCredentialState | undefined,
): boolean {
  if (!provider) return false;
  const credentialMode = getImageProviderCredentialMode(provider);
  if (credentialMode === 'oauth') {
    return config?.enabled !== false && config?.isServerConfigured === true;
  }
  if (credentialMode === 'api-key') {
    return Boolean(config?.apiKey || config?.isServerConfigured);
  }
  return true;
}
