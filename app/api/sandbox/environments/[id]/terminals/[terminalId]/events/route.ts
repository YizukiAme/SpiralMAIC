import { withAccessCode } from '@/lib/server/with-access-code';

import { sandboxResponse } from '@/lib/server/sandbox/http';

export const runtime = 'nodejs';
export const GET = withAccessCode(GETHandler);
type Context = { params: Promise<{ id: string; terminalId: string }> };

function GETHandler(request: Request, context: Context) {
  return sandboxResponse(request, async (service) => {
    const { id, terminalId } = await context.params;
    return new Response(await service.terminalStream(id, terminalId, request.signal), {
      headers: { 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' },
    });
  });
}
