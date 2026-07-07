import { NextRequest } from 'next/server';

import { callLLM } from '@/lib/ai/llm';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import type { Scene, Stage } from '@/lib/types/stage';
import { buildBlueprintPrompt, parseBlueprintResponse } from '@/lib/revisit/prompt-builders';
import { createLogger } from '@/lib/logger';

const log = createLogger('RevisitBlueprintAPI');

interface BlueprintRequest {
  stage: Stage;
  scenes: Scene[];
  targetProbeCount?: number;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as BlueprintRequest;
    if (!body.stage?.id || !Array.isArray(body.scenes)) {
      return apiError('INVALID_REQUEST', 400, 'stage and scenes are required');
    }

    const { model, thinkingConfig } = await resolveModelFromRequest(req, body, 'revisit-blueprint');
    const prompt = buildBlueprintPrompt({
      stage: body.stage,
      scenes: body.scenes,
      targetProbeCount: body.targetProbeCount,
    });
    const result = await callLLM(
      {
        model,
        system: prompt.system,
        prompt: prompt.user,
      },
      'revisit-blueprint',
      undefined,
      thinkingConfig,
    );
    const blueprint = parseBlueprintResponse({
      text: result.text,
      stageId: body.stage.id,
      sourceHash: prompt.sourceHash,
    });

    return apiSuccess({ blueprint });
  } catch (error) {
    log.error('Failed to create revisit blueprint:', error);
    return apiError('INTERNAL_ERROR', 500, 'Failed to create revisit blueprint');
  }
}
