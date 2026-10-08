import { modelSettingsClient } from '@/lib/model-settings/client';
import { useSettingsStore } from '@/lib/store/settings';
import type { ModelServiceTier, ThinkingConfig } from '@/lib/types/provider';

/**
 * Compatibility for Spiral's Revisit clients: expose the selected model's
 * metadata from the server view. Credentials stay on the server.
 */
export function getCurrentModelConfig() {
  const view = modelSettingsClient.getState().view;
  const slot = view?.slots.find((entry) => entry.slot === 'llm');
  const target = slot?.effective.status === 'assigned' ? slot.effective : undefined;
  const providerId = target?.registryId ?? '';
  const modelId = target?.modelId ?? '';
  const assignment = target
    ? view?.slots.find((entry) => entry.slot === target.resolvedAt)?.assignment
    : undefined;
  const thinkingConfig =
    assignment && typeof assignment === 'object'
      ? (assignment.thinking as ThinkingConfig | undefined)
      : undefined;
  return {
    providerId,
    modelId,
    modelString: modelId ? `${providerId}:${modelId}` : '',
    apiKey: '',
    baseUrl: '',
    providerType: undefined,
    requiresApiKey: false,
    isServerConfigured: !!target,
    thinkingConfig,
    serviceTier: useSettingsStore.getState().codexFastMode ? ('priority' as const) : undefined,
  };
}

export type CurrentModelConfig = ReturnType<typeof getCurrentModelConfig>;

export interface ModelRequestConfig {
  modelString?: string;
  apiKey?: string;
  baseUrl?: string;
  providerType?: string;
  serviceTier?: ModelServiceTier;
}

/** Requests carry preferences; the request owner's server slots select the model. */
export function buildModelRequestHeaders(
  config: ModelRequestConfig = getCurrentModelConfig(),
): Record<string, string> {
  return config.serviceTier ? { 'x-service-tier': config.serviceTier } : {};
}

/** Stage choices moved to workspace slots; no browser credential header remains. */
export function getStageRoutesHeaderValue(): undefined {
  return undefined;
}
