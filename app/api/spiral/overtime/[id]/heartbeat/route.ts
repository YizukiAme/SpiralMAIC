import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { withAccessCode } from '@/lib/server/with-access-code';

import { invalidRequest, readBody, record, withOvertimeRequest } from '../../http';

export const runtime = 'nodejs';
export const POST = withAccessCode(POSTHandler);
type Context = { params: Promise<{ id: string }> };

async function POSTHandler(req: NextRequest, { params }: Context): Promise<Response> {
  const { id } = await params;
  return withOvertimeRequest(req, async (store, headers) => {
    const body = record(await readBody(req));
    if (typeof body?.leaseToken !== 'string')
      return invalidRequest('leaseToken is required', headers);
    return ownerJson(
      await store.heartbeat({ id, leaseToken: body.leaseToken as string }),
      200,
      headers,
    );
  });
}
