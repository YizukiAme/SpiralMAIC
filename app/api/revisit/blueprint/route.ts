import { NextRequest } from 'next/server';

import { callLLM } from '@/lib/ai/llm';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import type { Scene, Stage } from '@/lib/types/stage';
import type { RevisitAdaptiveContext } from '@/lib/revisit/types';
import { buildBlueprintPrompt, parseBlueprintResponse } from '@/lib/revisit/prompt-builders';
import { createLogger } from '@/lib/logger';
import { parseExternalCodexLogicalSession } from '@/lib/server/codex/logical-session';

const log = createLogger('RevisitBlueprintAPI');

interface BlueprintRequest {
  attemptId?: string;
  stage: Stage;
  scenes: Scene[];
  targetProbeCount?: number;
  adaptiveContext?: RevisitAdaptiveContext;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as BlueprintRequest;
    if (!body.stage?.id || !Array.isArray(body.scenes)) {
      return apiError('INVALID_REQUEST', 400, 'stage and scenes are required');
    }

    const { model, thinkingConfig } = await resolveModelFromRequest(
      req,
      body,
      'revisit-blueprint',
      parseExternalCodexLogicalSession({
        kind: 'revisit-attempt',
        id: body.attemptId,
      }),
    );
    const prompt = buildBlueprintPrompt({
      stage: body.stage,
      scenes: body.scenes,
      targetProbeCount: body.targetProbeCount,
      adaptiveContext: body.adaptiveContext,
    });
    const result = await callLLM(
      {
        model,
        system: prompt.system,
        prompt: prompt.user,
        abortSignal: req.signal,
      },
      'revisit-blueprint',
      undefined,
      thinkingConfig,
    );
    const knownConcepts = [
      ...(body.adaptiveContext?.conceptStates ?? []).map(({ conceptId, label }) => ({
        id: conceptId,
        label,
      })),
      ...(body.adaptiveContext?.pendingConcepts ?? []).map(({ conceptId, label }) => ({
        id: conceptId,
        label,
      })),
    ];
    const canonicalConcepts = Array.from(
      new Map(knownConcepts.map((concept) => [concept.id, concept])).values(),
    );
    const blueprint = parseBlueprintResponse({
      text: result.text,
      stageId: body.stage.id,
      sourceHash: prompt.sourceHash,
      maxCuesPerPage: prompt.maxCuesPerPage,
      canonicalConcepts,
      requiredConceptIds: body.adaptiveContext?.pendingConcepts?.map(({ conceptId }) => conceptId),
    });

    return apiSuccess({ blueprint });
  } catch (error) {
    log.error('Failed to create revisit blueprint:', error);
    return apiError('INTERNAL_ERROR', 500, 'Failed to create revisit blueprint');
  }
}
