import type { NextRequest } from 'next/server';

import { ownerJson, ownerNotFound } from '@/lib/server/agent-runtime/route-response';
import { withAccessCode } from '@/lib/server/with-access-code';

import { invalidRequest, readBody, record, version, withOvertimeRequest } from '../http';

export const runtime = 'nodejs';
export const GET = withAccessCode(GETHandler);
export const PATCH = withAccessCode(PATCHHandler);
type Context = { params: Promise<{ id: string }> };

async function GETHandler(req: NextRequest, { params }: Context): Promise<Response> {
  const { id } = await params;
  return withOvertimeRequest(req, async (store, headers) => {
    const task = await store.get(id);
    return task ? ownerJson(task, 200, headers) : ownerNotFound(headers);
  });
}

async function PATCHHandler(req: NextRequest, { params }: Context): Promise<Response> {
  const { id } = await params;
  return withOvertimeRequest(req, async (store, headers) => {
    const body = record(await readBody(req));
    const patch = record(body?.patch);
    if (
      !version(body?.version) ||
      typeof body?.leaseToken !== 'string' ||
      !patch ||
      !['outline', 'content', 'actions', 'tts', 'commit'].includes(String(patch.phase)) ||
      !['planning', 'generating', 'failed', 'interrupted'].includes(String(patch.status)) ||
      typeof patch.updatedAt !== 'number'
    ) {
      return invalidRequest('version and a valid checkpoint patch are required', headers);
    }
    return ownerJson(
      await store.checkpoint({
        id,
        version: body.version as number,
        leaseToken: body.leaseToken as string,
        patch: patch as unknown as Parameters<typeof store.checkpoint>[0]['patch'],
      }),
      200,
      headers,
    );
  });
}
