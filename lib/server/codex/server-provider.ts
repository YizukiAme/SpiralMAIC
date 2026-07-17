import { rebuildCodexModelCatalog } from '@/lib/ai/codex-catalog';
import type { ModelInfo } from '@/lib/types/provider';

import { getCodexOAuthAvailability } from './availability';
import { CODEX_IMAGE_MODEL } from './image-transport';
import { getCodexAuthRuntime } from './runtime';
import { acquireCodexCredentialLease, isCodexCredentialLeaseCurrent } from './token-provider';
import { withCodexCredentialVaultMutation } from './vault';

export interface CodexNativeServerProvider {
  models: string[];
  fastModels: string[];
  modelCatalog?: ModelInfo[];
}

export interface CodexNativeImageProvider {
  models: [typeof CODEX_IMAGE_MODEL];
}

/** Publish fixed, non-secret image metadata without depending on text model discovery. */
export async function getCodexNativeImageProvider(): Promise<CodexNativeImageProvider | null> {
  const availability = await getCodexOAuthAvailability();
  if (!availability.available) return null;

  const runtime = getCodexAuthRuntime();
  try {
    const lease = await acquireCodexCredentialLease(runtime.tokenProvider);
    if (!(await isCodexCredentialLeaseCurrent(lease))) return null;
    return { models: [CODEX_IMAGE_MODEL] };
  } catch {
    return null;
  }
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
  const modelCatalog = rebuildCodexModelCatalog(models);
  if (!modelCatalog) return null;
  return {
    models: modelCatalog.map((model) => model.id),
    fastModels: modelCatalog
      .filter((model) => model.capabilities?.serviceTiers?.includes('priority'))
      .map((model) => model.id),
    modelCatalog,
  };
}
