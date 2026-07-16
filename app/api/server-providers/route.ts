import {
  getServerProviders,
  getServerTTSProviders,
  getServerASRProviders,
  getServerPDFProviders,
  getServerImageProviders,
  getServerVideoProviders,
  getServerWebSearchProviders,
  getParallelSceneConcurrency,
} from '@/lib/server/provider-config';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  getCodexNativeImageProvider,
  getCodexNativeServerProvider,
} from '@/lib/server/codex/server-provider';
import { createLogger } from '@/lib/logger';
import { rebuildCodexModelCatalog } from '@/lib/ai/codex-catalog';
import type { ModelInfo } from '@/lib/types/provider';

const log = createLogger('ServerProviders');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function noStore(response: Response): Response {
  response.headers.set('cache-control', 'no-store, max-age=0');
  return response;
}

export async function GET() {
  try {
    const providers: Record<
      string,
      { models?: string[]; fastModels?: string[]; modelCatalog?: ModelInfo[] }
    > = getServerProviders();
    const image = getServerImageProviders();
    // This ID is OAuth-owned. A YAML entry must never spoof connected state.
    delete image['codex-image'];
    try {
      const codex = await getCodexNativeServerProvider();
      if (codex?.models.length) {
        // Rebuild the DTO explicitly so no future internal account/status field
        // can accidentally cross this public settings boundary.
        const modelCatalog = rebuildCodexModelCatalog(codex.modelCatalog);
        providers['openai-codex'] = {
          models: [...codex.models],
          fastModels: [...codex.fastModels],
          ...(modelCatalog ? { modelCatalog } : {}),
        };
      }
    } catch {
      // Model discovery is optional. Every existing provider category remains
      // usable when the Codex backend is temporarily unavailable.
    }
    try {
      // Check image connection last. Text discovery may refresh or terminally
      // clear credentials, so publishing an earlier vault snapshot could
      // otherwise expose stale connected state in this same response.
      const codexImage = await getCodexNativeImageProvider();
      if (codexImage) {
        image['codex-image'] = { models: [...codexImage.models] };
      }
    } catch {
      // Image publication is independent from both text discovery and every
      // existing provider category. Fail closed on OAuth/runtime errors.
    }

    return noStore(
      apiSuccess({
        providers,
        tts: getServerTTSProviders(),
        asr: getServerASRProviders(),
        pdf: getServerPDFProviders(),
        image,
        video: getServerVideoProviders(),
        webSearch: getServerWebSearchProviders(),
        generation: {
          parallelSceneConcurrency: getParallelSceneConcurrency(),
        },
      }),
    );
  } catch (error) {
    log.error('Error fetching server providers:', error);
    return noStore(
      apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : 'Unknown error'),
    );
  }
}
