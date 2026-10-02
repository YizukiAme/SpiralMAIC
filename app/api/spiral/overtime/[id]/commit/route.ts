import type { NextRequest } from 'next/server';

import type { LessonConcept } from '@/lib/revisit/types';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { withAccessCode } from '@/lib/server/with-access-code';

import { invalidRequest, readBody, record, version, withOvertimeRequest } from '../../http';

export const runtime = 'nodejs';
export const POST = withAccessCode(POSTHandler);
type Context = { params: Promise<{ id: string }> };

async function POSTHandler(req: NextRequest, { params }: Context): Promise<Response> {
  const { id } = await params;
  return withOvertimeRequest(req, async (store, headers) => {
    const body = record(await readBody(req));
    if (
      !version(body?.version) ||
      typeof body?.leaseToken !== 'string' ||
      !record(body.outline) ||
      !record(body.scene) ||
      (body.concepts !== undefined && !Array.isArray(body.concepts))
    ) {
      return invalidRequest('version, outline and scene are required', headers);
    }
    return ownerJson(
      await store.commit({
        id,
        version: body.version as number,
        leaseToken: body.leaseToken as string,
        outline: body.outline as unknown as SceneOutline,
        scene: body.scene as unknown as Scene,
        ...(Array.isArray(body.concepts) ? { concepts: body.concepts as LessonConcept[] } : {}),
      }),
      200,
      headers,
    );
  });
}
