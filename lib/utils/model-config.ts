import { useSettingsStore } from '@/lib/store/settings';
import { isLLMProviderConfigured } from '@/lib/store/settings-validation';
import {
  getThinkingConfigKey,
  normalizeThinkingConfig,
  supportsConfigurableThinking,
} from '@/lib/ai/thinking-config';
import { findModelById } from '@/lib/ai/model-aliases';
import { getCatalogThinkingCapability } from '@/lib/ai/model-metadata';
import type { ModelServiceTier } from '@/lib/types/provider';

/**
 * Get current model configuration from settings store
 */
export function getCurrentModelConfig() {
  const { providerId, modelId, providersConfig, thinkingConfigs, codexFastMode } =
    useSettingsStore.getState();
  const modelString = `${providerId}:${modelId}`;

  // Get current provider's config
  const providerConfig = providersConfig[providerId];
  const modelInfo = findModelById(providerId, providerConfig?.models, modelId);
  const thinking =
    modelInfo?.capabilities?.thinking ?? getCatalogThinkingCapability(providerId, modelId);
  const thinkingConfig = supportsConfigurableThinking(thinking)
    ? normalizeThinkingConfig(thinking, thinkingConfigs[getThinkingConfigKey(providerId, modelId)])
    : undefined;
  const serviceTier =
    providerId === 'openai-codex' &&
    codexFastMode &&
    modelInfo?.capabilities?.serviceTiers?.includes('priority')
      ? ('priority' as const)
      : undefined;

  return {
    providerId,
    modelId,
    modelString,
    apiKey: providerConfig?.apiKey || '',
    baseUrl: providerConfig?.baseUrl || '',
    providerType: providerConfig?.type,
    requiresApiKey: providerConfig?.requiresApiKey,
    isServerConfigured: providerConfig?.isServerConfigured,
    thinkingConfig,
    serviceTier,
  };
}

export type CurrentModelConfig = ReturnType<typeof getCurrentModelConfig>;

export interface ModelRequestConfig {
  modelString: string;
  apiKey: string;
  baseUrl?: string;
  providerType?: string;
  serviceTier?: ModelServiceTier;
}

/** Build the standard client-to-server model headers for non-chat API calls. */
export function buildModelRequestHeaders(
  config: ModelRequestConfig = getCurrentModelConfig(),
): Record<string, string> {
  return {
    'x-model': config.modelString || '',
    'x-api-key': config.apiKey || '',
    ...(config.baseUrl ? { 'x-base-url': config.baseUrl } : {}),
    ...(config.providerType ? { 'x-provider-type': config.providerType } : {}),
    ...(config.serviceTier ? { 'x-service-tier': config.serviceTier } : {}),
  };
}

/**
 * Serialize the user's per-stage LLM routes (settings store `llmStageRoutes`)
 * for the `x-model-routes` header, or `undefined` when no stage is routed.
 *
 * Each entry carries the routed provider's own connection params so the server
 * can build the model even when it differs from the main model's provider;
 * server-managed providers ignore the client credentials regardless.
 * Precedence server-side: operator MODEL_ROUTES > these routes > x-model.
 */
export function getStageRoutesHeaderValue(): string | undefined {
  const { llmStageRoutes, providersConfig, codexFastMode } = useSettingsStore.getState();
  const entries = Object.entries(llmStageRoutes);
  if (entries.length === 0) return undefined;
  const routes: Record<string, unknown> = {};
  for (const [stage, selection] of entries) {
    const config = providersConfig[selection.providerId];
    // Belt for routes persisted before write-time pruning existed, and for
    // providers disabled/de-credentiailed through paths that bypass the store:
    // a route onto an unusable provider would make the server fail that stage
    // instead of falling back to the main model, so it is dropped here.
    if (!config || config.enabled === false || !isLLMProviderConfigured(config)) continue;
    const modelInfo = findModelById(selection.providerId, config.models, selection.modelId);
    routes[stage] = {
      model: `${selection.providerId}:${selection.modelId}`,
      apiKey: config?.apiKey || undefined,
      baseUrl: config?.baseUrl || undefined,
      providerType: config?.type,
      thinking: selection.thinking ?? undefined,
      serviceTier:
        selection.providerId === 'openai-codex' &&
        codexFastMode &&
        modelInfo?.capabilities?.serviceTiers?.includes('priority')
          ? 'priority'
          : undefined,
    };
  }
  if (Object.keys(routes).length === 0) return undefined;
  return JSON.stringify(routes);
}
