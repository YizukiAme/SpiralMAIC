import { jsonrepair } from 'jsonrepair';

import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import type { Scene, Stage } from '@/lib/types/stage';
import { normalizeBlueprint, simpleSourceHash } from '@/lib/revisit/blueprint';
import { normalizeJudgeReport } from '@/lib/revisit/judge';
import type { RevisitExamBlueprint, RevisitJudgeReport } from '@/lib/revisit/types';

function extractTextFromSlide(scene: Scene): string {
  if (scene.content.type !== 'slide') return '';
  const elements = scene.content.canvas.elements as Array<{ type?: string; content?: unknown }>;
  return elements
    .filter((element) => element.type === 'text')
    .map((element) => String(element.content || '').trim())
    .filter(Boolean)
    .join(' ');
}

function summarizeScene(scene: Scene): string {
  if (scene.content.type === 'slide') {
    const text = extractTextFromSlide(scene).slice(0, 700);
    return `- Slide ${scene.order + 1}: ${scene.title}\n  ${text}`;
  }
  if (scene.content.type === 'quiz') {
    const questions = scene.content.questions
      .map((question, index) => `${index + 1}. ${question.question}`)
      .join(' | ');
    return `- Quiz ${scene.order + 1}: ${scene.title}\n  ${questions}`;
  }
  return `- ${scene.type} ${scene.order + 1}: ${scene.title}`;
}

export function buildSceneDigest(scenes: Scene[]): string {
  return scenes.map(summarizeScene).join('\n');
}

export function buildBlueprintPrompt(args: {
  stage: Stage;
  scenes: Scene[];
  targetProbeCount?: number;
}): { system: string; user: string; sourceHash: string } {
  const sceneDigest = buildSceneDigest(args.scenes);
  const sourceHash = simpleSourceHash(
    JSON.stringify({
      stageId: args.stage.id,
      stageUpdatedAt: args.stage.updatedAt,
      sceneDigest,
    }),
  );
  const prompt = buildPrompt(PROMPT_IDS.REVISIT_EXAM_BLUEPRINT, {
    languageDirective: args.stage.languageDirective || 'Follow the classroom language.',
    stageTitle: args.stage.name || 'Untitled classroom',
    stageSummary: args.stage.description || '',
    sceneDigest,
    targetProbeCount: args.targetProbeCount ?? 4,
  });

  if (!prompt) throw new Error('revisit-exam-blueprint template not found');
  return { ...prompt, sourceHash };
}

export function parseBlueprintResponse(args: {
  text: string;
  stageId: string;
  generatedAt?: number;
  sourceHash: string;
}): RevisitExamBlueprint {
  return normalizeBlueprint(extractJsonObject(args.text), {
    stageId: args.stageId,
    generatedAt: args.generatedAt ?? Date.now(),
    sourceHash: args.sourceHash,
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
  completedAt?: number;
}): RevisitJudgeReport {
  const raw = extractJsonObject(args.text) as Record<string, unknown>;
  return normalizeJudgeReport({
    ...raw,
    attemptId: args.attemptId,
    stageId: args.stageId,
    completedAt: args.completedAt ?? Date.now(),
  });
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
