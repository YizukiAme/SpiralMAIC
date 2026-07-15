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
import { getCodexNativeServerProvider } from '@/lib/server/codex/server-provider';
import { createLogger } from '@/lib/logger';

const log = createLogger('ServerProviders');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function noStore(response: Response): Response {
  response.headers.set('cache-control', 'no-store, max-age=0');
  return response;
}

export async function GET() {
  try {
    const providers: Record<string, { models?: string[]; fastModels?: string[] }> =
      getServerProviders();
    try {
      const codex = await getCodexNativeServerProvider();
      if (codex?.models.length) {
        // Rebuild the DTO explicitly so no future internal account/status field
        // can accidentally cross this public settings boundary.
        providers['openai-codex'] = {
          models: [...codex.models],
          fastModels: [...codex.fastModels],
        };
      }
    } catch {
      // Model discovery is optional. Every existing provider category remains
      // usable when the Codex backend is temporarily unavailable.
    }

    return noStore(
      apiSuccess({
        providers,
        tts: getServerTTSProviders(),
        asr: getServerASRProviders(),
        pdf: getServerPDFProviders(),
        image: getServerImageProviders(),
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
