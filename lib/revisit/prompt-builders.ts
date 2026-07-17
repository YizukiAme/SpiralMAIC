import { jsonrepair } from 'jsonrepair';

import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import type { Scene, Stage } from '@/lib/types/stage';
import { projectRevisitAdaptiveContextForPrompt } from '@/lib/revisit/adaptive-context';
import { normalizeBlueprint, simpleSourceHash } from '@/lib/revisit/blueprint';
import { buildSceneDigest } from '@/lib/revisit/source';
import { normalizeJudgeReport } from '@/lib/revisit/judge';
import type { RevisitMessage } from '@/lib/revisit/session';
import type {
  RevisitAdaptiveContext,
  RevisitExamBlueprint,
  RevisitJudgeReport,
  RevisitPageReport,
} from '@/lib/revisit/types';

interface RevisitChallengeProfile {
  challengeNumber: number;
  maxCuesPerPage: number;
  scaffoldingLevel: 'guided' | 'reduced' | 'sparse' | 'minimal';
  focus: string;
}

function getRevisitChallengeProfile(completedChallengeCount: number): RevisitChallengeProfile {
  const completed = Math.max(0, Math.floor(completedChallengeCount));
  const challengeNumber = completed + 1;

  if (challengeNumber === 1) {
    return {
      challengeNumber,
      maxCuesPerPage: 4,
      scaffoldingLevel: 'guided',
      focus: 'Accurate recall and clear organization, with one light transfer opportunity.',
    };
  }
  if (challengeNumber === 2) {
    return {
      challengeNumber,
      maxCuesPerPage: 3,
      scaffoldingLevel: 'reduced',
      focus: 'Less recall support, with more transfer and plausible misconception probes.',
    };
  }
  if (challengeNumber === 3) {
    return {
      challengeNumber,
      maxCuesPerPage: 2,
      scaffoldingLevel: 'sparse',
      focus: 'Independent retrieval, transfer, and error correction on weak concepts.',
    };
  }
  return {
    challengeNumber,
    maxCuesPerPage: 1,
    scaffoldingLevel: 'minimal',
    focus: 'Independent teach-back through novel applications, edge cases, and deeper reasoning.',
  };
}

export { buildSceneDigest } from '@/lib/revisit/source';

export function buildBlueprintPrompt(args: {
  stage: Stage;
  scenes: Scene[];
  targetProbeCount?: number;
  adaptiveContext?: RevisitAdaptiveContext;
}): { system: string; user: string; sourceHash: string; maxCuesPerPage: number } {
  const sceneDigest = buildSceneDigest(args.scenes);
  const completedChallengeCount = args.adaptiveContext?.completedChallengeCount ?? 0;
  const challengeProfile = getRevisitChallengeProfile(completedChallengeCount);
  const adaptivePromptContext = args.adaptiveContext
    ? projectRevisitAdaptiveContextForPrompt(args.adaptiveContext)
    : { completedChallengeCount };
  const sourceHash = simpleSourceHash(
    JSON.stringify({
      stageId: args.stage.id,
      stageUpdatedAt: args.stage.updatedAt,
      sceneDigest,
      completedChallengeCount,
    }),
  );
  const prompt = buildPrompt(PROMPT_IDS.REVISIT_EXAM_BLUEPRINT, {
    languageDirective: args.stage.languageDirective || 'Follow the classroom language.',
    stageTitle: args.stage.name || 'Untitled classroom',
    stageSummary: args.stage.description || '',
    sceneDigest,
    targetProbeCount: args.targetProbeCount ?? 4,
    completedChallengeCount,
    challengeNumber: challengeProfile.challengeNumber,
    scaffoldingLevel: challengeProfile.scaffoldingLevel,
    maxCuesPerPage: challengeProfile.maxCuesPerPage,
    challengeFocus: challengeProfile.focus,
    adaptiveContextJson: JSON.stringify(adaptivePromptContext, null, 2),
  });

  if (!prompt) throw new Error('revisit-exam-blueprint template not found');
  return { ...prompt, sourceHash, maxCuesPerPage: challengeProfile.maxCuesPerPage };
}

export function parseBlueprintResponse(args: {
  text: string;
  stageId: string;
  generatedAt?: number;
  sourceHash: string;
  maxCuesPerPage?: number;
  canonicalConcepts?: Array<{ id: string; label: string }>;
  requiredConceptIds?: string[];
}): RevisitExamBlueprint {
  return normalizeBlueprint(extractJsonObject(args.text), {
    stageId: args.stageId,
    generatedAt: args.generatedAt ?? Date.now(),
    sourceHash: args.sourceHash,
    maxCuesPerPage: args.maxCuesPerPage,
    canonicalConcepts: args.canonicalConcepts,
    requiredConceptIds: args.requiredConceptIds,
  });
}

export function buildJudgePrompt(args: {
  blueprint: RevisitExamBlueprint;
  transcript: unknown;
  pageReports: unknown;
  languageDirective?: string;
}): { system: string; user: string } {
  const prompt = buildPrompt(PROMPT_IDS.REVISIT_JUDGE, {
    languageDirective: args.languageDirective || 'Use the classroom language.',
    blueprintJson: JSON.stringify(args.blueprint, null, 2),
    transcriptJson: JSON.stringify(args.transcript, null, 2),
    pageReportsJson: JSON.stringify(args.pageReports, null, 2),
  });

  if (!prompt) throw new Error('revisit-judge template not found');
  return prompt;
}

export function parseJudgeResponse(args: {
  text: string;
  attemptId: string;
  stageId: string;
  blueprint: RevisitExamBlueprint;
  transcript: RevisitMessage[];
  pageReports: RevisitPageReport[];
  completedAt?: number;
}): RevisitJudgeReport {
  const raw = extractJsonObject(args.text) as Record<string, unknown>;
  return normalizeJudgeReport(
    {
      ...raw,
      attemptId: args.attemptId,
      stageId: args.stageId,
      completedAt: args.completedAt ?? Date.now(),
    },
    {
      expectedConceptIds: args.blueprint.concepts.map((concept) => concept.id),
      transcript: args.transcript,
      pageReports: args.pageReports,
    },
  );
}

export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const direct = tryParseJson(trimmed);
  if (direct !== undefined) return direct;

  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error('No JSON object found in model response');
  }
  const repaired = jsonrepair(match[0]);
  return JSON.parse(repaired);
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(jsonrepair(text));
    } catch {
      return undefined;
    }
  }
}
