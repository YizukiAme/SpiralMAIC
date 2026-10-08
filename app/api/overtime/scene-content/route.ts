import type { NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { ownsGenerationCourse } from '@/lib/overtime/generation-server';
import { apiSuccess } from '@/lib/server/api-response';
import {
  ownerApiError,
  ownerNotFound,
  withOwnerResponseHeaders,
} from '@/lib/server/agent-runtime/route-response';
import { StepRefusal } from '@/lib/server/generation/steps/context';
import {
  generateSceneContent,
  type SceneContentInput,
} from '@/lib/server/generation/steps/scene-content';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { LLM_STAGES, type LlmStage } from '@/lib/server/model-routes';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { withAccessCode } from '@/lib/server/with-access-code';

const log = createLogger('OvertimeContentAPI');
export const runtime = 'nodejs';

async function POSTHandler(req: NextRequest) {
  return withRequestOwner(req, async ({ ownerId }, headers) => {
    const body = (await req.json().catch(() => null)) as
      | (Omit<SceneContentInput, 'model' | 'pdfImages' | 'imageMapping'> & { stageId: string })
      | null;
    if (!body?.stageId || !body.outline?.id || !body.outline.type) {
      return ownerApiError('INVALID_REQUEST', 400, 'stageId and outline are required', headers);
    }
    if (!(await ownsGenerationCourse(ownerId, body.stageId))) return ownerNotFound(headers);
    try {
      const typedStage = `scene-content:${body.outline.type}`;
      const stage = (LLM_STAGES as readonly string[]).includes(typedStage)
        ? (typedStage as LlmStage)
        : 'scene-content';
      const model = await resolveModelFromRequest(req, body, stage);
      const result = await generateSceneContent(
        {
          outline: body.outline,
          agents: body.agents,
          languageDirective: body.languageDirective,
          requirements: body.requirements,
          targetLanguage: body.targetLanguage,
          model,
        },
        // Appended pages and skeletons carry no source image bundle.
        { log, signal: req.signal, resolveVisionImages: async (images) => [...images] },
      );
      return withOwnerResponseHeaders(apiSuccess({ ...result }), headers);
    } catch (error) {
      log.error('Failed to generate Spiral scene content:', error);
      return ownerApiError(
        'GENERATION_FAILED',
        error instanceof StepRefusal ? 422 : 502,
        'Failed to generate Spiral scene content',
        headers,
        error instanceof Error ? error.message : String(error),
      );
    }
  });
}

export const POST = withAccessCode(POSTHandler);
