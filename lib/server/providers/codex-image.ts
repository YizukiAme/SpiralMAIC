import type { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError } from '@/lib/server/api-response';
import { StepRefusal } from '@/lib/server/generation/steps/context';
import type { ImageRefusal } from '@/lib/server/generation/steps/image';
import { RequestedProviderRefusedError } from '@/lib/server/model-config/media';
import { recordGenerationUsage } from '@/lib/server/usage-storage';
import { getCodexOAuthAvailability } from '@/lib/server/codex/availability';
import { getCodexAuthRuntime } from '@/lib/server/codex/runtime';
import {
  CODEX_IMAGE_GENERATIONS_ENDPOINT,
  CODEX_IMAGE_MODEL,
  createCodexImageTransport,
  CODEX_IMAGE_TRANSPORT_ERROR_CODES,
  CodexImageTransportError,
} from '@/lib/server/codex/image-transport';
import {
  CODEX_OAUTH_ERROR_CODES,
  CodexOAuthError,
  type CodexOAuthErrorCode,
} from '@/lib/server/codex/token-provider';
import { apiSuccess } from '@/lib/server/api-response';
import type { NativeImageProvider } from '@/lib/server/image-provider-adapters';

const log = createLogger('NativeImage');
function errorResponse(caught: unknown): Response {
  if (!(caught instanceof CodexImageTransportError)) {
    log.error('Unexpected local Codex image generation failure');
    return apiError('INTERNAL_ERROR', 500, 'Codex image generation failed unexpectedly');
  }

  const withSafeDiagnostics = (response: Response): Response => {
    if (caught.source) {
      response.headers.set('x-openmaic-codex-image-error-source', caught.source);
    }
    if (
      caught.source === 'upstream-http' &&
      Number.isInteger(caught.upstreamStatus) &&
      (caught.upstreamStatus as number) >= 100 &&
      (caught.upstreamStatus as number) <= 599
    ) {
      response.headers.set('x-openmaic-codex-image-upstream-status', String(caught.upstreamStatus));
    }
    return response;
  };

  switch (caught.code) {
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.AUTH_REQUIRED:
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.STALE_CREDENTIALS:
      return withSafeDiagnostics(
        apiError('INVALID_CREDENTIALS', 401, 'Reconnect Codex to generate images'),
      );
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.IMAGE_ENTITLEMENT_UNAVAILABLE:
      return withSafeDiagnostics(
        apiError(
          'PROVIDER_DISABLED',
          403,
          'This ChatGPT workspace does not have Codex image access',
        ),
      );
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.FORBIDDEN:
      return withSafeDiagnostics(
        apiError('UPSTREAM_ERROR', 403, 'The Codex image request was forbidden'),
      );
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.RATE_LIMITED:
      return withSafeDiagnostics(
        apiError('RATE_LIMITED', 429, 'The ChatGPT plan or Codex image rate limit was reached'),
      );
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.MODERATION_BLOCKED:
      return withSafeDiagnostics(
        apiError('CONTENT_SENSITIVE', 400, 'The image request was blocked by content moderation'),
      );
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.INVALID_REQUEST:
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.REQUEST_REJECTED:
      return withSafeDiagnostics(
        apiError('INVALID_REQUEST', 400, 'The Codex image request was rejected'),
      );
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.ROUTE_UNAVAILABLE:
      return withSafeDiagnostics(
        apiError(
          'UPSTREAM_ERROR',
          caught.upstreamStatus === 405 ? 405 : 404,
          'Codex image generation is unavailable on this backend',
        ),
      );
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.UPSTREAM_UNAVAILABLE:
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.NETWORK_ERROR:
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.INVALID_RESPONSE:
      return withSafeDiagnostics(
        apiError('UPSTREAM_ERROR', 502, 'Codex image generation is temporarily unavailable'),
      );
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.LOCAL_UNAVAILABLE:
      return apiError('PROVIDER_DISABLED', 503, 'Codex credentials are temporarily unavailable');
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.TIMEOUT:
      return withSafeDiagnostics(
        apiError('UPSTREAM_ERROR', 504, 'Codex image generation timed out'),
      );
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.INVALID_ENDPOINT:
    default:
      log.error(`Unexpected local Codex image transport category: ${caught.code}`);
      return apiError('INTERNAL_ERROR', 500, 'Codex image generation failed unexpectedly');
  }
}

const CODEX_REAUTH_ERROR_CODES = new Set<CodexOAuthErrorCode>([
  CODEX_OAUTH_ERROR_CODES.CREDENTIALS_MISSING,
  CODEX_OAUTH_ERROR_CODES.SIGNED_OUT,
  CODEX_OAUTH_ERROR_CODES.INVALID_GRANT,
  CODEX_OAUTH_ERROR_CODES.REFRESH_REJECTED,
]);

function requiresCodexReauthentication(error: unknown): boolean {
  return error instanceof CodexOAuthError && CODEX_REAUTH_ERROR_CODES.has(error.code);
}

async function verifyConnection() {
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

/** Native account image capability: no request credentials, endpoints or custom models. */
export const codexImageProvider: NativeImageProvider = {
  handlesError: (error) => error instanceof CodexImageTransportError,
  errorResponse,
  verifyConnection,
  requestConnection(request: NextRequest) {
    const requestedModel = request.headers.get('x-image-model')?.trim();
    if (requestedModel && requestedModel !== CODEX_IMAGE_MODEL) {
      throw new RequestedProviderRefusedError(
        apiError('INVALID_REQUEST', 400, 'Codex image generation uses a fixed model'),
      );
    }
    return {
      providerId: 'codex-image',
      modelId: CODEX_IMAGE_MODEL,
      managed: true,
      userEndpoint: false,
      origin: 'request',
    };
  },
  async generate(input, ctx) {
    try {
      if (input.connection.modelId && input.connection.modelId !== CODEX_IMAGE_MODEL) {
        throw new StepRefusal<ImageRefusal>(
          'missing-model',
          `Codex image model must be ${CODEX_IMAGE_MODEL}`,
        );
      }
      const availability = await getCodexOAuthAvailability();
      if (!availability.available) throw new CodexImageTransportError('LOCAL_UNAVAILABLE');
      const transport = createCodexImageTransport({
        tokenProvider: getCodexAuthRuntime().tokenProvider,
        onObservation: (observation) =>
          ctx.log.info('Codex image success observation', observation),
      });
      const result = await transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, {
        prompt: input.options.prompt,
        aspectRatio: input.options.aspectRatio,
        signal: ctx.signal,
      });
      void recordGenerationUsage({
        kind: 'image',
        unit: 'image',
        providerId: 'codex-image',
        modelId: CODEX_IMAGE_MODEL,
        quantity: 1,
      });
      return result;
    } catch (error) {
      if (error instanceof StepRefusal || error instanceof CodexImageTransportError) throw error;
      // A run persists this message; provider bodies and prompts must not become its failure.
      throw new Error('Codex image generation failed unexpectedly');
    }
  },
};
