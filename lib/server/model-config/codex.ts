import { getModel } from '@/lib/ai/providers';
import { rebuildCodexModelInfo } from '@/lib/ai/codex-catalog';
import { bindCodexLanguageModelMetadata } from '@/lib/ai/codex-model';
import { getCodexOAuthAvailability } from '@/lib/server/codex/availability';
import { getCodexAuthRuntime } from '@/lib/server/codex/runtime';
import { createCodexResponsesTransport } from '@/lib/server/codex/transport';
import {
  createEphemeralCodexLogicalSession,
  deriveCodexUpstreamSessionId,
  type CodexLogicalSession,
} from '@/lib/server/codex/logical-session';
import type { ResolvedModel } from '@/lib/server/resolve-model';
import type { ModelServiceTier, ThinkingConfig } from '@/lib/types/provider';

/** OAuth tokens and account capabilities always come from the server runtime. */
export async function resolveCodexLanguageModel(params: {
  modelId: string;
  thinkingConfig?: ThinkingConfig;
  serviceTier?: ModelServiceTier;
  logicalSession?: CodexLogicalSession;
  serverManaged: boolean;
}): Promise<ResolvedModel> {
  const availability = await getCodexOAuthAvailability();
  if (!availability.available) {
    throw new Error(`Codex OAuth provider is unavailable (${availability.reason})`);
  }
  const { tokenProvider, modelDiscovery } = getCodexAuthRuntime();
  const capability = await modelDiscovery.getModelCapability(params.modelId);
  const modelInfo = rebuildCodexModelInfo(capability?.modelInfo);
  if (!modelInfo || !capability) {
    throw new Error('Codex model is unavailable for the connected account');
  }
  const serviceTier =
    params.serviceTier === 'priority' && modelInfo.capabilities?.serviceTiers?.includes('priority')
      ? 'priority'
      : undefined;
  const customFetch = createCodexResponsesTransport({
    tokenProvider,
    capabilityLease: capability.capabilityLease,
    sessionId: deriveCodexUpstreamSessionId(
      params.logicalSession ?? createEphemeralCodexLogicalSession(),
    ),
  });
  const built = getModel({
    providerId: 'openai-codex',
    modelId: params.modelId,
    apiKey: '',
    customFetch,
    ...(serviceTier ? { serviceTier } : {}),
  });
  return {
    model: bindCodexLanguageModelMetadata(built.model, modelInfo),
    modelInfo,
    modelString: `openai-codex:${params.modelId}`,
    providerId: 'openai-codex',
    modelId: params.modelId,
    apiKey: '',
    thinkingConfig: params.thinkingConfig,
    serverManaged: params.serverManaged,
    ...(serviceTier ? { serviceTier } : {}),
  };
}
