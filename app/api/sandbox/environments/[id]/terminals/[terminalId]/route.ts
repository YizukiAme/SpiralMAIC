import { withAccessCode } from '@/lib/server/with-access-code';

import { sandboxBody, sandboxRoute } from '@/lib/server/sandbox/http';

export const runtime = 'nodejs';
export const GET = withAccessCode(GETHandler);
export const POST = withAccessCode(POSTHandler);
export const DELETE = withAccessCode(DELETEHandler);
type Context = { params: Promise<{ id: string; terminalId: string }> };

function GETHandler(request: Request, context: Context) {
  return sandboxRoute(request, async (service) => {
    const { id, terminalId } = await context.params;
    return service.terminal(id, terminalId);
  });
}

function POSTHandler(request: Request, context: Context) {
  return sandboxRoute(request, async (service) => {
    const { id, terminalId } = await context.params;
    return service.updateTerminal(id, terminalId, await sandboxBody(request, 128 * 1024));
  });
}

function DELETEHandler(request: Request, context: Context) {
  return sandboxRoute(request, async (service) => {
    const { id, terminalId } = await context.params;
    return service.closeTerminal(id, terminalId);
  });
}
