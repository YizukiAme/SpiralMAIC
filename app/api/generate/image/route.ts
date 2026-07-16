/**
 * Image Generation API
 *
 * Generates an image from a text prompt using the specified provider.
 * Called by the client during media generation after slides are produced.
 *
 * POST /api/generate/image
 *
 * Headers:
 *   x-image-provider: ImageProviderId (default: 'seedream')
 *   x-api-key: string (optional, server fallback)
 *   x-base-url: string (optional, server fallback)
 *
 * Body: { prompt, negativePrompt?, width?, height?, aspectRatio?, style? }
 * Response: { success: boolean, result?: ImageGenerationResult, error?: string }
 */

import { NextRequest } from 'next/server';
import { recordGenerationUsage } from '@/lib/server/usage-storage';
import {
  generateImage,
  aspectRatioToDimensions,
  IMAGE_PROVIDERS,
} from '@/lib/media/image-providers';
import {
  isServerConfiguredProvider,
  resolveImageApiKey,
  resolveImageBaseUrl,
} from '@/lib/server/provider-config';
import type { ImageProviderId, ImageGenerationOptions } from '@/lib/media/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { getCodexOAuthAvailability } from '@/lib/server/codex/availability';
import {
  CODEX_IMAGE_GENERATIONS_ENDPOINT,
  CODEX_IMAGE_MODEL,
  CODEX_IMAGE_TRANSPORT_ERROR_CODES,
  CodexImageTransportError,
  createCodexImageTransport,
} from '@/lib/server/codex/image-transport';
import { getCodexAuthRuntime } from '@/lib/server/codex/runtime';

const log = createLogger('ImageGeneration API');

// The ComfyUI adapter polls up to GENERATION_TIMEOUT_MS (5 min) and real
// workflows can take 3–5 min. 60s would let platforms that enforce maxDuration
// (e.g. Vercel) kill the request ~4 min before the adapter finishes. 300s is
// the practical ceiling on most managed platforms and matches the poll budget.
// (Self-hosted Node servers ignore this value entirely.)
export const maxDuration = 300;

function codexImageErrorResponse(caught: unknown): Response {
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

async function generateCodexImage(
  request: NextRequest,
  body: ImageGenerationOptions,
  clientModel: string | undefined,
): Promise<Response> {
  if (clientModel && clientModel !== CODEX_IMAGE_MODEL) {
    return apiError('INVALID_REQUEST', 400, `Codex image model must be ${CODEX_IMAGE_MODEL}`);
  }

  try {
    const availability = await getCodexOAuthAvailability();
    if (!availability.available) {
      return apiError('PROVIDER_DISABLED', 503, 'Codex OAuth image generation is unavailable');
    }
    const runtime = getCodexAuthRuntime();
    const transport = createCodexImageTransport({
      tokenProvider: runtime.tokenProvider,
      onObservation: (observation) => {
        log.info('Codex image success observation', observation);
      },
    });
    const result = await transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, {
      prompt: body.prompt,
      aspectRatio: body.aspectRatio,
      signal: request.signal,
    });

    void recordGenerationUsage({
      kind: 'image',
      unit: 'image',
      providerId: 'codex-image',
      modelId: CODEX_IMAGE_MODEL,
      quantity: 1,
    });
    return apiSuccess({ result });
  } catch (caught) {
    return codexImageErrorResponse(caught);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as ImageGenerationOptions;

    if (!body.prompt) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing prompt');
    }

    const providerId = (request.headers.get('x-image-provider') || 'seedream') as ImageProviderId;
    const clientModel = request.headers.get('x-image-model') || undefined;
    if (providerId === 'codex-image') {
      return generateCodexImage(request, body, clientModel);
    }

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
    const provider = IMAGE_PROVIDERS[providerId];
    if (provider?.requiresApiKey && !apiKey) {
      return apiError(
        'MISSING_API_KEY',
        401,
        `No API key configured for image provider: ${providerId}`,
      );
    }

    const baseUrl = resolveImageBaseUrl(providerId, clientBaseUrl);

    // Resolve dimensions from aspect ratio if not explicitly set
    if (!body.width && !body.height && body.aspectRatio) {
      const dims = aspectRatioToDimensions(body.aspectRatio);
      body.width = dims.width;
      body.height = dims.height;
    }

    log.info(
      `Generating image: provider=${providerId}, model=${clientModel || 'default'}, ` +
        `prompt="${body.prompt.slice(0, 80)}...", size=${body.width ?? 'auto'}x${body.height ?? 'auto'}`,
    );

    const result = await generateImage({ providerId, apiKey, baseUrl, model: clientModel }, body);

    void recordGenerationUsage({
      kind: 'image',
      unit: 'image',
      providerId,
      modelId: clientModel,
      quantity: 1,
    });

    return apiSuccess({ result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Detect content safety filter rejections (e.g. Seedream OutputImageSensitiveContentDetected)
    if (message.includes('SensitiveContent') || message.includes('sensitive information')) {
      log.warn(`Image blocked by content safety filter: ${message}`);
      return apiError('CONTENT_SENSITIVE', 400, message);
    }
    log.error(
      `Image generation failed [provider=${request.headers.get('x-image-provider') ?? 'seedream'}, model=${request.headers.get('x-image-model') ?? 'default'}]:`,
      error,
    );
    return apiError('INTERNAL_ERROR', 500, message);
  }
}
