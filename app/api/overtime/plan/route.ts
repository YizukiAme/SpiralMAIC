import { NextRequest } from 'next/server';

import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import {
  buildOvertimePlanPrompt,
  parseOvertimePlannerResponse,
  type OvertimeKnownConcept,
} from '@/lib/overtime/planner';
import { parseRequestLearningExtensionParams } from '@/lib/overtime/types';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import type { Scene, Stage } from '@/lib/types/stage';

const log = createLogger('OvertimePlanAPI');

interface OvertimePlanRequest {
  stage: Stage;
  scenes: Scene[];
  request: unknown;
  knownConcepts?: OvertimeKnownConcept[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isKnownConcept(value: unknown): value is OvertimeKnownConcept {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<OvertimeKnownConcept>;
  return (
    typeof item.conceptId === 'string' &&
    Boolean(item.conceptId.trim()) &&
    typeof item.label === 'string' &&
    Boolean(item.label.trim()) &&
    typeof item.summary === 'string' &&
    Array.isArray(item.sourceSceneIds) &&
    item.sourceSceneIds.every((sceneId) => typeof sceneId === 'string')
  );
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as OvertimePlanRequest;
    const request = parseRequestLearningExtensionParams(body.request);
    const knownConcepts = body.knownConcepts ?? [];
    if (
      !body.stage?.id ||
      !body.stage?.name ||
      !Array.isArray(body.scenes) ||
      !body.scenes.every((scene) => scene?.id && scene.stageId === body.stage.id) ||
      !request ||
      request.disposition !== 'append_page' ||
      !Array.isArray(knownConcepts) ||
      !knownConcepts.every(isKnownConcept)
    ) {
      return apiError(
        'INVALID_REQUEST',
        400,
        'stage, scenes, append-page request, and known concepts are required',
      );
    }

    const normalizedBody = { ...body, request, knownConcepts };
    const { model, thinkingConfig } = await resolveModelFromRequest(
      req,
      normalizedBody,
      'overtime-outline',
    );
    const prompt = buildOvertimePlanPrompt(normalizedBody);
    let result: Awaited<ReturnType<typeof callLLM>>;
    try {
      result = await callLLM(
        {
          model,
          system: prompt.system,
          prompt: prompt.user,
          abortSignal: req.signal,
        },
        'overtime-outline',
        undefined,
        thinkingConfig,
      );
    } catch (error) {
      log.error('Overtime planner model request failed:', error);
      return apiError(
        'GENERATION_FAILED',
        502,
        'Overtime planner model request failed',
        errorMessage(error),
      );
    }

    let plan;
    try {
      plan = parseOvertimePlannerResponse({
        text: result.text,
        knownSceneIds: new Set(body.scenes.map((scene) => scene.id)),
        knownConceptIds: new Set(knownConcepts.map((concept) => concept.conceptId)),
      });
    } catch (error) {
      log.error('Failed to parse overtime lesson plan:', error);
      return apiError(
        'PARSE_FAILED',
        422,
        'Failed to parse overtime lesson plan',
        errorMessage(error),
      );
    }

    return apiSuccess({ plan });
  } catch (error) {
    log.error('Failed to plan overtime extension:', error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to plan overtime extension',
      errorMessage(error),
    );
  }
}
