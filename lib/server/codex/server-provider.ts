import { getCodexOAuthAvailability } from './availability';
import { getCodexAuthRuntime } from './runtime';
import { withCodexCredentialVaultMutation } from './vault';

export interface CodexNativeServerProvider {
  models: string[];
  fastModels: string[];
}

/** Build the non-secret provider fragment consumed by /api/server-providers. */
export async function getCodexNativeServerProvider(): Promise<CodexNativeServerProvider | null> {
  const availability = await getCodexOAuthAvailability();
  if (!availability.available) return null;

  const runtime = getCodexAuthRuntime();
  const credentials = await withCodexCredentialVaultMutation(runtime.vault, () =>
    runtime.vault.load(),
  );
  if (!credentials) {
    runtime.modelDiscovery.invalidate();
    return null;
  }

  const models = await runtime.modelDiscovery.getModels();
  if (models.length === 0) return null;
  return {
    models: models.map((model) => model.id),
    fastModels: models
      .filter((model) => model.capabilities?.serviceTiers?.includes('priority'))
      .map((model) => model.id),
  };
}
