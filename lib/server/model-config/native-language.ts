import type { ResolvedModel } from '@/lib/server/resolve-model';
import type { ModelServiceTier, ThinkingConfig } from '@/lib/types/provider';
import type { ModelLogicalSession } from './request-context';
import { resolveCodexLanguageModel } from './codex';

/** Composition root for language providers authenticated by a server account. */
export async function resolveNativeLanguageModel(params: {
  providerId: string;
  modelId: string;
  thinkingConfig?: ThinkingConfig;
  serviceTier?: ModelServiceTier;
  logicalSession?: ModelLogicalSession;
  serverManaged: boolean;
}): Promise<ResolvedModel | null> {
  if (params.providerId !== 'openai-codex') return null;
  return resolveCodexLanguageModel(params);
}
