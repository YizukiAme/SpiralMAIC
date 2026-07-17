import { useSettingsStore } from '@/lib/store/settings';
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
