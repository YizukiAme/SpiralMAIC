import { NextRequest } from 'next/server';

import { callLLM } from '@/lib/ai/llm';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import type { RevisitMessage } from '@/lib/revisit/session';
import type { RevisitExamBlueprint, RevisitPageReport } from '@/lib/revisit/types';
import { buildJudgePrompt, parseJudgeResponse } from '@/lib/revisit/prompt-builders';
import { createLogger } from '@/lib/logger';
import { parseExternalCodexLogicalSession } from '@/lib/server/codex/logical-session';

const log = createLogger('RevisitJudgeAPI');

interface JudgeRequest {
  attemptId: string;
  stageId: string;
  blueprint: RevisitExamBlueprint;
  transcript: RevisitMessage[];
  pageReports: RevisitPageReport[];
  languageDirective?: string;
  completedAt?: number;
}

const REVISIT_DIMENSIONS = ['clarity', 'doubtResolution', 'transfer', 'errorCorrection'] as const;

const REVISIT_PROBE_KINDS = ['confusion', 'misconception', 'transfer', 'correction'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function hasUniqueStrings(values: string[]): boolean {
  return new Set(values).size === values.length;
}

function isValidTranscript(value: unknown): value is RevisitMessage[] {
  if (!Array.isArray(value)) return false;
  const seenIds = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) return false;
    if (
      !isNonEmptyString(entry.id) ||
      seenIds.has(entry.id) ||
      (entry.role !== 'teacher' && entry.role !== 'student' && entry.role !== 'assistant') ||
      !isNonEmptyString(entry.text) ||
      typeof entry.createdAt !== 'number' ||
      !Number.isFinite(entry.createdAt) ||
      (entry.agentId !== undefined && typeof entry.agentId !== 'string') ||
      (entry.agentName !== undefined && typeof entry.agentName !== 'string') ||
      (entry.agentAvatar !== undefined && typeof entry.agentAvatar !== 'string')
    ) {
      return false;
    }
    seenIds.add(entry.id);
  }
  return true;
}

function isValidBlueprint(value: unknown): value is RevisitExamBlueprint {
  if (!isRecord(value)) return false;
  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.stageId) ||
    typeof value.generatedAt !== 'number' ||
    !Number.isFinite(value.generatedAt) ||
    !isNonEmptyString(value.language) ||
    !isNonEmptyString(value.sourceHash) ||
    (value.openingBrief !== undefined && typeof value.openingBrief !== 'string') ||
    !Array.isArray(value.concepts) ||
    value.concepts.length === 0
  ) {
    return false;
  }

  const conceptIds = new Set<string>();
  const probes: Array<{ conceptId: string; pageIndex: number | undefined }> = [];
  for (const entry of value.concepts) {
    if (!isRecord(entry) || !isNonEmptyString(entry.id) || conceptIds.has(entry.id)) return false;
    if (!isNonEmptyString(entry.label) || !isNonEmptyString(entry.summary)) return false;
    if (!isRecord(entry.anchors)) return false;
    for (const dimension of REVISIT_DIMENSIONS) {
      const anchors = entry.anchors[dimension];
      if (!isNonEmptyStringArray(anchors) || anchors.length === 0) return false;
    }
    if (!Array.isArray(entry.probes) || entry.probes.length === 0) return false;
    for (const probe of entry.probes) {
      if (
        !isRecord(probe) ||
        !isNonEmptyString(probe.id) ||
        probe.conceptId !== entry.id ||
        !REVISIT_PROBE_KINDS.includes(probe.kind as (typeof REVISIT_PROBE_KINDS)[number]) ||
        !isNonEmptyString(probe.prompt) ||
        (probe.pageIndex !== undefined &&
          (typeof probe.pageIndex !== 'number' ||
            !Number.isInteger(probe.pageIndex) ||
            probe.pageIndex < 0)) ||
        (probe.expectedAnswer !== undefined && typeof probe.expectedAnswer !== 'string') ||
        (probe.expectedCorrection !== undefined && typeof probe.expectedCorrection !== 'string')
      ) {
        return false;
      }
      probes.push({
        conceptId: entry.id,
        pageIndex: probe.pageIndex as number | undefined,
      });
    }
    conceptIds.add(entry.id);
  }

  if (!isRecord(value.skeleton) || !Array.isArray(value.skeleton.pages)) return false;
  if (value.skeleton.pages.length === 0) return false;
  const pageIds = new Set<string>();
  const firstPageIndexByConcept = new Map<string, number>();
  for (const [pageIndex, entry] of value.skeleton.pages.entries()) {
    if (!isRecord(entry) || !isNonEmptyString(entry.id) || pageIds.has(entry.id)) return false;
    if (!isNonEmptyString(entry.title) || !isNonEmptyString(entry.summary)) return false;
    if (
      !isNonEmptyStringArray(entry.conceptIds) ||
      entry.conceptIds.length === 0 ||
      !hasUniqueStrings(entry.conceptIds) ||
      entry.conceptIds.some((conceptId) => !conceptIds.has(conceptId)) ||
      !Array.isArray(entry.cues) ||
      !entry.cues.every((cue) => typeof cue === 'string')
    ) {
      return false;
    }
    for (const conceptId of entry.conceptIds) {
      if (!firstPageIndexByConcept.has(conceptId)) {
        firstPageIndexByConcept.set(conceptId, pageIndex);
      }
    }
    pageIds.add(entry.id);
  }

  return probes.every((probe) => probe.pageIndex === firstPageIndexByConcept.get(probe.conceptId));
}

function isValidPageReports(
  value: unknown,
  blueprint: RevisitExamBlueprint,
): value is RevisitPageReport[] {
  if (!Array.isArray(value)) return false;
  const seenPageIds = new Set<string>();
  const knownConceptIds = new Set(blueprint.concepts.map((concept) => concept.id));
  const pagesById = new Map(
    blueprint.skeleton.pages.map((page, pageIndex) => [page.id, { page, pageIndex }] as const),
  );

  for (const entry of value) {
    if (!isRecord(entry) || !isNonEmptyString(entry.pageId) || seenPageIds.has(entry.pageId)) {
      return false;
    }
    const blueprintPage = pagesById.get(entry.pageId);
    if (
      !blueprintPage ||
      typeof entry.pageIndex !== 'number' ||
      !Number.isInteger(entry.pageIndex) ||
      entry.pageIndex !== blueprintPage.pageIndex ||
      typeof entry.probeCount !== 'number' ||
      !Number.isInteger(entry.probeCount) ||
      entry.probeCount < 0 ||
      typeof entry.passed !== 'boolean' ||
      !isNonEmptyStringArray(entry.conceptIds) ||
      entry.conceptIds.length === 0 ||
      !hasUniqueStrings(entry.conceptIds) ||
      entry.conceptIds.some(
        (conceptId) =>
          !knownConceptIds.has(conceptId) || !blueprintPage.page.conceptIds.includes(conceptId),
      ) ||
      (entry.notes !== undefined && typeof entry.notes !== 'string')
    ) {
      return false;
    }
    seenPageIds.add(entry.pageId);
  }
  return true;
}

function isValidJudgeRequest(value: unknown): value is JudgeRequest {
  if (!isRecord(value)) return false;
  if (
    !isNonEmptyString(value.attemptId) ||
    !isNonEmptyString(value.stageId) ||
    (value.completedAt !== undefined &&
      (typeof value.completedAt !== 'number' || !Number.isFinite(value.completedAt))) ||
    (value.languageDirective !== undefined && typeof value.languageDirective !== 'string') ||
    !isValidBlueprint(value.blueprint) ||
    value.blueprint.stageId !== value.stageId ||
    !isValidTranscript(value.transcript) ||
    !isValidPageReports(value.pageReports, value.blueprint)
  ) {
    return false;
  }
  return true;
}

export async function POST(req: NextRequest) {
  try {
    const rawBody = (await req.json()) as unknown;
    if (!isValidJudgeRequest(rawBody)) {
      return apiError(
        'INVALID_REQUEST',
        400,
        'attemptId, stageId, blueprint, transcript, and pageReports are required and must be valid',
      );
    }
    const body = rawBody;

    const { model, thinkingConfig } = await resolveModelFromRequest(
      req,
      body,
      'revisit-judge',
      parseExternalCodexLogicalSession({ kind: 'revisit-attempt', id: body.attemptId }),
    );
    const prompt = buildJudgePrompt({
      blueprint: body.blueprint,
      transcript: body.transcript,
      pageReports: body.pageReports,
      languageDirective: body.languageDirective,
    });
    const result = await callLLM(
      {
        model,
        system: prompt.system,
        prompt: prompt.user,
        abortSignal: req.signal,
      },
      'revisit-judge',
      undefined,
      thinkingConfig,
    );
    const report = parseJudgeResponse({
      text: result.text,
      attemptId: body.attemptId,
      stageId: body.stageId,
      blueprint: body.blueprint,
      transcript: body.transcript,
      pageReports: body.pageReports,
      completedAt: body.completedAt,
    });

    return apiSuccess({ report });
  } catch (error) {
    log.error('Failed to judge revisit challenge:', error);
    return apiError('INTERNAL_ERROR', 500, 'Failed to judge revisit challenge');
  }
}
