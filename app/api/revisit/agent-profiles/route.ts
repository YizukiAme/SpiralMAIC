import type { NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { ownsGenerationCourse } from '@/lib/overtime/generation-server';
import { apiSuccess } from '@/lib/server/api-response';
import {
  ownerApiError,
  ownerNotFound,
  withOwnerResponseHeaders,
} from '@/lib/server/agent-runtime/route-response';
import {
  generateAgentProfiles,
  type AgentProfilesInput,
} from '@/lib/server/generation/steps/agent-profiles';
import { StepRefusal } from '@/lib/server/generation/steps/context';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { withAccessCode } from '@/lib/server/with-access-code';

const log = createLogger('RevisitAgentsAPI');
export const runtime = 'nodejs';
export const maxDuration = 120;

async function POSTHandler(req: NextRequest) {
  return withRequestOwner(req, async ({ ownerId }, headers) => {
    const body = (await req.json().catch(() => null)) as
      | (Omit<AgentProfilesInput, 'model'> & { stageId: string })
      | null;
    if (
      !body?.stageId ||
      body.mode !== 'spiral' ||
      !body.stageInfo?.name ||
      !body.languageDirective ||
      !Array.isArray(body.availableAvatars) ||
      !body.availableAvatars.length
    ) {
      return ownerApiError(
        'INVALID_REQUEST',
        400,
        'A course and Spiral agent profile request are required',
        headers,
      );
    }
    if (!(await ownsGenerationCourse(ownerId, body.stageId))) return ownerNotFound(headers);
    try {
      const model = await resolveModelFromRequest(req, body, 'agent-profiles');
      const agents = await generateAgentProfiles({ ...body, model }, { log, signal: req.signal });
      return withOwnerResponseHeaders(apiSuccess({ agents }), headers);
    } catch (error) {
      log.error('Failed to generate Spiral agents:', error);
      return ownerApiError(
        'GENERATION_FAILED',
        error instanceof StepRefusal ? 422 : 502,
        'Failed to generate Spiral agents',
        headers,
        error instanceof Error ? error.message : String(error),
      );
    }
  });
}

export const POST = withAccessCode(POSTHandler);
