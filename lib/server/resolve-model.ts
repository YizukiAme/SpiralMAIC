/**
 * Shared model resolution utilities for API routes.
 *
 * Extracts the repeated parseModelString → resolveApiKey → resolveBaseUrl →
 * resolveProxy → getModel boilerplate into a single call.
 */

import type { NextRequest } from 'next/server';
import { getModel, parseModelString, type ModelWithInfo } from '@/lib/ai/providers';
import type { ModelServiceTier, ThinkingConfig } from '@/lib/types/provider';
import {
  isServerConfiguredProvider,
  resolveApiKey,
  resolveBaseUrl,
  resolveProxy,
} from '@/lib/server/provider-config';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { getStageRoute, type LlmStage } from '@/lib/server/model-routes';
import { getCodexOAuthAvailability } from '@/lib/server/codex/availability';
import { getCodexAuthRuntime } from '@/lib/server/codex/runtime';
import { createCodexResponsesTransport } from '@/lib/server/codex/transport';

export interface ResolvedModel extends ModelWithInfo {
  /** Original model string (e.g. "openai/gpt-4o-mini") */
  modelString: string;
  /** Resolved provider ID (e.g. "openai", "ollama") */
  providerId: string;
  /** Resolved model ID (e.g. "gpt-4o-mini") */
  modelId: string;
  /** Effective API key after server-side fallback resolution */
  apiKey: string;
  /** Effective base URL after server/client resolution */
  baseUrl?: string;
  /** Optional per-request thinking configuration from the client. */
  thinkingConfig?: ThinkingConfig;
  /** Server-validated Codex request tier. */
  serviceTier?: ModelServiceTier;
}

/**
 * Resolve a language model from explicit parameters.
 *
 * Use this when model config comes from the request body.
 */
export async function resolveModel(params: {
  modelString?: string;
  /**
   * Optional generation stage (a `callLLM` source label, e.g. 'scene-content').
   * When set and a route is configured via `MODEL_ROUTES`, the route wins for
   * this call — even over a client-sent `modelString` (x-model). Unrouted
   * stages fall back to `modelString` then `DEFAULT_MODEL`. See
   * lib/server/model-routes.ts.
   */
  stage?: LlmStage;
  apiKey?: string;
  baseUrl?: string;
  providerType?: string;
  thinkingConfig?: ThinkingConfig;
  serviceTier?: ModelServiceTier;
}): Promise<ResolvedModel> {
  // Resolution order: stage route > x-model > DEFAULT_MODEL.
  // A configured stage route is the operator's deliberate per-stage choice and
  // wins even over a client-sent x-model (otherwise the browser UI, which always
  // sends its saved model, would shadow every route). Unrouted stages fall back
  // to the client x-model, then DEFAULT_MODEL. There is intentionally no hardcoded
  // model fallback — if nothing resolves we fail loud rather than silently pick a
  // vendor default.
  const stageRoute = getStageRoute(params.stage);
  const stageModel = stageRoute?.model;
  const modelString = stageModel || params.modelString || process.env.DEFAULT_MODEL;
  if (!modelString) {
    throw new Error(
      'No model could be resolved. Configure DEFAULT_MODEL (and/or a MODEL_ROUTES entry for this stage), or send a model via x-model.',
    );
  }
  const { providerId, modelId } = parseModelString(modelString);

  if (providerId === 'openai-codex') {
    const availability = await getCodexOAuthAvailability();
    if (!availability.available) {
      throw new Error(`Codex OAuth provider is unavailable (${availability.reason})`);
    }

    const { tokenProvider, modelDiscovery } = getCodexAuthRuntime();
    await tokenProvider.getValidCredentials();
    let serviceTier: ModelServiceTier | undefined;
    if (!stageModel && params.serviceTier === 'priority') {
      try {
        const discoveredModels = await modelDiscovery.getModels();
        const discoveredModel = discoveredModels.find((model) => model.id === modelId);
        if (discoveredModel?.capabilities?.serviceTiers?.includes('priority')) {
          serviceTier = 'priority';
        }
      } catch {
        // Capability discovery is an allowlist check. Failure safely falls back
        // to the standard tier without making the underlying model unavailable.
      }
    }
    const transport = createCodexResponsesTransport({ tokenProvider });
    const { model, modelInfo } = getModel({
      providerId,
      modelId,
      apiKey: '',
      customFetch: transport,
      ...(serviceTier ? { serviceTier } : {}),
    });

    return {
      model,
      modelInfo,
      modelString,
      providerId,
      modelId,
      apiKey: '',
      baseUrl: undefined,
      thinkingConfig: stageModel ? stageRoute?.thinking : params.thinkingConfig,
      ...(serviceTier ? { serviceTier } : {}),
    };
  }

  // When a stage route overrides the client's model, the client-sent connection
  // params (apiKey/baseUrl/providerType) belong to the client's *other* model
  // and must not bleed onto the routed provider — otherwise e.g. a routed
  // Anthropic model would be built with the client's OpenAI providerType/key.
  // A routed model resolves purely from server config, as if no x-model was sent.
  const routed = Boolean(stageModel);
  const clientApiKey = routed ? undefined : params.apiKey;
  const clientProviderType = routed ? undefined : params.providerType;
  const clientBaseUrlParam = routed ? undefined : params.baseUrl;

  // Server-managed providers are admin-owned: the operator's key and base URL
  // are authoritative and any client-sent override is ignored. SSRF validation
  // therefore applies only to unmanaged providers, where the base URL really is
  // client-supplied. (Server-configured URLs are trusted by the operator.)
  const managed = isServerConfiguredProvider('providers', providerId);
  const clientBaseUrl = managed ? undefined : clientBaseUrlParam || undefined;
  if (clientBaseUrl && process.env.NODE_ENV === 'production') {
    const ssrfError = await validateUrlForSSRF(clientBaseUrl);
    if (ssrfError) {
      throw new Error(ssrfError);
    }
  }

  const apiKey = resolveApiKey(providerId, clientApiKey || '');
  const baseUrl = resolveBaseUrl(providerId, clientBaseUrl);
  const proxy = resolveProxy(providerId);
  const { model, modelInfo } = getModel({
    providerId,
    modelId,
    apiKey,
    baseUrl,
    proxy,
    providerType: clientProviderType as 'openai' | 'azure' | 'anthropic' | 'google' | undefined,
  });

  // Thinking arbitration mirrors model routing — the route carries a full
  // ThinkingConfig (mode/effort/level/enabled/budgetTokens/…) which callLLM
  // normalizes against the model's capability:
  //  - routed + thinking set → the route's thinking wins (over client thinking).
  //  - routed + no thinking  → routed model uses its own default; client thinking
  //    is dropped (it belonged to the client's other model).
  //  - unrouted              → honor the client's thinking config.
  const thinkingConfig: ThinkingConfig | undefined = routed
    ? stageRoute?.thinking
    : params.thinkingConfig;

  return {
    model,
    modelInfo,
    modelString,
    providerId,
    modelId,
    apiKey,
    baseUrl,
    thinkingConfig,
  };
}

function getThinkingConfigFromBody(body: unknown): ThinkingConfig | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const record = body as { thinkingConfig?: unknown; thinking?: unknown };
  const config = record.thinkingConfig ?? record.thinking;
  return config && typeof config === 'object' ? (config as ThinkingConfig) : undefined;
}

function normalizeServiceTier(value: unknown): ModelServiceTier | undefined {
  return value === 'priority' ? value : undefined;
}

function getServiceTierFromBody(body: unknown): ModelServiceTier | undefined {
  if (!body || typeof body !== 'object') return undefined;
  return normalizeServiceTier((body as { serviceTier?: unknown }).serviceTier);
}

/**
 * Resolve a language model from standard request headers.
 *
 * Reads: x-model, x-api-key, x-base-url, x-provider-type, x-service-tier
 * Note: requiresApiKey is derived server-side from the provider registry,
 * never from client headers, to prevent auth bypass.
 */
export async function resolveModelFromHeaders(
  req: NextRequest,
  stage?: LlmStage,
  thinkingConfig?: ThinkingConfig,
  serviceTier?: ModelServiceTier,
): Promise<ResolvedModel> {
  return resolveModel({
    modelString: req.headers.get('x-model') || undefined,
    stage,
    apiKey: req.headers.get('x-api-key') || undefined,
    baseUrl: req.headers.get('x-base-url') || undefined,
    providerType: req.headers.get('x-provider-type') || undefined,
    thinkingConfig,
    serviceTier: serviceTier ?? normalizeServiceTier(req.headers.get('x-service-tier')),
  });
}

/**
 * Resolve a language model from standard request headers plus body fields.
 *
 * Reads model credentials from headers and per-request thinking config from
 * the JSON body field `thinkingConfig` (or legacy/eval field `thinking`).
 */
export async function resolveModelFromRequest(
  req: NextRequest,
  body: unknown,
  stage?: LlmStage,
): Promise<ResolvedModel> {
  // Pass the client's body thinking into resolveModel so the single arbiter
  // there decides (a routed stage may override or drop it). See resolveModel.
  return resolveModelFromHeaders(
    req,
    stage,
    getThinkingConfigFromBody(body),
    getServiceTierFromBody(body),
  );
}
