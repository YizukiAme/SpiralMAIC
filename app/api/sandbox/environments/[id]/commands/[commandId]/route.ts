import { withAccessCode } from '@/lib/server/with-access-code';

import { sandboxRoute } from '@/lib/server/sandbox/http';

export const runtime = 'nodejs';
export const GET = withAccessCode(GETHandler);
export const DELETE = withAccessCode(DELETEHandler);
type Context = { params: Promise<{ id: string; commandId: string }> };

function GETHandler(request: Request, context: Context) {
  return sandboxRoute(request, async (service) => {
    const { id, commandId } = await context.params;
    return service.command(id, commandId);
  });
}

function DELETEHandler(request: Request, context: Context) {
  return sandboxRoute(request, async (service) => {
    const { id, commandId } = await context.params;
    return service.cancelCommand(id, commandId);
  });
}
