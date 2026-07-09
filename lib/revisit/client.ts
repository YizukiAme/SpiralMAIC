import type { Scene, Stage } from '@/lib/types/stage';
import type {
  LessonMemorySummary,
  RevisitExamBlueprint,
  RevisitJudgeReport,
  RevisitPageReport,
  RevisitSkeletonDeck,
} from '@/lib/revisit/types';
import { generateRevisitSkeletonScenes } from '@/lib/revisit/slides';
import {
  getConceptStates,
  getLatestExamBlueprint,
  getLatestSkeletonDeck,
  saveEvidenceAndUpdateState,
  saveBlueprintAndInitializeState,
  saveSkeletonDeck,
} from '@/lib/revisit/db';
import { computeLessonMemory } from '@/lib/revisit/memory';
import type { RevisitMessage } from '@/lib/revisit/session';
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
  if (!canCallModel) {
    throw new Error('Revisit blueprint model is unavailable; challenge cannot start.');
  }

  let blueprint: RevisitExamBlueprint;
  try {
    blueprint = await requestBlueprintFromApi(args.stage, args.scenes, modelConfig);
  } catch (error) {
    throw new Error(
      `Revisit blueprint failed; challenge cannot start. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  await saveBlueprintAndInitializeState(blueprint, args.learnedAt ?? Date.now());
  return blueprint;
}

export async function ensureRevisitSkeletonDeck(args: {
  stage: Stage;
  blueprint: RevisitExamBlueprint;
  sourceScenes: Scene[];
  modelConfig?: ModelConfig;
  forceRegenerate?: boolean;
  onScene?: (scene: Scene, index: number) => void;
}): Promise<RevisitSkeletonDeck> {
  if (!args.forceRegenerate) {
    const existing = await getLatestSkeletonDeck(args.stage.id, args.blueprint.id);
    if (existing?.scenes.length) return existing;
  }

  const modelConfig = args.modelConfig ?? getCurrentModelConfig();
  const canCallModel =
    !modelConfig.requiresApiKey || modelConfig.isServerConfigured || modelConfig.apiKey;
  if (!canCallModel) {
    throw new Error('Revisit skeleton model is unavailable; challenge cannot start.');
  }

  let scenes: Scene[];
  try {
    scenes = await generateRevisitSkeletonScenes({
      stage: args.stage,
      blueprint: args.blueprint,
      sourceScenes: args.sourceScenes,
      modelConfig,
      onScene: args.onScene,
    });
  } catch (error) {
    throw new Error(
      `Revisit skeleton failed; challenge cannot start. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const deck: RevisitSkeletonDeck = {
    id: `${args.stage.id}:${args.blueprint.id}:${Date.now()}`,
    stageId: args.stage.id,
    blueprintId: args.blueprint.id,
    sourceHash: args.blueprint.sourceHash,
    generatedAt: Date.now(),
    scenes,
  };
  await saveSkeletonDeck(deck);
  return deck;
}

export async function markPlaybackCompleteForRevisit(args: {
  stage: Stage;
  scenes: Scene[];
  learnedAt?: number;
}): Promise<void> {
  const blueprint = await ensureRevisitBlueprint({
    stage: args.stage,
    scenes: args.scenes,
    learnedAt: args.learnedAt ?? Date.now(),
  });
  await ensureRevisitSkeletonDeck({
    stage: args.stage,
    blueprint,
    sourceScenes: args.scenes,
  });
}

export async function submitRevisitAttempt(args: {
  attemptId: string;
  stage: Stage;
  blueprint: RevisitExamBlueprint;
  transcript: RevisitMessage[];
  pageReports: RevisitPageReport[];
  stableSuccessesRequired: number;
  forgettingSpeedMultiplier: number;
  modelConfig?: ModelConfig;
}): Promise<RevisitJudgeReport> {
  const modelConfig = args.modelConfig ?? getCurrentModelConfig();
  const canCallModel =
    !modelConfig.requiresApiKey || modelConfig.isServerConfigured || modelConfig.apiKey;

  if (!canCallModel) {
    throw new Error('Revisit judge model is unavailable; attempt was not counted.');
  }

  let report: RevisitJudgeReport;
  try {
    report = await requestJudgeFromApi({
      attemptId: args.attemptId,
      stage: args.stage,
      blueprint: args.blueprint,
      transcript: args.transcript,
      pageReports: args.pageReports,
      modelConfig,
    });
  } catch (error) {
    throw new Error(
      `Revisit judge failed; attempt was not counted. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  await saveEvidenceAndUpdateState(report, {
    stableSuccessesRequired: args.stableSuccessesRequired,
    forgettingSpeedMultiplier: args.forgettingSpeedMultiplier,
  });
  return report;
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

async function requestJudgeFromApi(args: {
  attemptId: string;
  stage: Stage;
  blueprint: RevisitExamBlueprint;
  transcript: RevisitMessage[];
  pageReports: RevisitPageReport[];
  modelConfig: ModelConfig;
}): Promise<RevisitJudgeReport> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-model': args.modelConfig.modelString,
    'x-api-key': args.modelConfig.apiKey,
  };
  if (args.modelConfig.baseUrl) headers['x-base-url'] = args.modelConfig.baseUrl;
  if (args.modelConfig.providerType) headers['x-provider-type'] = args.modelConfig.providerType;

  const response = await fetch('/api/revisit/judge', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      attemptId: args.attemptId,
      stageId: args.stage.id,
      blueprint: args.blueprint,
      transcript: args.transcript,
      pageReports: args.pageReports,
      languageDirective: args.stage.languageDirective,
      ...(args.modelConfig.thinkingConfig
        ? { thinkingConfig: args.modelConfig.thinkingConfig }
        : {}),
    }),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = (await response.json()) as {
    success?: boolean;
    report?: RevisitJudgeReport;
  };
  if (!data.success || !data.report) {
    throw new Error('Judge response missing report');
  }
  return data.report;
}
