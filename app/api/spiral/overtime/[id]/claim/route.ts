import type { NextRequest } from 'next/server';

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
    if (!version(body?.version)) return invalidRequest('version is required', headers);
    return ownerJson(await store.claim({ id, version: body.version as number }), 200, headers);
  });
}
