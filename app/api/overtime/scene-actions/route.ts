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
  generateSceneActions,
  type SceneActionsInput,
} from '@/lib/server/generation/steps/scene-actions';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { withAccessCode } from '@/lib/server/with-access-code';

const log = createLogger('OvertimeActionsAPI');
export const runtime = 'nodejs';

async function POSTHandler(req: NextRequest) {
  return withRequestOwner(req, async ({ ownerId }, headers) => {
    const body = (await req.json().catch(() => null)) as Omit<SceneActionsInput, 'model'> | null;
    if (!body?.stageId || !body.outline?.id || !Array.isArray(body.allOutlines) || !body.content) {
      return ownerApiError(
        'INVALID_REQUEST',
        400,
        'stageId, outline, content and allOutlines are required',
        headers,
      );
    }
    if (!(await ownsGenerationCourse(ownerId, body.stageId))) return ownerNotFound(headers);
    try {
      const model = await resolveModelFromRequest(req, body, 'scene-actions');
      const result = await generateSceneActions({ ...body, model }, { log, signal: req.signal });
      return withOwnerResponseHeaders(apiSuccess({ ...result }), headers);
    } catch (error) {
      log.error('Failed to generate Spiral scene actions:', error);
      return ownerApiError(
        'GENERATION_FAILED',
        error instanceof StepRefusal ? 422 : 502,
        'Failed to generate Spiral scene actions',
        headers,
        error instanceof Error ? error.message : String(error),
      );
    }
  });
}

export const POST = withAccessCode(POSTHandler);
