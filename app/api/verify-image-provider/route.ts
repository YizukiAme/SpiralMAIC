/**
 * Verify Image Provider API
 *
 * Lightweight endpoint that validates provider credentials without generating images.
 *
 * POST /api/verify-image-provider
 *
 * Headers:
 *   x-image-provider: ImageProviderId
 *   x-image-model: string (optional)
 *   x-api-key: string (optional, server fallback)
 *   x-base-url: string (optional, server fallback)
 *
 * Response: { success: boolean, message: string }
 */

import { NextRequest } from 'next/server';
import { IMAGE_PROVIDERS, testImageConnectivity } from '@/lib/media/image-providers';
import {
  isServerConfiguredProvider,
  resolveImageApiKey,
  resolveImageBaseUrl,
} from '@/lib/server/provider-config';
import type { ImageProviderId } from '@/lib/media/types';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { getCodexOAuthAvailability } from '@/lib/server/codex/availability';
import { getCodexAuthRuntime } from '@/lib/server/codex/runtime';
import {
  CODEX_OAUTH_ERROR_CODES,
  CodexOAuthError,
  type CodexOAuthErrorCode,
} from '@/lib/server/codex/token-provider';

const log = createLogger('VerifyImageProvider');

// Connectivity probes are lightweight and each underlying request is bounded by
// its own AbortSignal, but the route had no ceiling at all — cap it so a stalled
// upstream can't tie up the function indefinitely.
export const maxDuration = 30;

const CODEX_REAUTH_ERROR_CODES = new Set<CodexOAuthErrorCode>([
  CODEX_OAUTH_ERROR_CODES.CREDENTIALS_MISSING,
  CODEX_OAUTH_ERROR_CODES.SIGNED_OUT,
  CODEX_OAUTH_ERROR_CODES.INVALID_GRANT,
  CODEX_OAUTH_ERROR_CODES.REFRESH_REJECTED,
]);

function requiresCodexReauthentication(error: unknown): boolean {
  return error instanceof CodexOAuthError && CODEX_REAUTH_ERROR_CODES.has(error.code);
}

async function verifyCodexImageProvider() {
  try {
    const availability = await getCodexOAuthAvailability();
    if (!availability.available) {
      return apiError('PROVIDER_DISABLED', 503, 'Codex OAuth image generation is unavailable');
    }
  } catch {
    return apiError('PROVIDER_DISABLED', 503, 'Codex OAuth image generation is unavailable');
  }

  try {
    await getCodexAuthRuntime().tokenProvider.getValidCredentials();
    return apiSuccess({ message: 'Codex OAuth connection is ready' });
  } catch (error) {
    return requiresCodexReauthentication(error)
      ? apiError('INVALID_CREDENTIALS', 401, 'Reconnect Codex to generate images')
      : apiError('PROVIDER_DISABLED', 503, 'Codex OAuth connection could not be verified');
  }
}

export async function POST(request: NextRequest) {
  try {
    const providerId = (request.headers.get('x-image-provider') || 'seedream') as ImageProviderId;
    if (providerId === 'codex-image') return verifyCodexImageProvider();

    const model = request.headers.get('x-image-model') || undefined;
    // Managed providers are admin-owned: ignore any client-sent key/baseUrl.
    const managed = isServerConfiguredProvider('image', providerId);
    const clientApiKey = managed ? undefined : request.headers.get('x-api-key') || undefined;
    const clientBaseUrl = managed ? undefined : request.headers.get('x-base-url') || undefined;

    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const apiKey = resolveImageApiKey(providerId, clientApiKey);
    const baseUrl = resolveImageBaseUrl(providerId, clientBaseUrl);

    const provider = IMAGE_PROVIDERS[providerId];
    if (provider?.requiresApiKey && !apiKey) {
      return apiError('MISSING_API_KEY', 400, 'No API key configured');
    }

    const result = await testImageConnectivity({
      providerId,
      apiKey,
      baseUrl,
      model,
    });

    if (!result.success) {
      return apiError('UPSTREAM_ERROR', 500, result.message);
    }

    return apiSuccess({ message: result.message });
  } catch (err) {
    log.error(
      `Image provider verification failed [provider=${request.headers.get('x-image-provider') ?? 'seedream'}]:`,
      err,
    );
    return apiError('INTERNAL_ERROR', 500, `Connectivity test error: ${err}`);
  }
}
