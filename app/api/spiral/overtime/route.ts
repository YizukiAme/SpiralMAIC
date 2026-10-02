import type { NextRequest } from 'next/server';

import { parseRequestLearningExtensionParams } from '@/lib/overtime/types';
import { ownerJson, ownerNotFound } from '@/lib/server/agent-runtime/route-response';
import { withAccessCode } from '@/lib/server/with-access-code';

import { invalidRequest, readBody, record, withOvertimeRequest } from './http';

export const runtime = 'nodejs';
export const GET = withAccessCode(GETHandler);
export const POST = withAccessCode(POSTHandler);

async function GETHandler(req: NextRequest): Promise<Response> {
  return withOvertimeRequest(req, async (store, headers) => {
    const stageId = new URL(req.url).searchParams.get('stageId');
    if (!stageId) return invalidRequest('stageId is required', headers);
    const extensions = await store.list(stageId);
    return extensions ? ownerJson({ extensions }, 200, headers) : ownerNotFound(headers);
  });
}

async function POSTHandler(req: NextRequest): Promise<Response> {
  return withOvertimeRequest(req, async (store, headers) => {
    const body = record(await readBody(req));
    const decision = parseRequestLearningExtensionParams(body?.decision);
    if (
      typeof body?.id !== 'string' ||
      typeof body.stageId !== 'string' ||
      typeof body.userPrompt !== 'string' ||
      !decision
    ) {
      return invalidRequest('id, stageId, userPrompt and decision are required', headers);
    }
    return ownerJson(
      await store.createOrGet({
        id: body.id as string,
        stageId: body.stageId as string,
        userPrompt: body.userPrompt as string,
        decision,
      }),
      200,
      headers,
    );
  });
}
