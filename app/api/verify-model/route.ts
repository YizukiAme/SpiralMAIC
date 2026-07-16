import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModel } from '@/lib/server/resolve-model';
import { callLLM } from '@/lib/ai/llm';
const log = createLogger('Verify Model');

type SafeCodexStatus = 401 | 403 | 429;

function getSafeCodexStatus(error: unknown): SafeCodexStatus | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as { statusCode?: unknown; upstreamStatus?: unknown; code?: unknown };
  for (const status of [record.statusCode, record.upstreamStatus]) {
    if (status === 401 || status === 403 || status === 429) return status;
  }
  if (
    record.code === 'CREDENTIALS_MISSING' ||
    record.code === 'SIGNED_OUT' ||
    record.code === 'INVALID_GRANT' ||
    record.code === 'REFRESH_REJECTED'
  ) {
    return 401;
  }
  return undefined;
}

function codexErrorResponse(error: unknown) {
  const status = getSafeCodexStatus(error) ?? 500;
  if (status === 401) {
    return apiError('INVALID_REQUEST', status, 'ChatGPT sign-in is required');
  }
  if (status === 403) {
    return apiError('INVALID_REQUEST', status, 'This ChatGPT workspace does not have Codex access');
  }
  if (status === 429) {
    return apiError('RATE_LIMITED', status, 'ChatGPT plan quota or rate limit reached');
  }
  return apiError('UPSTREAM_ERROR', status, 'Codex connection failed');
}

export async function POST(req: NextRequest) {
  let model: string | undefined;
  try {
    const body = await req.json();
    const { apiKey, baseUrl, providerType, serviceTier } = body;
    model = body.model;

    if (!model) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Model name is required');
    }

    // Parse model string and resolve server-side fallback
    let languageModel;
    try {
      const result = await resolveModel({
        modelString: model,
        apiKey: apiKey || '',
        baseUrl: baseUrl || undefined,
        providerType,
        ...(model.startsWith('openai-codex:') && serviceTier === 'priority'
          ? { serviceTier: 'priority' as const }
          : {}),
      });
      languageModel = result.model;
    } catch (error) {
      if (model.startsWith('openai-codex:')) return codexErrorResponse(error);
      return apiError(
        'INVALID_REQUEST',
        401,
        error instanceof Error ? error.message : String(error),
      );
    }

    // Send a minimal test message. Use the unified wrapper so compatible
    // providers can receive provider-specific request options.
    const { text } = await callLLM(
      {
        model: languageModel,
        prompt: 'Say "OK" if you can hear me.',
        maxOutputTokens: 64,
      },
      'verify-model',
      undefined,
      { mode: 'disabled', enabled: false },
    );

    return apiSuccess({
      message: 'Connection successful',
      response: text,
    });
  } catch (error) {
    if (model?.startsWith('openai-codex:')) {
      const status = getSafeCodexStatus(error) ?? 500;
      log.error(`Codex model verification failed [status=${status}]`);
      return codexErrorResponse(error);
    }
    log.error(`Model verification failed [model="${model ?? 'unknown'}"]:`, error);

    let errorMessage = 'Connection failed';
    if (error instanceof Error) {
      // Parse common error messages
      if (error.message.includes('401') || error.message.includes('Unauthorized')) {
        errorMessage = 'API key is invalid or expired';
      } else if (error.message.includes('404') || error.message.includes('not found')) {
        errorMessage = 'Model not found or API endpoint error';
      } else if (error.message.includes('429')) {
        errorMessage = 'API rate limit exceeded, please try again later';
      } else if (error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
        errorMessage = 'Cannot connect to API server, please check the Base URL';
      } else if (error.message.includes('timeout')) {
        errorMessage = 'Connection timed out, please check your network';
      } else {
        errorMessage = error.message;
      }
    }

    return apiError('INTERNAL_ERROR', 500, errorMessage);
  }
}
