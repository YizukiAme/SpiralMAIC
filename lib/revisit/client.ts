import type { Scene, Stage } from '@/lib/types/stage';
import type {
  LessonMemorySummary,
  RevisitAdaptiveContext,
  RevisitExamBlueprint,
  RevisitJudgeReport,
  RevisitPageReport,
  StudyArtifactDraft,
  StudyArtifactFor,
  StudyArtifactKind,
  StudyArtifactOptionsByKind,
} from '@/lib/revisit/types';
import {
  countRevisitReports,
  getConceptStates,
  getLatestExamBlueprint,
  getLatestRevisitReport,
  getRevisitReport,
  getLessonProgress,
  getPendingAssessmentConcepts,
  saveEvidenceAndUpdateState,
  saveExamBlueprint,
  saveStudyArtifactNewVersion,
} from '@/lib/revisit/db';
import { computeLessonMemory, computeLessonMemoryFromCompletion } from '@/lib/revisit/memory';
import type { RevisitMessage } from '@/lib/revisit/session';
import { buildModelRequestHeaders, getCurrentModelConfig } from '@/lib/utils/model-config';
import { isAbortError } from '@/lib/generation/generation-retry';
import { FORMAL_REVISIT_SCOPE, type RevisitDataScope } from '@/lib/revisit/scope';

interface ModelConfig {
  modelString: string;
  apiKey: string;
  baseUrl?: string;
  providerType?: string;
  requiresApiKey?: boolean;
  isServerConfigured?: boolean;
  thinkingConfig?: unknown;
  serviceTier?: 'priority';
}

export async function loadLessonMemorySummaries(
  stageIds: string[],
  options: {
    now?: number;
    stableSuccessesRequired: number;
    scope?: RevisitDataScope;
  },
): Promise<Record<string, LessonMemorySummary>> {
  const now = options.now ?? Date.now();
  const entries = await Promise.all(
    stageIds.map(async (stageId) => {
      const states = await getConceptStates(stageId, options.scope);
      if (states.length === 0) {
        const progress = await getLessonProgress(stageId, options.scope);
        if (progress) {
          return [stageId, computeLessonMemoryFromCompletion(progress.completedAt, now)] as const;
        }
      }
      return [
        stageId,
        computeLessonMemory(states, now, {
          stableSuccessesRequired: options.stableSuccessesRequired,
        }),
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export async function loadRevisitAdaptiveContext(
  stageId: string,
  options: {
    now?: number;
    stableSuccessesRequired: number;
    scope?: RevisitDataScope;
  },
): Promise<RevisitAdaptiveContext> {
  const now = options.now ?? Date.now();
  const [conceptStates, latestReport, completedChallengeCount, pendingConcepts] = await Promise.all(
    [
      getConceptStates(stageId, options.scope),
      getLatestRevisitReport(stageId, options.scope),
      countRevisitReports(stageId, options.scope),
      getPendingAssessmentConcepts(stageId, options.scope),
    ],
  );
  const progress =
    conceptStates.length === 0 ? await getLessonProgress(stageId, options.scope) : undefined;
  const memorySummary =
    conceptStates.length > 0
      ? computeLessonMemory(conceptStates, now, {
          stableSuccessesRequired: options.stableSuccessesRequired,
        })
      : progress
        ? computeLessonMemoryFromCompletion(progress.completedAt, now)
        : computeLessonMemory([], now, {
            stableSuccessesRequired: options.stableSuccessesRequired,
          });

  return {
    completedChallengeCount,
    memorySummary,
    conceptStates,
    pendingConcepts,
    latestReport,
  };
}

export async function ensureRevisitBlueprint(args: {
  stage: Stage;
  scenes: Scene[];
  modelConfig?: ModelConfig;
  forceRegenerate?: boolean;
  adaptiveContext?: RevisitAdaptiveContext;
  scope?: RevisitDataScope;
  signal?: AbortSignal;
}): Promise<RevisitExamBlueprint> {
  throwIfAborted(args.signal);
  if (!args.forceRegenerate) {
    const existing = await getLatestExamBlueprint(args.stage.id, args.scope);
    throwIfAborted(args.signal);
    if (existing) return existing;
  }

  const modelConfig = args.modelConfig ?? getCurrentModelConfig();
  const canCallModel =
    !modelConfig.requiresApiKey || modelConfig.isServerConfigured || modelConfig.apiKey;
  if (!canCallModel) {
    throw new Error('Revisit blueprint model is unavailable; challenge cannot start.');
  }

  let blueprint: RevisitExamBlueprint;
  try {
    blueprint = await requestBlueprintFromApi(
      args.stage,
      args.scenes,
      modelConfig,
      args.adaptiveContext,
      args.signal,
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error(
      `Revisit blueprint failed; challenge cannot start. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  throwIfAborted(args.signal);
  if (args.scope) await saveExamBlueprint(blueprint, args.scope);
  else await saveExamBlueprint(blueprint);
  return blueprint;
}

export async function generateRevisitStudyArtifact<K extends StudyArtifactKind>(args: {
  stage: Stage;
  scenes: Scene[];
  kind: K;
  options: StudyArtifactOptionsByKind[K];
  modelConfig?: ModelConfig;
  adaptiveContext?: RevisitAdaptiveContext;
  stableSuccessesRequired?: number;
  scope?: RevisitDataScope;
  now?: number;
  signal?: AbortSignal;
}): Promise<StudyArtifactFor<K>> {
  throwIfAborted(args.signal);
  const progress = await getLessonProgress(args.stage.id, args.scope);
  throwIfAborted(args.signal);
  if (!progress) {
    throw new Error('Complete the original lesson before generating study artifacts.');
  }

  const adaptiveContext =
    args.adaptiveContext ??
    (await loadRevisitAdaptiveContext(args.stage.id, {
      stableSuccessesRequired: args.stableSuccessesRequired ?? 2,
      scope: args.scope,
      now: args.now,
    }));
  throwIfAborted(args.signal);

  const modelConfig = args.modelConfig ?? getCurrentModelConfig();
  const canCallModel =
    !modelConfig.requiresApiKey || modelConfig.isServerConfigured || modelConfig.apiKey;
  if (!canCallModel) {
    throw new Error('Revisit artifact model is unavailable.');
  }

  let draft: Extract<StudyArtifactDraft, { kind: K }>;
  try {
    draft = await requestStudyArtifactFromApi({
      stage: args.stage,
      scenes: args.scenes,
      kind: args.kind,
      options: args.options,
      adaptiveContext,
      modelConfig,
      signal: args.signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error(
      `Revisit artifact failed; nothing was saved. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  throwIfAborted(args.signal);
  if (args.scope || args.now !== undefined) {
    return (await saveStudyArtifactNewVersion(
      draft,
      args.scope ?? FORMAL_REVISIT_SCOPE,
      args.now,
    )) as StudyArtifactFor<K>;
  }
  return (await saveStudyArtifactNewVersion(draft)) as StudyArtifactFor<K>;
}

export async function submitRevisitAttempt(args: {
  attemptId: string;
  stage: Stage;
  blueprint: RevisitExamBlueprint;
  transcript: RevisitMessage[];
  pageReports: RevisitPageReport[];
  stableSuccessesRequired: number;
  scope?: RevisitDataScope;
  completedAt?: number;
  modelConfig?: ModelConfig;
  signal?: AbortSignal;
}): Promise<RevisitJudgeReport> {
  throwIfAborted(args.signal);
  const existingReport = await getRevisitReport(args.attemptId, args.scope);
  throwIfAborted(args.signal);
  if (existingReport) return existingReport;

  const lessonProgress = await getLessonProgress(args.stage.id, args.scope);
  throwIfAborted(args.signal);
  if (!lessonProgress) {
    throw new Error('Complete the original lesson before submitting a Reverse Challenge.');
  }

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
      completedAt: args.completedAt,
      modelConfig,
      signal: args.signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error(
      `Revisit judge failed; attempt was not counted. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  throwIfAborted(args.signal);
  await saveEvidenceAndUpdateState(report, {
    stableSuccessesRequired: args.stableSuccessesRequired,
    conceptLabelsById: Object.fromEntries(
      args.blueprint.concepts.map((concept) => [concept.id, concept.label]),
    ),
    signal: args.signal,
    scope: args.scope,
  });
  return report;
}

async function requestBlueprintFromApi(
  stage: Stage,
  scenes: Scene[],
  modelConfig: ModelConfig,
  adaptiveContext?: RevisitAdaptiveContext,
  signal?: AbortSignal,
): Promise<RevisitExamBlueprint> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...buildModelRequestHeaders(modelConfig),
  };

  const response = await fetch('/api/revisit/blueprint', {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      stage,
      scenes,
      targetProbeCount: 4,
      ...(adaptiveContext ? { adaptiveContext } : {}),
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

async function requestStudyArtifactFromApi<K extends StudyArtifactKind>(args: {
  stage: Stage;
  scenes: Scene[];
  kind: K;
  options: StudyArtifactOptionsByKind[K];
  adaptiveContext: RevisitAdaptiveContext;
  modelConfig: ModelConfig;
  signal?: AbortSignal;
}): Promise<Extract<StudyArtifactDraft, { kind: K }>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...buildModelRequestHeaders(args.modelConfig),
  };

  const response = await fetch('/api/revisit/artifacts', {
    method: 'POST',
    headers,
    signal: args.signal,
    body: JSON.stringify({
      stage: args.stage,
      scenes: args.scenes,
      kind: args.kind,
      options: args.options,
      adaptiveContext: args.adaptiveContext,
      ...(args.modelConfig.thinkingConfig
        ? { thinkingConfig: args.modelConfig.thinkingConfig }
        : {}),
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = (await response.json()) as {
    success?: boolean;
    artifact?: StudyArtifactDraft;
  };
  if (
    !data.success ||
    !data.artifact ||
    data.artifact.stageId !== args.stage.id ||
    data.artifact.kind !== args.kind
  ) {
    throw new Error('Artifact response missing the requested study artifact');
  }
  return data.artifact as Extract<StudyArtifactDraft, { kind: K }>;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

async function requestJudgeFromApi(args: {
  attemptId: string;
  stage: Stage;
  blueprint: RevisitExamBlueprint;
  transcript: RevisitMessage[];
  pageReports: RevisitPageReport[];
  completedAt?: number;
  modelConfig: ModelConfig;
  signal?: AbortSignal;
}): Promise<RevisitJudgeReport> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...buildModelRequestHeaders(args.modelConfig),
  };

  const response = await fetch('/api/revisit/judge', {
    method: 'POST',
    headers,
    signal: args.signal,
    body: JSON.stringify({
      attemptId: args.attemptId,
      stageId: args.stage.id,
      blueprint: args.blueprint,
      transcript: args.transcript,
      pageReports: args.pageReports,
      completedAt: args.completedAt,
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
