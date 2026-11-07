import { withAccessCode } from '@/lib/server/with-access-code';

import { sandboxBody, sandboxRoute } from '@/lib/server/sandbox/http';
import { sandboxInvalid } from '@/lib/sandbox/errors';
export const runtime = 'nodejs';
export const POST = withAccessCode(POSTHandler);
export const DELETE = withAccessCode(DELETEHandler);
type Context = { params: Promise<{ id: string }> };
function POSTHandler(request: Request, context: Context) {
  return sandboxRoute(request, async (service) => {
    const body = await sandboxBody(request);
    return service.grantSession(
      (await context.params).id,
      body.sessionId,
      body.allowWrites,
      body.allowCommands,
    );
  });
}
function DELETEHandler(request: Request, context: Context) {
  return sandboxRoute(request, async (service) => {
    await service.get((await context.params).id);
    const body = await sandboxBody(request);
    if (typeof body.sessionId !== 'string') throw sandboxInvalid('Session ID is required.');
    return service.revokeSession(body.sessionId);
  });
}
