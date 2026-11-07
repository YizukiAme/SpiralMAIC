import { withAccessCode } from '@/lib/server/with-access-code';

import { sandboxBody, sandboxRoute } from '@/lib/server/sandbox/http';

export const runtime = 'nodejs';
export const GET = withAccessCode(GETHandler);
export const POST = withAccessCode(POSTHandler);
type Context = { params: Promise<{ id: string }> };

function GETHandler(request: Request, context: Context) {
  return sandboxRoute(request, async (service) => service.listTerminals((await context.params).id));
}

function POSTHandler(request: Request, context: Context) {
  return sandboxRoute(request, async (service) =>
    service.createTerminal((await context.params).id, await sandboxBody(request)),
  );
}
