import type { Scene, Stage } from '@/lib/types/stage';
import type {
  LessonMemorySummary,
  RevisitExamBlueprint,
  RevisitJudgeReport,
  RevisitPageReport,
} from '@/lib/revisit/types';
import { createFallbackBlueprint } from '@/lib/revisit/blueprint';
import {
  getConceptStates,
  getLatestExamBlueprint,
  saveEvidenceAndUpdateState,
  saveBlueprintAndInitializeState,
} from '@/lib/revisit/db';
import { normalizeJudgeReport } from '@/lib/revisit/judge';
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

  const report = canCallModel
    ? await requestJudgeFromApi({
        attemptId: args.attemptId,
        stage: args.stage,
        blueprint: args.blueprint,
        transcript: args.transcript,
        pageReports: args.pageReports,
        modelConfig,
      }).catch(() =>
        createLocalJudgeReport({
          attemptId: args.attemptId,
          stageId: args.stage.id,
          blueprint: args.blueprint,
          pageReports: args.pageReports,
        }),
      )
    : createLocalJudgeReport({
        attemptId: args.attemptId,
        stageId: args.stage.id,
        blueprint: args.blueprint,
        pageReports: args.pageReports,
      });

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

function createLocalJudgeReport(args: {
  attemptId: string;
  stageId: string;
  blueprint: RevisitExamBlueprint;
  pageReports: RevisitPageReport[];
}): RevisitJudgeReport {
  const completedAt = Date.now();
  const passedPageIds = new Set(
    args.pageReports.filter((report) => report.passed).map((report) => report.pageId),
  );
  const passedRatio =
    args.pageReports.length > 0 ? passedPageIds.size / args.pageReports.length : 0.5;
  const score = Math.max(0.35, Math.min(0.9, 0.45 + passedRatio * 0.4));

  return normalizeJudgeReport({
    attemptId: args.attemptId,
    stageId: args.stageId,
    completedAt,
    summary: 'Local fallback report generated from page gate results.',
    dimensions: {
      clarity: score,
      doubtResolution: score,
      transfer: Math.max(0.35, score - 0.05),
      errorCorrection: Math.max(0.35, score - 0.08),
    },
    conceptScores: args.blueprint.concepts.map((concept) => {
      const relatedPages = args.blueprint.skeleton.pages.filter((page) =>
        page.conceptIds.includes(concept.id),
      );
      const relatedPassed = relatedPages.some((page) => passedPageIds.has(page.id));
      const conceptScore = relatedPassed ? score : Math.max(0.25, score - 0.2);
      return {
        conceptId: concept.id,
        scores: {
          clarity: conceptScore,
          doubtResolution: conceptScore,
          transfer: Math.max(0.25, conceptScore - 0.05),
          errorCorrection: Math.max(0.25, conceptScore - 0.08),
        },
        notes: concept.summary,
      };
    }),
    errors: [],
    pageReports: args.pageReports,
  });
}
