import type { Scene, Stage } from '@/lib/types/stage';
import type { LessonMemorySummary, RevisitExamBlueprint } from '@/lib/revisit/types';
import { createFallbackBlueprint } from '@/lib/revisit/blueprint';
import {
  getConceptStates,
  getLatestExamBlueprint,
  saveBlueprintAndInitializeState,
} from '@/lib/revisit/db';
import { computeLessonMemory } from '@/lib/revisit/memory';
import { getCurrentModelConfig } from '@/lib/utils/model-config';

const DEMO_ACCELERATED_CLOCK_MULTIPLIER = 1440;

interface ModelConfig {
  modelString: string;
  apiKey: string;
  baseUrl?: string;
  providerType?: string;
  requiresApiKey?: boolean;
  isServerConfigured?: boolean;
  thinkingConfig?: unknown;
}

export function getEffectiveForgettingSpeedMultiplier(settings: {
  forgettingSpeedMultiplier: number;
  demoAcceleratedClockEnabled: boolean;
}): number {
  return settings.demoAcceleratedClockEnabled
    ? DEMO_ACCELERATED_CLOCK_MULTIPLIER
    : settings.forgettingSpeedMultiplier;
}

export async function loadLessonMemorySummaries(
  stageIds: string[],
  options: {
    now?: number;
    forgettingSpeedMultiplier: number;
    stableSuccessesRequired: number;
  },
): Promise<Record<string, LessonMemorySummary>> {
  const now = options.now ?? Date.now();
  const entries = await Promise.all(
    stageIds.map(async (stageId) => {
      const states = await getConceptStates(stageId);
      return [
        stageId,
        computeLessonMemory(states, now, {
          forgettingSpeedMultiplier: options.forgettingSpeedMultiplier,
          stableSuccessesRequired: options.stableSuccessesRequired,
        }),
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export async function ensureRevisitBlueprint(args: {
  stage: Stage;
  scenes: Scene[];
  modelConfig?: ModelConfig;
  forceRegenerate?: boolean;
  learnedAt?: number;
}): Promise<RevisitExamBlueprint> {
  if (!args.forceRegenerate) {
    const existing = await getLatestExamBlueprint(args.stage.id);
    if (existing) {
      await saveBlueprintAndInitializeState(existing, args.learnedAt ?? Date.now());
      return existing;
    }
  }

  const modelConfig = args.modelConfig ?? getCurrentModelConfig();
  const canCallModel =
    !modelConfig.requiresApiKey || modelConfig.isServerConfigured || modelConfig.apiKey;
  const blueprint = canCallModel
    ? await requestBlueprintFromApi(args.stage, args.scenes, modelConfig).catch(() =>
        createFallbackBlueprint(args.stage, args.scenes, args.learnedAt ?? Date.now()),
      )
    : createFallbackBlueprint(args.stage, args.scenes, args.learnedAt ?? Date.now());

  await saveBlueprintAndInitializeState(blueprint, args.learnedAt ?? Date.now());
  return blueprint;
}

export async function markPlaybackCompleteForRevisit(args: {
  stage: Stage;
  scenes: Scene[];
  learnedAt?: number;
}): Promise<void> {
  await ensureRevisitBlueprint({
    stage: args.stage,
    scenes: args.scenes,
    learnedAt: args.learnedAt ?? Date.now(),
  });
}

async function requestBlueprintFromApi(
  stage: Stage,
  scenes: Scene[],
  modelConfig: ModelConfig,
): Promise<RevisitExamBlueprint> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-model': modelConfig.modelString,
    'x-api-key': modelConfig.apiKey,
  };
  if (modelConfig.baseUrl) headers['x-base-url'] = modelConfig.baseUrl;
  if (modelConfig.providerType) headers['x-provider-type'] = modelConfig.providerType;

  const response = await fetch('/api/revisit/blueprint', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      stage,
      scenes,
      targetProbeCount: 4,
      ...(modelConfig.thinkingConfig ? { thinkingConfig: modelConfig.thinkingConfig } : {}),
    }),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = (await response.json()) as {
    success?: boolean;
    blueprint?: RevisitExamBlueprint;
  };
  if (!data.success || !data.blueprint) {
    throw new Error('Blueprint response missing blueprint');
  }
  return data.blueprint;
}
